/**
 * The Leader/Follower graph (R-03, R-04, C-02).
 *
 * Two nodes, one conditional edge. The loop, the supersteps, the checkpointing
 * and the routing all come from LangGraph — nothing here re-implements them.
 *
 * - `leader` plans or re-plans, picks the current subgoal, emits `leader.plan`.
 * - `follower` observes per the user's `observe` mode (R-08), executes exactly
 *   ONE tool call, and classifies its own control signal from a field on that
 *   same tool call — one model round trip, no second classification call (R-03).
 * - `route` is deterministic: re-plan when `stepsSinceReplan >= planningInterval`
 *   or on `SUBGOAL_COMPLETE` / `RETURN_TO_LEADER`; end on `BLOCKED`, on `done`,
 *   or when `stepCount >= maxSteps` (R-04's safety valve).
 *
 * Every role change emits `handoff`; every tool call emits `tool.call` then
 * `tool.result` (R-06); every Follower action emits `step` (R-07).
 *
 * Imports come from `@langchain/langgraph/web` only. No `createReactAgent`, no
 * `interrupt()`, none of the APIs deprecated in 1.4.13 (C-03).
 */
import {
  END,
  START,
  StateGraph,
  type ConditionalEdgeRouter,
  type GraphNode,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph/web';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ContentBlock,
} from '@langchain/core/messages';
import type { FollowerSignal, Role, RunEvent } from '@/src/messaging/contract';
import { AgentContextSchema, AgentState, type AgentContext, type RunStatus } from './state';
import { FollowerSignalSchema, LEADER_READ_CAP, READ_TOOL_NAMES, TERMINAL_TOOLS, createLeaderReadTools, planTool, summarize, toolResultText } from './tools';

/**
 * How many past Follower turns (a human observation plus the model's reply) are
 * resent with each step.
 *
 * Every turn carries a full page observation, and on a 60-listing eBay page that
 * is ~17k tokens before any tool result. Unbounded, the history reached 285,351
 * tokens against a 262,144-token model and the run died with a 400. Older
 * observations are stale snapshots of a page that has since changed, so they are
 * not merely expensive, they are wrong to resend.
 */
export const FOLLOWER_HISTORY_TURNS = 3;

/**
 * Keeps the most recent turns of Follower history.
 *
 * Trims by message rather than by token because the reducer stores whole
 * messages and a turn is always one human plus one AI message.
 */
export function trimFollowerHistory(
  messages: BaseMessage[],
  turns: number = FOLLOWER_HISTORY_TURNS,
): BaseMessage[] {
  const keep = Math.max(turns, 1) * 2;
  return messages.length <= keep ? messages : messages.slice(-keep);
}

/** Consecutive tool-call-less Follower turns before a run is called stalled. */
export const MAX_IDLE_FOLLOWER_TURNS = 4;

/** Identical failures of the same action before the run is called stuck. */
export const MAX_REPEAT_FAILURE_TURNS = 2;

/**
 * Identity of one failed attempt: the tool name, its visible arguments with stable
 * key order (the `signal`/`note` envelope is already stripped by the caller, so two
 * attempts that differ only in their control note still match), and the error with
 * digits normalized (durations and counts vary between identical failures).
 * Capped so a `save_file` with a huge payload cannot bloat checkpointed state.
 */
