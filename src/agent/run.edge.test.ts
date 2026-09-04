/**
 * Two gaps the review found in `run.test.ts`:
 *
 * 1. The abort test's bound (`toBeLessThan(20)` against a `maxSteps: 20` run)
 *    passes even if abort took another 17 steps to land -- it only proves the
 *    run didn't run to full completion, not that abort stopped it promptly.
 *    This tightens it to the actual, deterministic step count (verified by
 *    direct observation of this exact scripted scenario: abort fires inside
 *    the `onEvent` callback for follower step 2, which lands *before* that
 *    step's own tool call runs, so exactly one `click` (from step 1) and
 *    exactly two `step` events occur).
 * 2. `maxSteps`/`planningInterval` boundary values (0, negative) were never
 *    driven through `startRun` at all. They turn out to be validated at
 *    runtime (by a zod schema over `AgentContext`, confirmed empirically
 *    below) and produce a graceful `run.ended{status:'error'}` rather than an
 *    infinite loop, a thrown exception, or a confusing LangGraph recursion
 *    error -- this pins that contract down so a future refactor that drops
 *    the validation is caught.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config } from '@/src/storage';
import { FakePageTools } from './tools';
import { FakeChatModel, type FakeCall, type FakeTurn } from './models';
import { IndexedDBSaver } from './checkpointer';
import { startRun, type RunEndedEvent, type RunHandle } from './run';

const baseConfig: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

let dbSeq = 0;

interface HarnessOptions {
  follower: (call: FakeCall) => FakeTurn;
  planningInterval?: number;
  maxSteps?: number;
  react?: (event: RunEvent, handle: RunHandle) => void;
}

async function harness(options: HarnessOptions): Promise<{ events: RunEvent[]; ended: RunEndedEvent; page: FakePageTools }> {
  const events: RunEvent[] = [];
  const page = new FakePageTools();
  const leader = new FakeChatModel({
    label: 'leader',
    respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'keep clicking', subgoals: ['click things'], currentSubgoal: 0 } }),
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower });

  let handle: RunHandle | undefined;
  handle = startRun({
    prompt: 'keep going',
    config: {
      ...baseConfig,
      planningInterval: options.planningInterval ?? baseConfig.planningInterval,
      maxSteps: options.maxSteps ?? baseConfig.maxSteps,
    },
    tools: page,
    models: { leader, follower },
    onEvent: (event) => {
      events.push(event);
      if (handle) options.react?.(event, handle);
    },
    checkpointer: new IndexedDBSaver({ dbName: `run-edge-${dbSeq++}` }),
  });

  const ended = await handle.done;
  return { events, ended, page };
}

const alwaysContinue = (): FakeTurn => ({ kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } });

function followerSteps(events: RunEvent[]): number[] {
  return events
    .filter((e): e is Extract<RunEvent, { kind: 'step' }> => e.kind === 'step')
    .filter((e) => e.role === 'follower')
    .map((e) => e.n);
}

describe('abort: a tight bound, not just "less than the step budget"', () => {
  it('stops at exactly the follower step abort() was called on, with no further tool calls', async () => {
    const { events, ended, page } = await harness({
      maxSteps: 20,
      planningInterval: 10,
      follower: alwaysContinue,
      react: (event, handle) => {
        if (event.kind === 'step' && event.role === 'follower' && event.n === 2) handle.abort();
      },
    });

    expect(ended.status).toBe('aborted');
    // Exact, not approximate: abort fires inside the onEvent callback for
    // follower step 2, so exactly steps [1, 2] run (never a step 3, which the
    // old "< 20" bound could never have caught) -- verified empirically
    // against this harness rather than assumed.
    expect(followerSteps(events)).toEqual([1, 2]);
    expect(page.names.filter((n) => n === 'click')).toEqual(['click', 'click']);
  });
});

describe('boundary values for maxSteps and planningInterval', () => {
  async function runWith(maxSteps: number, planningInterval: number) {
    const events: RunEvent[] = [];
    const handle = startRun({
      prompt: 'go',
      config: { ...baseConfig, maxSteps, planningInterval },
      tools: new FakePageTools(),
      models: {
        leader: new FakeChatModel({
          label: 'leader',
          respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'x', subgoals: ['a'], currentSubgoal: 0 } }),
        }),
        follower: new FakeChatModel({ label: 'follower', respond: alwaysContinue }),
      },
      onEvent: (event) => events.push(event),
      checkpointer: new IndexedDBSaver({ dbName: `run-edge-${dbSeq++}` }),
    });
    return { ended: await handle.done, events };
  }

  it('maxSteps: 0 ends gracefully as an error, not an infinite loop or a thrown exception', async () => {
    const { ended, events } = await runWith(0, 5);
    expect(ended.kind).toBe('run.ended');
    expect(ended.status).toBe('error');
    expect(ended.steps).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(['run.started', 'run.ended']);
  });

  it('maxSteps: -1 ends gracefully as an error', async () => {
    const { ended } = await runWith(-1, 5);
    expect(ended.status).toBe('error');
    expect(ended.message).toContain('maxSteps');
  });

  it('planningInterval: 0 ends gracefully as an error', async () => {
    const { ended } = await runWith(6, 0);
    expect(ended.status).toBe('error');
    expect(ended.message).toContain('planningInterval');
  });
});
