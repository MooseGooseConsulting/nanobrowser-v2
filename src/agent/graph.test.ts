/**
 * Graph behaviour: cadence (R-04), Follower-initiated handoff (R-03), tool-call
 * logging (R-06/R-07), observe modes (R-08), and history separation.
 *
 * No network and no browser: `FakeChatModel` scripts the models and
 * `FakePageTools` records the page calls (N-01/N-02 — nothing outside the run
 * drives it, so a scripted model is the whole world).
 */
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { ToolMessage } from '@langchain/core/messages';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config, ObserveMode } from '@/src/storage';
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

interface HarnessOptions {
  follower: (call: FakeCall) => FakeTurn;
  planningInterval?: number;
  maxSteps?: number;
  observe?: ObserveMode;
  subgoals?: string[];
}

interface HarnessResult {
  events: RunEvent[];
  ended: RunEndedEvent;
  page: FakePageTools;
  leader: FakeChatModel;
  follower: FakeChatModel;
}

async function harness(options: HarnessOptions): Promise<HarnessResult> {
  const events: RunEvent[] = [];
  const page = new FakePageTools();
  const subgoals = options.subgoals ?? ['open the page', 'read the page'];
  const leader = new FakeChatModel({
    label: 'leader',
    respond: () => ({
      kind: 'tool',
      name: 'set_plan',
      args: { plan: 'do it in two moves', subgoals, currentSubgoal: 0 },
    }),
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower });

  const handle = startRun({
    prompt: 'find the widget',
    config: {
      ...baseConfig,
      planningInterval: options.planningInterval ?? baseConfig.planningInterval,
      maxSteps: options.maxSteps ?? baseConfig.maxSteps,
      observe: options.observe ?? baseConfig.observe,
    },
    tools: page,
    models: { leader, follower },
    onEvent: (event) => events.push(event),
    checkpointer: new MemorySaver(),
    runId: `test-${Math.random().toString(36).slice(2)}`,
  });

  const ended = await handle.done;
  return { events, ended, page, leader, follower };
}

function pick<K extends RunEvent['kind']>(
  events: RunEvent[],
  kind: K,
): Extract<RunEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);
}

function followerStepNumbers(events: RunEvent[]): number[] {
  return pick(events, 'step')
    .filter((e) => e.role === 'follower')
    .map((e) => e.n);
}

/** The follower step number in effect when each follower -> leader handoff fired. */
function handoffSteps(events: RunEvent[]): number[] {
  const at: number[] = [];
  let step = 0;
  for (const event of events) {
    if (event.kind === 'step' && event.role === 'follower') step = event.n;
    if (event.kind === 'handoff' && event.from === 'follower') at.push(step);
  }
  return at;
}

function toolNamesInHistory(model: FakeChatModel): string[] {
  return model.calls.flatMap((call) =>
    call.messages
      .filter((m) => m.type === 'tool')
      .map((m) => (m as ToolMessage).name ?? '(unnamed)'),
  );
}

const alwaysContinue = (): FakeTurn => ({
  kind: 'tool',
  name: 'click',
  args: { ref: 'e1', signal: 'CONTINUE' },
});

describe('leader/follower cadence (R-04)', () => {
  it('replans exactly every planningInterval follower steps', async () => {
    const { events, ended } = await harness({
      planningInterval: 2,
      maxSteps: 6,
      follower: alwaysContinue,
    });

    expect(followerStepNumbers(events)).toEqual([1, 2, 3, 4, 5, 6]);
    // One initial plan plus one re-plan after each pair of follower steps.
    expect(pick(events, 'leader.plan').map((e) => e.replan)).toEqual([false, true, true]);
    expect(handoffSteps(events)).toEqual([2, 4]);
    expect(pick(events, 'handoff').filter((e) => e.from === 'leader')).toHaveLength(3);
    for (const handoff of pick(events, 'handoff').filter((e) => e.from === 'follower')) {
      expect(handoff.reason).toContain('planning interval of 2');
      expect(handoff.signal).toBe('CONTINUE');
    }
    expect(ended.status).toBe('max-steps');
  });
});

describe('follower-initiated handoff (R-03)', () => {
  it.each(['SUBGOAL_COMPLETE', 'RETURN_TO_LEADER'] as const)(
    'routes %s straight back to the leader',
    async (signal) => {
      const { events, ended } = await harness({
        planningInterval: 5,
        maxSteps: 4,
        follower: (call) =>
          call.index === 0
            ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal, note: 'moving on' } }
            : { kind: 'tool', name: 'done', args: { summary: 'found the widget' } },
      });

      // The handoff happened on step 1, well inside the planning interval of 5.
      expect(handoffSteps(events)).toEqual([1]);
      const back = pick(events, 'handoff').find((e) => e.from === 'follower');
      expect(back?.signal).toBe(signal);
      expect(back?.reason).not.toContain('planning interval');

      const kinds = events.map((e) => e.kind);
      const handoffIndex = kinds.indexOf('handoff', kinds.indexOf('step') + 1);
      // Nothing runs between the follower's signal and the leader's re-plan.
      expect(kinds.slice(handoffIndex).filter((k) => k === 'leader.plan')).toHaveLength(1);
      expect(pick(events, 'leader.plan').map((e) => e.replan)).toEqual([false, true]);
      expect(followerStepNumbers(events)).toEqual([1, 2]);
      expect(ended.status).toBe('done');
    },
  );

  it('ends the run on BLOCKED without returning to the leader', async () => {
    const { events, ended } = await harness({
      maxSteps: 10,
      follower: () => ({
        kind: 'tool',
        name: 'click',
        args: { ref: 'e1', signal: 'BLOCKED', note: 'login wall' },
      }),
    });

    expect(ended.status).toBe('blocked');
    expect(ended.steps).toBe(1);
    expect(pick(events, 'follower.signal')[0]).toMatchObject({
      signal: 'BLOCKED',
      note: 'login wall',
    });
    expect(pick(events, 'handoff').filter((e) => e.from === 'follower')).toHaveLength(0);
    expect(pick(events, 'leader.plan')).toHaveLength(1);
  });
});

