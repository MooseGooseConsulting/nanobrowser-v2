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
 */
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config } from '@/src/storage';
import { decideNext, trimFollowerHistory, followerFeedback, FOLLOWER_HISTORY_TURNS, LEADER_SYSTEM, FOLLOWER_SYSTEM, type RouteInputs } from './graph';
import { FakePageTools } from './tools';
import { FakeChatModel, type FakeCall, type FakeTurn } from './models';
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
}): Promise<{ events: RunEvent[]; ended: RunEndedEvent }> {
  const events: RunEvent[] = [];
  const page = options.page ?? new FakePageTools();
  const leader = new FakeChatModel({
    label: 'leader',
    respond:
      options.leaderRespond ??
      (() => ({ kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals, currentSubgoal: 0 } })),
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower });

  const handle = startRun({
    prompt: 'find the widget',
    config: baseConfig,
    tools: page,
    models: { leader, follower },
    onEvent: (event) => events.push(event),
    checkpointer: new MemorySaver(),
    runId: `test-${Math.random().toString(36).slice(2)}`,
  });

  return handle.done.then((ended) => ({ events, ended }));
}

function pick<K extends RunEvent['kind']>(events: RunEvent[], kind: K): Extract<RunEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);
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
        requests.push(JSON.stringify(call.messages.at(-1)?.content));
        return plan();
      },
      follower: (call) => call.index < 2
        ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'RETURN_TO_LEADER', note: `interval-${call.index}` } }
        : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('interval-1');
    expect(requests[2]).not.toContain('interval-0');
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
