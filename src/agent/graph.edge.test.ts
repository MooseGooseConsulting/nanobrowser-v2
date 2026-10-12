/**
 * Gaps the review found in `graph.test.ts`:
 *
 * 1. `decideNext` -- "the single source of truth for what happens after a
 *    Follower step" -- is a pure, exported function, but was only ever
 *    exercised incidentally through full-graph `FakeChatModel` runs. This
 *    file unit-tests its priority order directly, including the tie cases
 *    (e.g. maxSteps reached *and* SUBGOAL_COMPLETE signalled together) that a
 *    full-graph harness cannot cleanly force.
 * 2. The follower node's `!tool` branch (an unknown tool name from the model)
 *    was never hit by any scripted turn.
 * 3. The leader node's `currentSubgoal` clamp and its `planTool.invoke`
 *    failure branch were never exercised.
 * 4. Issue #8: a tool call resetting the idle counter, and a schema-valid
 *    Follower call that fails at the page layer.
 */
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config } from '@/src/storage';
import {
  actionKey,
  compactObservations,
  decideNext,
  followerFeedback,
  trimFollowerHistory,
  FOLLOWER_HISTORY_TURNS,
  FOLLOWER_SYSTEM,
  LEADER_SYSTEM,
  MAX_IDLE_FOLLOWER_TURNS,
  promptChars,
  unchangedPageNote,
  type RouteInputs,
} from './graph';
import { FakePageTools } from './tools';
import { FakeChatModel, type FakeCall, type FakeChatModelInit, type FakeTurn } from './models';
import { startRun, type RunEndedEvent } from './run';

const baseConfig: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

const baseInputs: RouteInputs = { status: 'running', lastSignal: null, stepCount: 0, stepsSinceReplan: 0 };
const ctx = { planningInterval: 3, maxSteps: 10 };

describe('decideNext: priority order, tested directly as a pure function', () => {
  it('done always ends the run, regardless of anything else', () => {
    expect(decideNext({ ...baseInputs, status: 'done', stepCount: 999 }, ctx).to).toBe('__end__');
  });

  it('error always ends the run', () => {
    expect(decideNext({ ...baseInputs, status: 'error' }, ctx).to).toBe('__end__');
  });

  it('BLOCKED ends the run even if status is still "running"', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'BLOCKED' }, ctx).to).toBe('__end__');
  });

  it('status "blocked" ends the run even with no BLOCKED signal', () => {
    expect(decideNext({ ...baseInputs, status: 'blocked' }, ctx).to).toBe('__end__');
  });

  it('maxSteps reached ends the run even when the signal alone would have gone to the leader', () => {
    // Tie case: SUBGOAL_COMPLETE would normally hand off to the leader, but the
    // step budget takes priority once it is reached.
    const decision = decideNext({ ...baseInputs, lastSignal: 'SUBGOAL_COMPLETE', stepCount: 10 }, ctx);
    expect(decision.to).toBe('__end__');
    expect(decision.reason).toContain('step budget');
  });

  it('SUBGOAL_COMPLETE routes to the leader when the step budget is not yet reached', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'SUBGOAL_COMPLETE', stepCount: 1 }, ctx).to).toBe('leader');
  });

  it('RETURN_TO_LEADER routes to the leader', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'RETURN_TO_LEADER', stepCount: 1 }, ctx).to).toBe('leader');
  });

  it('the planning interval routes to the leader once reached, with no signal at all', () => {
    expect(decideNext({ ...baseInputs, stepsSinceReplan: 3 }, ctx).to).toBe('leader');
    expect(decideNext({ ...baseInputs, stepsSinceReplan: 2 }, ctx).to).toBe('follower');
  });

  it('CONTINUE (or no signal) stays on the follower when nothing else fires', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'CONTINUE' }, ctx).to).toBe('follower');
    expect(decideNext(baseInputs, ctx).to).toBe('follower');
  });

  it('maxSteps=0 ends the run immediately on the very first check', () => {
    expect(decideNext({ ...baseInputs, stepCount: 0 }, { planningInterval: 3, maxSteps: 0 }).to).toBe('__end__');
  });
});

const subgoals = ['open the page', 'read the page'];

function harness(options: {
  follower: (call: FakeCall) => FakeTurn;
  leaderRespond?: (call: FakeCall) => FakeTurn;
  page?: FakePageTools;
  planningInterval?: number;
  leaderUsage?: FakeChatModelInit['usage'];
  followerUsage?: FakeChatModelInit['usage'];
  observe?: Config['observe'];
}): Promise<{ events: RunEvent[]; ended: RunEndedEvent; follower: FakeChatModel; leader: FakeChatModel }> {
  const events: RunEvent[] = [];
  const page = options.page ?? new FakePageTools();
  const leader = new FakeChatModel({
    label: 'leader',
    respond:
      options.leaderRespond ??
      (() => ({ kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals, currentSubgoal: 0 } })),
    usage: options.leaderUsage,
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower, usage: options.followerUsage });

  const handle = startRun({
    prompt: 'find the widget',
    config: {
      ...baseConfig,
      planningInterval: options.planningInterval ?? baseConfig.planningInterval,
      observe: options.observe ?? baseConfig.observe,
    },
    tools: page,
    models: { leader, follower },
    onEvent: (event) => events.push(event),
    checkpointer: new MemorySaver(),
    runId: `test-${Math.random().toString(36).slice(2)}`,
  });

  return handle.done.then((ended) => ({ events, ended, follower, leader }));
}