export function actionKey(name: string, args: Record<string, unknown>, error: string): string {
  const sorted = Object.fromEntries(
    Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  let json: string;
  try {
    json = JSON.stringify(sorted) ?? '';
  } catch {
    json = String(sorted);
  }
  if (json.length > 500) json = `${json.slice(0, 500)}…len=${json.length}`;
  return `${name}\n${json}\n${error.replace(/\d+/g, '#').slice(0, 200)}`;
}

export const LEADER_SYSTEM = [
  'You are the Leader of a two-role browser agent. You do not touch the page.',
  'You decompose the objective into a short ordered list of concrete subgoals and hand one at a time to the Follower.',
  'You are called again whenever the Follower finishes a subgoal, gets stuck, or after a fixed number of its steps.',
  'When called again, revise the plan against what actually happened. Keep what worked. Do not repeat a subgoal that is already done.',
  'Before re-planning you may pull evidence with leader_snapshot, leader_screenshot or leader_extract_text ' +
    '(at most 2 reads per turn) to check what actually happened.',
  'Pulling evidence is not acting: reads never change the page, and the Follower remains the only role that acts.',
  'The Follower can read long lists as plain text, write and run a script against the page, and save a file; it will call blocked rather than sign in anywhere, so never plan a subgoal that requires logging in.',
  'Always answer by calling set_plan exactly once. Never write prose instead.',
].join(' ');

export const FOLLOWER_SYSTEM = [
  'You control a web browser to accomplish one subgoal at a time.',
  'Each turn you call exactly ONE tool. Never more than one.',
  'Element refs like "e12" come from the page snapshot you are shown. Never invent a ref.',
  'For a long list or article, prefer extract_text over reading it out of the snapshot.',
  'A run_userscript result can be saved with save_file(fromLastUserscript:true) instead of retyping it; saved files land in the user\'s Downloads/nanobrowser folder.',
  'When a page holds more data than you can reach by clicking, write_userscript a small reader for it, run_userscript it, and fix it from the error and console lines you get back.',
  'If you land on a sign-in or login page, call blocked; never enter credentials.',
  'On every tool call also set "signal": CONTINUE while you are still working on the subgoal,',
  'SUBGOAL_COMPLETE the moment the subgoal is achieved, RETURN_TO_LEADER if the plan no longer fits',
  'what you see, BLOCKED if you truly cannot proceed. Add a short "note" saying why.',
  'Call done only when the whole objective is achieved. Call blocked only when nothing else can work.',
].join(' ');

type Emitter = LangGraphRunnableConfig<AgentContext>;

function emit(config: Emitter, event: RunEvent): void {
  config.writer?.(event);
}

function now(): number {
  return Date.now();
}

function requireContext(config: Emitter): AgentContext {
  const ctx = config.context;
  if (!ctx) throw new Error('agent graph invoked without a run context');
  return ctx;
}

function textOf(message: AIMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'string' ? part : part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function parseSignal(value: unknown): FollowerSignal | undefined {
  const parsed = FollowerSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/* ------------------------------------------------------------------------- */
/* Routing                                                                    */
/* ------------------------------------------------------------------------- */

export type RouteTarget = 'leader' | 'follower' | typeof END;

export interface RouteDecision {
  to: RouteTarget;
  /** Human-readable cause, carried verbatim on the `handoff` event (R-07). */
  reason: string;
}

export interface RouteInputs {
  status: RunStatus;
  lastSignal: FollowerSignal | null;
  stepCount: number;
  stepsSinceReplan: number;
}

/**
 * The single source of truth for what happens after a Follower step.
 *
 * The Follower node calls it to name the handoff; the conditional edge calls it
 * to pick the node. Both see the same post-update state, so the emitted log and
 * the actual control flow cannot disagree.
 */
export function decideNext(
  s: RouteInputs,
  ctx: Pick<AgentContext, 'planningInterval' | 'maxSteps'>,
): RouteDecision {
  if (s.status === 'done') return { to: END, reason: 'objective complete' };
  if (s.status === 'error') return { to: END, reason: 'run failed' };
  if (s.status === 'blocked' || s.lastSignal === 'BLOCKED') {
    return { to: END, reason: 'follower is blocked' };
  }
  if (s.stepCount >= ctx.maxSteps) {
    return { to: END, reason: `step budget of ${ctx.maxSteps} reached` };
  }
  if (s.lastSignal === 'SUBGOAL_COMPLETE') return { to: 'leader', reason: 'subgoal complete' };
  if (s.lastSignal === 'RETURN_TO_LEADER') {
    return { to: 'leader', reason: 'follower returned control' };
  }
  if (s.stepsSinceReplan >= ctx.planningInterval) {
    return { to: 'leader', reason: `planning interval of ${ctx.planningInterval} steps reached` };
  }
  return { to: 'follower', reason: 'continue on the current subgoal' };
}

const route: ConditionalEdgeRouter<typeof AgentState, AgentContext, 'leader' | 'follower'> = (
  state,
  config,
) => {
  const ctx = requireContext(config);
  return decideNext(state, ctx).to;
};

/* ------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* ------------------------------------------------------------------------- */

const leader: GraphNode<typeof AgentState, AgentContext> = async (state, config) => {
  const ctx = requireContext(config);
  const replan = state.stepCount > 0;

  emit(config, { kind: 'step', n: state.stepCount, role: 'leader', at: now() });

  const situation = replan
    ? [
        `Objective: ${ctx.objective}`,
        `Steps used: ${state.stepCount} of ${ctx.maxSteps}.`,
        `Previous plan: ${state.plan || '(none)'}`,
        `Subgoals: ${state.subgoals.map((s, i) => `${i}. ${s}`).join(' | ') || '(none)'}`,
        `The follower was working on subgoal ${state.currentSubgoal} and signalled ${state.lastSignal ?? 'CONTINUE'}.`,
        'Revise the plan and pick the subgoal to work on next. Call set_plan.',
      ].join('\n')
    : [
        `Objective: ${ctx.objective}`,
        `The follower gets ${ctx.planningInterval} steps before you are consulted again, and ${ctx.maxSteps} steps in total.`,
        'Write the plan and its subgoals. Call set_plan.',
      ].join('\n');

  const human = new HumanMessage(situation);
  // The Leader's read-only observation subset (M4): evidence pulls, not actions.
  // Built from the same page port the Follower drives, bound next to set_plan.
  const leaderReads = createLeaderReadTools(ctx.page);
  const readByName = new Map(leaderReads.map((t) => [t.name, t]));
  const bound = ctx.leaderModel.bindTools?.([...leaderReads, planTool]) ?? ctx.leaderModel;

  const messages: BaseMessage[] = [human];
  let plan = state.plan;
  let subgoals = state.subgoals;
  let currentSubgoal = state.currentSubgoal;
  let readsUsed = 0;
  let planned = false;
  let lastText = '';

  // Pull evidence, then plan. Each lap is one model round trip; the loop is
  // bounded (reads plus room for the plan and one refusal) so a model that
  // only ever reads still ends its turn instead of becoming a second Follower.
  for (let lap = 0; lap < LEADER_READ_CAP + 2 && !planned; lap++) {
    const response = (await bound.invoke(
      [new SystemMessage(LEADER_SYSTEM), ...state.leaderMessages, ...messages],
      config,
    )) as AIMessage;
    messages.push(response);

    const text = textOf(response);
    if (text) {
      lastText = text;
      emit(config, { kind: 'model.text', role: 'leader', text, at: now() });
    }

    const call = (response.tool_calls ?? [])[0];
    if (!call) break;
    const callId = call.id ?? `leader-${state.stepCount}-${lap}`;

    if (call.name === planTool.name) {
      emit(config, {
        kind: 'tool.call',
        role: 'leader',
        call: { callId, name: call.name, args: call.args },
        at: now(),
      });
      const started = now();
      let ok = true;
      let result: string;
      const args = call.args as { plan: string; subgoals: string[]; currentSubgoal?: number };
      try {
        result = toolResultText(await planTool.invoke(args, config));
        plan = args.plan ?? plan;
        subgoals = Array.isArray(args.subgoals) && args.subgoals.length ? args.subgoals : subgoals;
        const picked = typeof args.currentSubgoal === 'number' ? args.currentSubgoal : 0;
        currentSubgoal = Math.min(Math.max(picked, 0), Math.max(subgoals.length - 1, 0));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
      emit(config, {
        kind: 'tool.result',
        role: 'leader',
        result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
        at: now(),
      });
      messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
      planned = true;
    } else if (readByName.has(call.name)) {
      emit(config, {
        kind: 'tool.call',
        role: 'leader',
        call: { callId, name: call.name, args: call.args },
        at: now(),
      });
      const started = now();
      if (readsUsed >= LEADER_READ_CAP) {
        // The cap is per replan: this turn's evidence budget is spent, and the
        // refusal says what to do instead so a weak model can still finish.
        const refusal =
          `observation budget spent: at most ${LEADER_READ_CAP} reads per turn. ` +
          'Call set_plan with your best plan now.';
        emit(config, {
          kind: 'tool.result',
          role: 'leader',
          result: { callId, name: call.name, ok: false, summary: refusal, durationMs: now() - started },
          at: now(),
        });
        messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: refusal }));
        continue;
      }
      readsUsed += 1;
      if (call.name === 'leader_screenshot') {
        // Pixels cannot ride in a ToolMessage (capped text), so the screenshot
        // arrives as an observation block like the Follower's — fetched once,
        // logged as text, seen as an image.
        try {
          const shot = await ctx.page.screenshot();
          const summary = `screenshot ${shot.width}x${shot.height}`;
          emit(config, {
            kind: 'tool.result',
            role: 'leader',
            result: { callId, name: call.name, ok: true, summary, durationMs: now() - started },
            at: now(),
          });
          messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: summary }));
          messages.push(
            new HumanMessage({
              content: [
                { type: 'text', text: `Leader screenshot of the visible page, ${shot.width} by ${shot.height} pixels.` },
                { type: 'image', url: shot.dataUrl, mimeType: 'image/png' },
              ],
            }),
          );
        } catch (error) {
          const result = toolResultText(error instanceof Error ? error.message : String(error));
          emit(config, {
            kind: 'tool.result',
            role: 'leader',
            result: { callId, name: call.name, ok: false, summary: summarize(result), durationMs: now() - started },
            at: now(),
          });
          messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
        }
        continue;
      }
      let ok = true;
      let result: string;
      try {
        result = toolResultText(await readByName.get(call.name)!.invoke(call.args, config));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
      emit(config, {
        kind: 'tool.result',
        role: 'leader',
        result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
        at: now(),
      });
      messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
    } else {
      // Not the plan and not a read (a Follower tool name, say): leave it for
      // the prose fallback below rather than executing another role's action.
      break;
    }
  }

  if (!planned) {
    // Small models sometimes answer in prose. Take the text as the plan rather
    // than stalling the run.
    plan = lastText || plan;
    if (!subgoals.length) subgoals = [plan || ctx.objective];
    currentSubgoal = Math.min(currentSubgoal, Math.max(subgoals.length - 1, 0));
  }

  emit(config, { kind: 'leader.plan', plan, subgoals, replan, at: now() });
  emit(config, {
    kind: 'handoff',
    from: 'leader',
    to: 'follower',
    reason: replan
      ? `re-planned; follower resumes on subgoal ${currentSubgoal}`
      : `plan set; follower starts on subgoal ${currentSubgoal}`,
    at: now(),
  });

  return {
    leaderMessages: messages,
    plan,
    subgoals,
    currentSubgoal,
    stepsSinceReplan: 0,
    status: 'running',
  };
};