describe('tool call log (R-06)', () => {
  it('emits tool.call then tool.result in order with matching callIds', async () => {
    const { events } = await harness({
      planningInterval: 5,
      maxSteps: 4,
      follower: (call) =>
        call.index < 2
          ? { kind: 'tool', name: 'type', args: { ref: 'e2', text: 'widget', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    const pairs = events.filter((e) => e.kind === 'tool.call' || e.kind === 'tool.result');
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length % 2).toBe(0);

    const names: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const call = pairs[i];
      const result = pairs[i + 1];
      if (call?.kind !== 'tool.call' || result?.kind !== 'tool.result') {
        throw new Error(`unpaired tool events at ${i}: ${call?.kind} / ${result?.kind}`);
      }
      expect(result.result.callId).toBe(call.call.callId);
      expect(result.result.name).toBe(call.call.name);
      expect(result.role).toBe(call.role);
      expect(result.result.ok).toBe(true);
      names.push(call.call.name);
    }

    // The leader's own planning call is logged the same way.
    expect(names).toContain('set_plan');
    expect(names).toContain('type');
    expect(names).toContain('done');

    // The control envelope is a protocol detail, not something the UI shows as
    // an argument of the action.
    const typeCall = pick(events, 'tool.call').find((e) => e.call.name === 'type');
    expect(typeCall?.call.args).toEqual({ ref: 'e2', text: 'widget' });
  });
});

describe('observe modes (R-08)', () => {
  const imageBlocks = (model: FakeChatModel): string[] => {
    const last = model.calls.at(-1);
    const human = last?.messages.at(-1);
    const content = human?.content;
    if (typeof content === 'string' || content === undefined) return [];
    return (content as Array<{ type?: string }>).map((b) => b.type ?? '');
  };

  it('sends an image content block in pixels mode and none in dom mode', async () => {
    const pixels = await harness({ maxSteps: 1, observe: 'pixels', follower: alwaysContinue });
    expect(imageBlocks(pixels.follower)).toContain('image');
    expect(pixels.page.names).toContain('screenshot');
    expect(pixels.page.names).not.toContain('snapshot');
    expect(pick(pixels.events, 'observation')[0]).toMatchObject({
      mode: 'pixels',
      hasScreenshot: true,
    });

    const dom = await harness({ maxSteps: 1, observe: 'dom', follower: alwaysContinue });
    expect(imageBlocks(dom.follower)).not.toContain('image');
    expect(dom.page.names).toContain('snapshot');
    expect(dom.page.names).not.toContain('screenshot');
    expect(pick(dom.events, 'observation')[0]).toMatchObject({
      mode: 'dom',
      hasScreenshot: false,
    });

    const both = await harness({ maxSteps: 1, observe: 'both', follower: alwaysContinue });
    expect(imageBlocks(both.follower)).toContain('image');
    expect(both.page.names).toContain('snapshot');
    expect(both.page.names).toContain('screenshot');
  });
});

describe('role isolation', () => {
  it('keeps the leader and follower message histories separate', async () => {
    const { leader, follower } = await harness({
      planningInterval: 2,
      maxSteps: 6,
      follower: (call) =>
        call.index < 3
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });

    expect(leader.calls.length).toBeGreaterThan(1);
    expect(follower.calls.length).toBeGreaterThan(1);

    // The planner never sees a page observation.
    const leaderSeen = JSON.stringify(leader.calls.map((c) => c.messages.map((m) => m.content)));
    expect(leaderSeen).not.toContain('Page snapshot');
    expect(toolNamesInHistory(leader)).toEqual(
      Array.from({ length: leader.calls.length - 1 }, () => 'set_plan'),
    );

    // The navigator never sees the plan tool or the planner's instructions.
    const followerSeen = JSON.stringify(
      follower.calls.map((c) => c.messages.map((m) => m.content)),
    );
    expect(followerSeen).not.toContain('set_plan');
    expect(followerSeen).toContain('Page snapshot');
    const followerTools = toolNamesInHistory(follower);
    expect(followerTools.length).toBeGreaterThan(0);
    expect(followerTools).not.toContain('set_plan');

    // Each role is bound only to its own tools.
    expect(leader.boundTools).toEqual(['set_plan']);
    expect(follower.boundTools).toContain('click');
    expect(follower.boundTools).not.toContain('set_plan');
  });
});