function pick<K extends RunEvent['kind']>(events: RunEvent[], kind: K): Extract<RunEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);
}

/** Every text block in a call's prompt, in order. */
function textBlocks(call: FakeCall): string[] {
  return call.messages.flatMap((message) =>
    typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap((block) => (block.type === 'text' ? [String(block.text)] : [])),
  );
}

describe('follower node: an unrecognised tool name from the model', () => {
  it('reports a failed tool.result rather than crashing the run', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'tool', name: 'not_a_real_tool', args: { signal: 'BLOCKED' } }),
    });

    const results = pick(events, 'tool.result').filter((r) => r.role === 'follower');
    expect(results).toHaveLength(1);
    expect(results[0]?.result.ok).toBe(false);
    expect(results[0]?.result.summary).toContain('no such tool');
    // The run must still end cleanly (BLOCKED signal), not hang or throw.
    expect(ended.status).toBe('blocked');
  });
});

describe('leader node: currentSubgoal clamp and a failing planTool.invoke', () => {
  it('clamps an out-of-range currentSubgoal into the actual subgoal list', async () => {
    const { events } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok', signal: 'SUBGOAL_COMPLETE' } }),
      leaderRespond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'do it', subgoals: ['only-one'], currentSubgoal: 99 },
      }),
    });

    const plans = pick(events, 'leader.plan');
    expect(plans[0]?.subgoals).toEqual(['only-one']);
    const handoff = pick(events, 'handoff').find((h) => h.from === 'leader');
    expect(handoff?.reason).toContain('subgoal 0'); // clamped to the only valid index
  });

  it('clamps a negative currentSubgoal to 0', async () => {
    const { events } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok', signal: 'SUBGOAL_COMPLETE' } }),
      leaderRespond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'do it', subgoals: ['a', 'b'], currentSubgoal: -5 },
      }),
    });

    const handoff = pick(events, 'handoff').find((h) => h.from === 'leader');
    expect(handoff?.reason).toContain('subgoal 0');
  });

  it('reports a failed leader tool.result when planTool.invoke rejects the args, without crashing the run', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok' } }),
      // subgoals: [] violates planTool's schema (.min(1)) so planTool.invoke throws.
      leaderRespond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals: [] } }),
    });

    const leaderResults = pick(events, 'tool.result').filter((r) => r.role === 'leader');
    expect(leaderResults).toHaveLength(1);
    expect(leaderResults[0]?.result.ok).toBe(false);
    // The run still proceeds to the follower and completes rather than hanging.
    expect(ended.status).toBe('done');
  });
});

describe('a follower that never calls a tool', () => {
  // Regression: the free Nemotron pair answered in prose every turn, so the Leader
  // replanned and nothing happened, 18 steps deep, until the step budget ran out.
  it('stops the run and names the cause instead of burning every step', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'text', text: 'I think I should look at the page.' }),
    });

    expect(ended.status).toBe('error');
    expect(ended.steps).toBeLessThan(10);
    const signals = pick(events, 'follower.signal');
    expect(signals.at(-1)?.note).toContain('no tool call');
    expect(signals.at(-1)?.note).toContain('reliably calls tools');
    // The terminal event carries the same diagnosis, not the generic mapping.
    expect(ended.message).toContain('no tool call');
  });

  // Idle runs of MAX-1 prose turns either side of one click. A counter that
  // accumulated instead of resetting would reach MAX on the first prose turn
  // after the click.
  const idleThenClickThenIdle = (idleAfter: number) => (call: FakeCall): FakeTurn => {
    const before = MAX_IDLE_FOLLOWER_TURNS - 1;
    if (call.index < before) return { kind: 'text', text: 'let me think about it' };
    if (call.index === before) return { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } };
    if (call.index <= before + idleAfter) return { kind: 'text', text: 'thinking again' };
    return { kind: 'tool', name: 'done', args: { summary: 'found it' } };
  };

  it('resets the idle counter on a tool call instead of accumulating across it', async () => {
    const { events, ended } = await harness({
      follower: idleThenClickThenIdle(MAX_IDLE_FOLLOWER_TURNS - 1),
    });

    expect(ended.status).toBe('done');
    expect(ended.steps).toBe(2 * MAX_IDLE_FOLLOWER_TURNS);
    const notes = pick(events, 'follower.signal').map((s) => s.note);
    expect(notes.some((n) => n.includes('turns running'))).toBe(false);
  });

  it('still trips after a reset, counting only the idle turns since the tool call', async () => {
    const { events, ended } = await harness({
      follower: idleThenClickThenIdle(MAX_IDLE_FOLLOWER_TURNS),
    });

    expect(ended.status).toBe('error');
    expect(ended.steps).toBe(2 * MAX_IDLE_FOLLOWER_TURNS);
    expect(pick(events, 'follower.signal').at(-1)?.note).toContain(
      `no tool call ${MAX_IDLE_FOLLOWER_TURNS} turns running`,
    );
  });
});