const follower: GraphNode<typeof AgentState, AgentContext> = async (state, config) => {
  const ctx = requireContext(config);
  const stepN = state.stepCount + 1;
  const role: Role = 'follower';

  emit(config, { kind: 'step', n: stepN, role, at: now() });

  // --- observe (R-08) -----------------------------------------------------
  const subgoal = state.subgoals[state.currentSubgoal] ?? state.plan ?? ctx.objective;
  const scriptLine = ctx.availableUserscripts.length
    ? `Userscripts available here (run_userscript ids): ${ctx.availableUserscripts.map((s) => `${s.id} (${s.name})`).join(', ')}.`
    : 'No userscript is registered for this page. Write one with write_userscript if reading this page by hand would take many steps.';
  const blocks: ContentBlock[] = [
    {
      type: 'text',
      text: [
        `Objective: ${ctx.objective}`,
        `Current subgoal: ${subgoal}`,
        `Step ${stepN} of at most ${ctx.maxSteps}.`,
        ...(ctx.readOnly
          ? [
              'Read-only mode is on: act tools (click, hover, type, press, select, download, ' +
                'write_userscript) are unavailable. Read, navigate, run read-only userscripts, and save — ' +
                'or call blocked naming the unavailable action.',
            ]
          : []),
        scriptLine,
      ].join('\n'),
    },
  ];

  let tokens: number | undefined;
  let hasScreenshot = false;

  if (ctx.observe === 'dom' || ctx.observe === 'both') {
    const snap = await ctx.page.snapshot();
    tokens = snap.tokens;
    blocks.push({ type: 'text', text: `Page snapshot:\n${snap.text}` });
  }
  if (ctx.observe === 'pixels' || ctx.observe === 'both') {
    const shot = await ctx.page.screenshot();
    hasScreenshot = true;
    blocks.push({
      type: 'text',
      text: `Screenshot of the visible page, ${shot.width} by ${shot.height} pixels.`,
    });
    // Standard multimodal block. `image_url` / `MessageContentComplex` are
    // deprecated in @langchain/core 1.2.9 (C-03).
    blocks.push({ type: 'image', url: shot.dataUrl, mimeType: 'image/png' });
  }

  emit(config, { kind: 'observation', mode: ctx.observe, tokens, hasScreenshot, at: now() });

  // --- act ----------------------------------------------------------------
  const human = new HumanMessage({ content: blocks });
  const bound = ctx.followerModel.bindTools?.(ctx.toolset.all) ?? ctx.followerModel;
  const response = (await bound.invoke(
    [new SystemMessage(FOLLOWER_SYSTEM), ...trimFollowerHistory(state.followerMessages), human],
    config,
  )) as AIMessage;

  const text = textOf(response);
  if (text) emit(config, { kind: 'model.text', role, text, at: now() });

  const messages: BaseMessage[] = [human, response];
  const call = (response.tool_calls ?? [])[0];

  let signal: FollowerSignal = 'CONTINUE';
  let note = '';
  let status: RunStatus = 'running';
  let repeatFailureKey: string | null = state.repeatFailureKey;
  let repeatFailureTurns = state.repeatFailureTurns;
  let failureText = '';

  if (!call) {
    // No action taken. Hand control back rather than burning steps.
    // Prose turns deliberately leave the repeat-failure tracker alone: answering in
    // prose between two identical failures does not make the retry any less futile.
    signal = 'RETURN_TO_LEADER';
    note = 'the follower produced no tool call';
  } else {
    const callId = call.id ?? `follower-${stepN}`;
    const rawArgs = (call.args ?? {}) as Record<string, unknown>;
    const { signal: declared, note: declaredNote, ...visibleArgs } = rawArgs;

    emit(config, {
      kind: 'tool.call',
      role,
      call: { callId, name: call.name, args: visibleArgs },
      at: now(),
    });

    const started = now();
    let ok = true;
    let result: string;
    const tool = ctx.toolset.byName.get(call.name);
    if (!tool) {
      ok = false;
      result = `no such tool: ${call.name}`;
    } else {
      try {
        result = toolResultText(await tool.invoke(rawArgs, config));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
    }

    emit(config, {
      kind: 'tool.result',
      role,
      result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
      at: now(),
    });
    messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));

    note = typeof declaredNote === 'string' ? declaredNote : '';
    const terminal = TERMINAL_TOOLS[call.name];
    if (terminal === 'done' && ok) {
      signal = 'SUBGOAL_COMPLETE';
      status = 'done';
      if (!note) note = 'objective reported complete';
    } else if (terminal === 'blocked') {
      signal = 'BLOCKED';
      if (!note) note = 'follower reported it is blocked';
    } else if (!ok) {
      signal = parseSignal(declared) ?? 'CONTINUE';
      if (!note) note = 'tool call failed';
      // Repeat-failure stall detection (M2): the same action failing identically with
      // no successful page-changing action between attempts is a futile loop. Terminal
      // tools already ended the run above, so reaching here means the run continues.
      if (status === 'running') {
        failureText = result;
        const key = actionKey(call.name, visibleArgs, result);
        if (key === repeatFailureKey) repeatFailureTurns += 1;
        else {
          repeatFailureKey = key;
          repeatFailureTurns = 1;
        }
      }
    } else {
      signal = parseSignal(declared) ?? 'CONTINUE';
      // A successful read is not progress against a failing action: the page did not
      // change. Any other success clears the repeat chain (a retry after real progress
      // is recovery, not a loop).
      if (!READ_TOOL_NAMES.has(call.name)) {
        repeatFailureKey = null;
        repeatFailureTurns = 0;
      }
    }
  }

  if (status === 'running' && signal === 'BLOCKED') status = 'blocked';

  // A Follower that answers in prose never touches the page, so the Leader replans
  // and the same nothing happens again. Live: the free Nemotron pair spent 18 steps
  // in that loop. Stop while the reason is still legible instead of at maxSteps.
  const idleFollowerTurns = call ? 0 : state.idleFollowerTurns + 1;
  if (status === 'running' && idleFollowerTurns >= MAX_IDLE_FOLLOWER_TURNS) {
    status = 'error';
    note =
      `the follower returned no tool call ${idleFollowerTurns} turns running; ` +
      'it is answering in prose instead of acting. Try a model that reliably calls tools.';
  }

  if (status === 'running' && repeatFailureTurns >= MAX_REPEAT_FAILURE_TURNS) {
    status = 'error';
    note =
      `the follower repeated the same failing action ${repeatFailureTurns} times` +
      `${call ? ` (${call.name})` : ''}: ${summarize(failureText, 160)} No successful action happened ` +
      'between attempts. Try a different tool or subgoal, or call blocked.';
  }

  if (status === 'running' && stepN >= ctx.maxSteps) status = 'max-steps';

  emit(config, { kind: 'follower.signal', signal, note, at: now() });

  const stepsSinceReplan = state.stepsSinceReplan + 1;
  const decision = decideNext({ status, lastSignal: signal, stepCount: stepN, stepsSinceReplan }, ctx);
  if (decision.to === 'leader') {
    emit(config, {
      kind: 'handoff',
      from: 'follower',
      to: 'leader',
      reason: decision.reason,
      signal,
      at: now(),
    });
  }

  return {
    followerMessages: messages,
    stepCount: stepN,
    stepsSinceReplan,
    idleFollowerTurns,
    repeatFailureKey,
    repeatFailureTurns,
    lastSignal: signal,
    status,
  };
};

/* ------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------- */

export function buildAgentGraph(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph(AgentState, { context: AgentContextSchema })
    .addNode('leader', leader)
    .addNode('follower', follower)
    .addEdge(START, 'leader')
    .addEdge('leader', 'follower')
    .addConditionalEdges('follower', route, ['leader', 'follower', END])
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