describe('follower node: a schema-valid tool call that fails at the page layer', () => {
  it('logs a failed tool.result, feeds the error back to the model, and keeps the run going', async () => {
    const page = new FakePageTools();
    page.click = async (ref) => {
      (page.calls as Array<{ name: 'click'; args: unknown[] }>).push({ name: 'click', args: [ref] });
      throw new Error(`stale ref ${ref}: the element is no longer in the page`);
    };

    const { events, ended, follower } = await harness({
      page,
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    // The args passed the schema: the page itself was asked to click.
    expect(page.calls.filter((c) => c.name === 'click')).toEqual([{ name: 'click', args: ['e1'] }]);

    const click = pick(events, 'tool.result').find((r) => r.role === 'follower' && r.result.name === 'click');
    expect(click?.result.ok).toBe(false);
    expect(click?.result.summary).toContain('stale ref e1');
    expect(pick(events, 'follower.signal')[0]).toMatchObject({ signal: 'CONTINUE', note: 'tool call failed' });

    const toolMessages = follower.calls.flatMap(
      (call) => call.messages.filter((m) => m.type === 'tool') as ToolMessage[],
    );
    expect(toolMessages.find((m) => m.name === 'click')?.content).toContain('stale ref e1');

    // One page failure is neither a crash nor a repeat loop.
    expect(ended).toMatchObject({ status: 'done', steps: 2 });
  });
});

describe('follower history is bounded', () => {
  // Regression: every turn carries a full page observation (~17k tokens on a
  // 60-listing eBay page). Unbounded, a live run reached 285,351 tokens against a
  // 262,144-token model and died with a 400 before it could save anything.
  const turn = (i: number): BaseMessage[] => [
    new HumanMessage(`turn ${i}`),
    new AIMessage({ content: '', tool_calls: [{ id: `call-${i}`, name: 'click', args: { ref: 'e1' } }] }),
    new ToolMessage({ tool_call_id: `call-${i}`, name: 'click', content: `clicked in turn ${i}` }),
  ];

  it('keeps only the most recent turns', () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i)).flat();
    const kept = trimFollowerHistory(history);

    expect(kept).toHaveLength(FOLLOWER_HISTORY_TURNS * 3);
    expect(kept.at(-1)).toBe(history.at(-1));
    expect(kept).not.toContain(history[0]);
  });

  it('leaves a short history untouched, so early steps lose nothing', () => {
    const history = [...turn(0), ...turn(1)];
    expect(trimFollowerHistory(history)).toEqual(history);
  });

  it('never returns an empty history, whatever it is asked for', () => {
    const history = Array.from({ length: 10 }, (_, i) => turn(i)).flat();
    expect(trimFollowerHistory(history, 0).length).toBeGreaterThan(0);
  });

  it('cuts only at turn boundaries, so no kept tool result loses its assistant call', () => {
    // Turn 1 carries refused extras (one AI message, three tool results); a
    // fixed message-count slice would keep the first refused result while
    // cutting the assistant call it answers, which providers reject.
    const msg = (i: number) => new HumanMessage(`boundary ${i}`);
    const ai = (id: string, calls: string[]) =>
      new AIMessage({
        content: '',
        tool_calls: calls.map((name, i) => ({ id: `${id}-${i}`, name, args: {} })),
      });
    const res = (id: string) => new ToolMessage({ tool_call_id: id, content: 'refused' });
    const turn1: BaseMessage[] = [msg(0), ai('a0', ['snapshot', 'bogus', 'bogus']), res('a0-0'), res('a0-1'), res('a0-2')];
    const turn2: BaseMessage[] = [msg(1), ai('a1', ['click']), res('a1-0')];
    const history = [...turn1, ...turn2];

    const kept = trimFollowerHistory(history, 1);
    expect(kept).toEqual(turn2);
    expect(kept[0]).toBeInstanceOf(HumanMessage);
    expect(kept.filter((m) => m instanceof ToolMessage)).toHaveLength(1);
  });

  // The cases above call trimFollowerHistory directly, so deleting it from the
  // Follower invoke stays green. Five tool calls is the first invoke where an
  // untrimmed transcript would carry every observation. The cadence stays above
  // that so a replan cannot take the fifth call.
  const fiveClicks = (call: FakeCall): FakeTurn =>
    call.index < 4
      ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
      : { kind: 'tool', name: 'done', args: { summary: 'found it' } };

  // Each click changes the page, so every turn really does carry a fresh snapshot
  // and none of them is answered with the unchanged-page note instead.
  const changingPage = () =>
    new FakePageTools({
      snapshots: Array.from({ length: 5 }, (_, i) => ({ text: `page: [e1] link "Example ${i + 1}"`, tokens: 8 })),
    });

  it('sends exactly one page snapshot on the fifth Follower call', async () => {
    const { follower } = await harness({ planningInterval: 6, page: changingPage(), follower: fiveClicks });

    expect(follower.calls).toHaveLength(5);
    const fifth = follower.calls[4]!;
    const observations = fifth.messages.filter((message) => message instanceof HumanMessage);
    expect(observations).toHaveLength(FOLLOWER_HISTORY_TURNS + 1);
    const snapshots = textBlocks(fifth).filter((text) => text.startsWith('Page snapshot:'));
    expect(snapshots).toHaveLength(1);
    // The one that survives is the current page, not a stale copy.
    expect(JSON.stringify(fifth.messages.at(-1)?.content)).toContain('Page snapshot:');
  });

  it("replaces a kept turn's snapshot with a note naming its step", async () => {
    const { follower } = await harness({ planningInterval: 6, page: changingPage(), follower: fiveClicks });

    const notes = textBlocks(follower.calls[4]!).filter((text) => text.includes('omitted: superseded'));
    expect(notes).toEqual([
      '[page snapshot from step 2 omitted: superseded]',
      '[page snapshot from step 3 omitted: superseded]',
      '[page snapshot from step 4 omitted: superseded]',
    ]);
  });

  it('drops screenshots from kept Follower turns as the Leader already does', async () => {
    const { follower } = await harness({ planningInterval: 6, page: changingPage(), observe: 'both', follower: fiveClicks });

    const fifth = follower.calls[4]!;
    const images = fifth.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : [],
    );
    expect(images).toHaveLength(1);
    expect(JSON.stringify(fifth.messages.at(-1)?.content)).toContain('"type":"image"');
    expect(textBlocks(fifth)).toContain('[screenshot from step 4 omitted: superseded]');
  });
});

describe('compactObservations keeps the transcript valid', () => {
  const observation = (step: number, snapshot = true) =>
    new HumanMessage({
      content: [
        { type: 'text', text: `Objective: x\nStep ${step} of at most 10.` },
        ...(snapshot ? [{ type: 'text' as const, text: `Page snapshot:\npage ${step} [ref=e1]` }] : []),
      ],
    });
  const act = (id: string, name: string) =>
    new AIMessage({ content: '', tool_calls: [{ id, name, args: { ref: 'e1' } }] });
  const result = (id: string, name: string, content: string, status?: 'success' | 'error') =>
    new ToolMessage({ tool_call_id: id, name, content, ...(status ? { status } : {}) });

  it('keeps every tool call id and tool result so the transcript stays valid', () => {
    const history: BaseMessage[] = [
      observation(1), act('a', 'snapshot'), result('a', 'snapshot', 'page 1 again [ref=e1]'),
      observation(2), act('b', 'extract_text'), result('b', 'extract_text', 'all the listing text'),
      observation(3), act('c', 'click'), result('c', 'click', 'clicked e1'),
      observation(4),
    ];
    const compacted = compactObservations(history);

    expect(compacted).toHaveLength(history.length);
    expect(compacted.map((m) => m.type)).toEqual(history.map((m) => m.type));
    const ids = (messages: BaseMessage[]) =>
      messages.flatMap((m) =>
        m instanceof AIMessage ? (m.tool_calls ?? []).map((c) => `call:${c.id}`) : m instanceof ToolMessage ? [`result:${m.tool_call_id}`] : [],
      );
    expect(ids(compacted)).toEqual(ids(history));
    // Results that are not page snapshots pass through as the same objects.
    expect(compacted[5]).toBe(history[5]);
    expect(compacted[8]).toBe(history[8]);
    expect(compacted[2]!.content).toBe('[page snapshot from step 1 omitted: superseded]');
    expect(compacted.at(-1)).toBe(history.at(-1));
  });

  it('keeps the newest snapshot tool result, because the model sees a result only on the next call', () => {
    const history: BaseMessage[] = [
      observation(1), act('a', 'snapshot'), result('a', 'snapshot', 'fresh page [ref=e9]'),
      observation(2, false),
    ];
    const compacted = compactObservations(history);
    expect(compacted[2]).toBe(history[2]);
    expect(compacted[0]!.content).toContainEqual({ type: 'text', text: '[page snapshot from step 1 omitted: superseded]' });
  });

  it("keeps a failed snapshot call's error text", () => {
    const history: BaseMessage[] = [
      observation(1), act('a', 'snapshot'), result('a', 'snapshot', 'tab is not scriptable', 'error'),
      observation(2),
    ];
    expect(compactObservations(history)[2]).toBe(history[2]);
  });
});

describe('a refusal keeps its text in later prompts', () => {
  const refusalOf = (messages: BaseMessage[], name: string) =>
    messages.filter((m): m is ToolMessage => m instanceof ToolMessage && m.name === name).map((m) => m.content);

  it('a refused extra snapshot call still reads as a refusal once a fresh snapshot arrives', async () => {
    const page = new FakePageTools({
      snapshots: [
        { text: 'page: [e1] link "One"', tokens: 8 },
        { text: 'page: [e1] link "Two"', tokens: 8 },
      ],
    });
    const { follower } = await harness({
      page,
      follower: (call) =>
        call.index === 0
          ? {
              kind: 'tools',
              calls: [
                { name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } },
                { name: 'snapshot', args: {} },
              ],
            }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });

    // The second call carries a fresh snapshot, so a successful snapshot result
    // before it would be stubbed; the refusal was never a page and must stay.
    expect(textBlocks(follower.calls[1]!).at(-1)).toBe('Page snapshot:\npage: [e1] link "Two"');
    expect(refusalOf(follower.calls[1]!.messages, 'snapshot')).toEqual([
      'only the first tool call per turn is answered; re-issue this call next turn if it still matters.',
    ]);
  });

  it("a later replan still shows the Leader its read-cap refusal rather than a superseded stub", async () => {
    const read = (): FakeTurn => ({ kind: 'tool', name: 'leader_snapshot', args: {} });
    const { leader } = await harness({
      leaderRespond: (call) =>
        call.index < 3 ? read() : { kind: 'tool', name: 'set_plan', args: { plan: 'go', subgoals, currentSubgoal: 0 } },
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'RETURN_TO_LEADER' } }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });

    expect(leader.calls).toHaveLength(5);
    const stored = refusalOf(leader.calls[4]!.messages, 'leader_snapshot');
    expect(stored).toHaveLength(3);
    expect(stored[2]).toContain('observation budget spent: at most 2 reads per turn.');
  });
});

describe('every tool result the model is handed records its size', () => {
  it('records chars on refused extras, read-cap refusals, unknown Leader tools and Leader screenshots', async () => {
    const { events } = await harness({
      observe: 'both',
      leaderRespond: (call) => {
        if (call.index === 0) return { kind: 'tool', name: 'leader_screenshot', args: {} };
        if (call.index === 1) return { kind: 'tool', name: 'leader_snapshot', args: {} };
        if (call.index === 2) return { kind: 'tool', name: 'leader_snapshot', args: {} };
        if (call.index === 3) return { kind: 'tool', name: 'click', args: { ref: 'e1' } };
        return { kind: 'tool', name: 'set_plan', args: { plan: 'go', subgoals, currentSubgoal: 0 } };
      },
      follower: (call) =>
        call.index === 0
          ? {
              kind: 'tools',
              calls: [
                { name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } },
                { name: 'snapshot', args: {} },
              ],
            }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });

    const results = pick(events, 'tool.result');
    const unsized = results.filter((e) => e.result.chars === undefined).map((e) => `${e.role}:${e.result.name}`);
    expect(unsized).toEqual([]);
    const refused = results.find((e) => e.role === 'follower' && e.result.name === 'snapshot');
    expect(refused?.result.chars).toBe(refused?.result.summary.length);
    const shot = results.find((e) => e.result.name === 'leader_screenshot');
    expect(shot?.result.chars).toBe(shot?.result.summary.length);
  });
});

describe('an unchanged page is not resent', () => {
  const A = 'page: [e1] button "Next"';
  const B = 'page: [e1] button "Next" [e2] text "Loaded"';
  const pageOf = (...texts: string[]) => new FakePageTools({ snapshots: texts.map((text) => ({ text, tokens: 8 })) });
  const read = (): FakeTurn => ({ kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } });
  const done = (): FakeTurn => ({ kind: 'tool', name: 'done', args: { summary: 'ok' } });
  const sentText = (call: FakeCall) => textBlocks(call).join('\n');

  it('words the note so the model knows its refs still work and how to see them again', () => {
    expect(unchangedPageNote(3)).toBe(
      'Page unchanged since step 3. Refs from that snapshot still work; call snapshot to see it again.',
    );
  });

  it('says the page is unchanged instead of resending an identical snapshot', async () => {
    const { follower } = await harness({ page: pageOf(A), follower: (call) => (call.index < 2 ? read() : done()) });

    expect(follower.calls).toHaveLength(3);
    expect(sentText(follower.calls[0]!)).toContain(A);
    for (const call of follower.calls.slice(1)) {
      expect(sentText(call)).not.toContain(A);
      expect(textBlocks(call)).toContain(unchangedPageNote(1));
    }
  });

  it('keys on the page text, not on the tool, so an action that changed nothing is unchanged too', async () => {
    const { follower } = await harness({
      page: pageOf(A),
      follower: (call) => (call.index === 0 ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } } : done()),
    });
    expect(textBlocks(follower.calls[1]!)).toContain(unchangedPageNote(1));
  });

  it('sends the full snapshot again as soon as the page text changes', async () => {
    const { follower } = await harness({ page: pageOf(A, A, B), follower: (call) => (call.index < 3 ? read() : done()) });

    expect(follower.calls).toHaveLength(4);
    const [first, second, third, fourth] = follower.calls.map((call) => textBlocks(call).at(-1));
    expect(first).toBe(`Page snapshot:\n${A}`);
    expect(second).toBe(unchangedPageNote(1));
    expect(third).toBe(`Page snapshot:\n${B}`);
    // The comparison moves on to the newest snapshot sent, and so does the step it names.
    expect(fourth).toBe(unchangedPageNote(3));
  });

  it('treats a wait that changed the page as a change', async () => {
    const { follower } = await harness({
      page: pageOf(A, B),
      follower: (call) => (call.index === 0 ? { kind: 'tool', name: 'wait', args: { ms: 10, signal: 'CONTINUE' } } : done()),
    });

    const second = textBlocks(follower.calls[1]!);
    expect(second.at(-1)).toBe(`Page snapshot:\n${B}`);
    expect(second.some((text) => text.startsWith('Page unchanged'))).toBe(false);
  });

  it('a Follower can call snapshot after an unchanged turn and act on the refs', async () => {
    const page = pageOf(A);
    const { events, follower, ended } = await harness({
      page,
      follower: (call) => {
        if (call.index === 0) return read();
        if (call.index === 1) return { kind: 'tool', name: 'snapshot', args: { signal: 'CONTINUE' } };
        if (call.index === 2) return { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } };
        return done();
      },
    });

    expect(textBlocks(follower.calls[1]!)).toContain(unchangedPageNote(1));
    // The click turn is also unchanged, but the snapshot it asked for is in front of it.
    const clickTurn = follower.calls[2]!;
    expect(textBlocks(clickTurn)).toContain(unchangedPageNote(1));
    const shown = clickTurn.messages.find((m): m is ToolMessage => m instanceof ToolMessage && m.name === 'snapshot');
    expect(shown?.content).toBe(A);
    expect(page.calls).toContainEqual({ name: 'click', args: ['e1'] });
    expect(pick(events, 'tool.result').find((e) => e.result.name === 'click')?.result.ok).toBe(true);
    expect(ended.status).toBe('done');
  });

  it('logs unchanged observations in the run log', async () => {
    const { events } = await harness({ page: pageOf(A, A, B), follower: (call) => (call.index < 2 ? read() : done()) });

    const observations = pick(events, 'observation');
    expect(observations.map((e) => e.unchanged ?? false)).toEqual([false, true, false]);
    // The size estimate is still the page's own, so a change in page size stays visible.
    expect(observations[1]?.tokens).toBe(8);
  });
});

describe('every model call records what it cost', () => {
  const usage = (input: number) => ({
    input_tokens: input,
    output_tokens: 20,
    total_tokens: input + 20,
    input_token_details: { cache_read: 100 },
    output_token_details: { reasoning: 5 },
  });
  const usageOf = (events: RunEvent[], role: 'leader' | 'follower') =>
    pick(events, 'model.usage').filter((e) => e.role === role);

  it("records the provider's prompt and completion tokens for every Follower call", async () => {
    const { events, follower } = await harness({
      followerUsage: (call) => usage(1000 + call.index),
      follower: (call) =>
        call.index < 2
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    const logged = usageOf(events, 'follower');
    expect(logged).toHaveLength(follower.calls.length);
    expect(logged.map((e) => e.inputTokens)).toEqual([1000, 1001, 1002]);
    for (const [i, e] of logged.entries()) {
      expect(e).toMatchObject({ outputTokens: 20, reasoningTokens: 5, cachedTokens: 100 });
      expect(e.promptChars).toBe(promptChars(follower.calls[i]!.messages));
      expect(e.model).toBeTruthy();
    }
  });

  it('records token usage for every Leader lap, evidence reads included', async () => {
    const { events, leader } = await harness({
      leaderUsage: (call) => usage(500 + call.index),
      leaderRespond: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_snapshot', args: {} }
          : { kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals, currentSubgoal: 0 } },
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'found it' } }),
    });

    const logged = usageOf(events, 'leader');
    expect(leader.calls).toHaveLength(2);
    expect(logged.map((e) => e.inputTokens)).toEqual([500, 501]);
    // The second lap carries the snapshot the first one read, so it is bigger.
    expect(logged[1]!.promptChars).toBeGreaterThan(logged[0]!.promptChars);
  });

  it("still records the prompt's character count when the provider reports no usage", async () => {
    const { events, follower } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'found it' } }),
    });

    const [logged] = usageOf(events, 'follower');
    expect(logged).toBeDefined();
    expect(logged).not.toHaveProperty('inputTokens');
    expect(logged).not.toHaveProperty('outputTokens');
    expect(logged!.promptChars).toBe(promptChars(follower.calls[0]!.messages));
    expect(logged!.promptChars).toBeGreaterThan(FOLLOWER_SYSTEM.length);
  });

  it('records how many characters each tool result handed the model', async () => {
    const { events } = await harness({
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    const read = pick(events, 'tool.result').find((e) => e.result.name === 'extract_text');
    expect(read?.result.chars).toBe('extracted text'.length);
  });

  it('counts tool-call arguments but not image bytes toward the prompt size', () => {
    const withImage = new HumanMessage({
      content: [
        { type: 'text', text: 'abc' },
        { type: 'image', url: `data:image/png;base64,${'A'.repeat(10_000)}`, mimeType: 'image/png' },
      ],
    });
    const reply = new AIMessage({ content: '', tool_calls: [{ id: 'c', name: 'click', args: { ref: 'e1' } }] });
    expect(promptChars([withImage])).toBe(3);
    expect(promptChars([reply])).toBe('click'.length + JSON.stringify({ ref: 'e1' }).length);
  });
});

describe('actionKey', () => {
  it('matches identical attempts despite key order and varying durations', () => {
    const a = actionKey('click', { ref: 'e1' }, 'stale ref after 12ms');
    const b = actionKey('click', { ref: 'e1' }, 'stale ref after 34ms');
    expect(a).toBe(b);
    expect(actionKey('type', { ref: 'e1', text: 'x' }, 'e')).toBe(
      actionKey('type', { text: 'x', ref: 'e1' }, 'e'),
    );
  });

  it('treats other digit changes as different failures (429 is not 500)', () => {
    expect(actionKey('snapshot', {}, 'request failed with status code 429')).not.toBe(
      actionKey('snapshot', {}, 'request failed with status code 500'),
    );
  });

  it('distinguishes errors that share a long prefix but differ after it', () => {
    const prefix = `console output:\n${'x'.repeat(300)}\n`;
    const a = actionKey('run_userscript', { scriptId: 's' }, `${prefix}TypeError: undefined is not an object`);
    const b = actionKey('run_userscript', { scriptId: 's' }, `${prefix}ReferenceError: foo is not defined`);
    expect(a).not.toBe(b);
  });

  it('distinguishes large payloads that share a prefix and length', () => {
    const a = actionKey('save_file', { body: `${'x'.repeat(600)}a` }, 'denied');
    const b = actionKey('save_file', { body: `${'x'.repeat(600)}b` }, 'denied');
    expect(a).not.toBe(b);
  });
});

// Reuse the existing fake-model run harness: these exercise the production
// graph, but do not pretend a scripted model proves real-site task success.
describe('the Leader receives actionable Follower feedback', () => {
  const plan = (): FakeTurn => ({ kind: 'tool', name: 'set_plan', args: { plan: 'continue', subgoals } });

  it('passes a page-layer failure and the handoff explanation into the next plan', async () => {
    const page = new FakePageTools();
    page.click = async () => { throw new Error('target disappeared after navigation'); };
    const requests: string[] = [];
    const { events, ended } = await harness({
      page,
      leaderRespond: (call) => {
        requests.push(JSON.stringify(call.messages.at(-1)?.content));
        return plan();
      },
      follower: (call) => call.index === 0
        ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'RETURN_TO_LEADER', note: 'try the account menu instead' } }
        : { kind: 'tool', name: 'done', args: { summary: 'recovered' } },
    });
    expect(ended.status).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('target disappeared after navigation');
    expect(requests[1]).toContain('try the account menu instead');
    expect(requests[1]).toContain('Action: click');
    expect(requests[1]).not.toContain('Page snapshot');
    expect(pick(events, 'tool.result').find((e) => e.role === 'follower')?.result.ok).toBe(false);
  });

  it('reports all actions at a scheduled replan, not only the final signal', async () => {
    const requests: string[] = [];
    await harness({
      leaderRespond: (call) => {
        requests.push(JSON.stringify(call.messages.at(-1)?.content));
        return plan();
      },
      follower: (call) => call.index < 5
        ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE', note: `completed-part-${call.index}` } }
        : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });
    expect(requests).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) expect(requests[1]).toContain(`completed-part-${i}`);
  });

  it('does not report a previous planning interval as new work', async () => {
    const requests: string[] = [];
    await harness({
      leaderRespond: (call) => {
        requests.push(call.messages.map((message) => JSON.stringify(message.content)).join('\n'));
        return plan();
      },
      follower: (call) => call.index < 2
        ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'RETURN_TO_LEADER', note: `interval-${call.index}` } }
        : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('interval-1');
    // The whole Leader transcript, not only the newest message: earlier reports
    // stay in the reducer unless they are compacted before the next replan.
    expect(requests[2]).not.toContain('interval-0');
  });

  it("a later replan does not resend an earlier replan's leader_snapshot text", async () => {
    const evidence = 'page: [e1] heading "LEADER-EVIDENCE-0123"';
    const page = new FakePageTools({ snapshots: [{ text: evidence, tokens: 10 }] });
    const { leader } = await harness({
      page,
      leaderRespond: (call) =>
        call.index === 0 ? { kind: 'tool', name: 'leader_snapshot', args: {} } : plan(),
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'RETURN_TO_LEADER' } }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });

    expect(leader.calls).toHaveLength(3);
    const sentText = (call: FakeCall) => call.messages.map((m) => JSON.stringify(m.content)).join('\n');
    // The replan that pulled the evidence plans from it in full...
    expect(sentText(leader.calls[1]!)).toContain('LEADER-EVIDENCE-0123');
    // ...and the next replan gets a note in its place, its call id still answered.
    const replan = leader.calls[2]!;
    expect(sentText(replan)).not.toContain('LEADER-EVIDENCE-0123');
    const stub = replan.messages.find((m): m is ToolMessage => m instanceof ToolMessage && m.name === 'leader_snapshot');
    expect(stub?.content).toBe('[leader_snapshot result from the replan at step 0 omitted: superseded]');
    const callIds = replan.messages.flatMap((m) => (m instanceof AIMessage ? (m.tool_calls ?? []).map((c) => c.id) : []));
    expect(callIds).toContain(stub?.tool_call_id);
  });

  it('tells the Leader what a tool-less Follower actually said', async () => {
    const requests: string[] = [];
    await harness({
      leaderRespond: (call) => {
        requests.push(JSON.stringify(call.messages.at(-1)?.content));
        return plan();
      },
      follower: (call) => call.index === 0
        ? { kind: 'text', text: 'the export control is inside the account menu' }
        : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });
    expect(requests[1]).toContain('No tool call');
    expect(requests[1]).toContain('the export control is inside the account menu');
  });
});

describe('mixed Follower turns retain complete conversations', () => {
  const first = [
    new HumanMessage('old observation'),
    new AIMessage({ content: '', tool_calls: [{ id: 'old', name: 'click', args: {} }] }),
    new ToolMessage({ tool_call_id: 'old', name: 'click', content: 'old result' }),
  ];
  const idle = [new HumanMessage('idle observation'), new AIMessage('need a different plan')];
  const last = [
    new HumanMessage('current observation'),
    new AIMessage({ content: '', tool_calls: [{ id: 'new', name: 'click', args: { note: 'new target' } }] }),
    new ToolMessage({ tool_call_id: 'new', name: 'click', content: 'new result' }),
  ];

  it('does not leave an orphaned tool result when a prose turn interrupts action turns', () => {
    // Old slice(-4) starts with the idle AI reply rather than its observation.
    expect(trimFollowerHistory([...first, ...idle, ...last], 2)).toEqual([...idle, ...last]);
  });

  it('retains every message in the latest tool turn when asked for one turn', () => {
    expect(trimFollowerHistory([...first, ...idle, ...last], 1)).toEqual(last);
  });

  it('returns an empty transcript unchanged', () => {
    expect(trimFollowerHistory([])).toEqual([]);
  });

  it('uses the existing minimum of one complete turn when zero is requested', () => {
    expect(trimFollowerHistory([...first, ...idle, ...last], 0)).toEqual(last);
  });

  it('leaves page observations out of feedback while including the result and note', () => {
    const feedback = followerFeedback([...first, ...idle, ...last], 1);
    expect(feedback).toContain('new target');
    expect(feedback).toContain('new result');
    expect(feedback).not.toContain('current observation');
    expect(feedback).not.toContain('old result');
  });

  it('marks a bulk-result preview and leaves the original result untouched', () => {
    const result = new ToolMessage({ tool_call_id: 'new', name: 'extract_text', content: 'x'.repeat(4000) });
    const messages = [...last.slice(0, 2), result];
    expect(followerFeedback(messages, 1)).toContain('[tool result truncated at 2000 of 4000 characters]');
    expect(result.content).toHaveLength(4000);
  });

  it('does not invent progress when no Follower step has occurred', () => {
    expect(followerFeedback(last, 0)).toBe('');
  });
});

describe('authentication guidance follows the authorized task', () => {
  it('does not instruct either role to refuse every login page', () => {
    expect(LEADER_SYSTEM).not.toContain('never plan a subgoal that requires logging in');
    expect(FOLLOWER_SYSTEM).not.toContain('call blocked; never enter credentials');
    expect(LEADER_SYSTEM).toContain('Authorized sign-in or verification');
    expect(FOLLOWER_SYSTEM).toContain('Submit already-filled credentials or verification codes yourself');
    expect(FOLLOWER_SYSTEM).not.toContain('auth_step');
  });
});

// Pins for the PR #53/#54 bot reviews on the agent graph (M5).
describe('refused-click consent guidance', () => {
  it('never tells the follower to accept consent as a fallback', () => {
    // CodeRabbit security review on PR #54: "else accept" would grant optional
    // tracking during a task the user never authorized.
    expect(FOLLOWER_SYSTEM).not.toContain('else accept');
    expect(FOLLOWER_SYSTEM).toContain('leave the banner unresolved and ask the user');
  });
});

describe('the repeat-failure threshold', () => {
  it('hands back only on a turn that failed, and a successful read does not re-trigger it', async () => {
    const page = new FakePageTools();
    page.click = async () => {
      throw new Error('a consent banner covers e1');
    };
    const { events, ended } = await harness({
      page,
      follower: (call) =>
        call.index === 0 || call.index === 1
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : call.index === 2
            ? // The read keeps the failure count but must not hand back again:
              // the follower gets to act on what the read showed it.
              { kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } }
            : call.index === 3
              ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
              : { kind: 'tool', name: 'done', args: { summary: 'recovered' } },
    });

    const thresholdHandoffs = pick(events, 'follower.signal').filter((e) =>
      e.note.includes('repeated the same failing action'),
    );
    expect(thresholdHandoffs).toHaveLength(1);
    expect(ended.status).toBe('done');
  });

  it('carries the failing tool result into the Leader handoff note at the 2-failure mark', async () => {
    const page = new FakePageTools();
    page.click = async () => {
      throw new Error('the cookie banner covers e1');
    };
    const requests: string[] = [];
    await harness({
      page,
      leaderRespond: (call) => {
        requests.push(JSON.stringify(call.messages.at(-1)?.content));
        return { kind: 'tool', name: 'set_plan', args: { plan: 'continue', subgoals } };
      },
      follower: (call) =>
        call.index === 0 || call.index === 1
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'recovered' } },
    });

    // Kilo review on PR #53: without the note the Leader replanned blind — it saw
    // two identical failures in the transcript but no statement of what failed or
    // that it kept failing.
    expect(requests[1]).toContain(
      'Handoff note: the follower repeated the same failing action 2 times (click): the cookie banner covers e1',
    );
    expect(requests[1]).toContain('Replan around it');
  });
});
