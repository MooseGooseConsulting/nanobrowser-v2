/**
 * Run lifecycle: the safety valve (R-04), pause/resume across a checkpoint, and
 * abort. Pause and resume run against the real {@link IndexedDBSaver} on
 * `fake-indexeddb`, because "resumes from the checkpoint" is only worth
 * asserting against the store the extension actually uses.
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
  /** Called for every event, with the live handle, so a test can pause or abort. */
  react?: (event: RunEvent, handle: RunHandle) => void;
}

async function harness(options: HarnessOptions): Promise<{
  events: RunEvent[];
  ended: RunEndedEvent;
  page: FakePageTools;
}> {
  const events: RunEvent[] = [];
  const page = new FakePageTools();
  const leader = new FakeChatModel({
    label: 'leader',
    respond: () => ({
      kind: 'tool',
      name: 'set_plan',
      args: { plan: 'keep clicking', subgoals: ['click things'], currentSubgoal: 0 },
    }),
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
    checkpointer: new IndexedDBSaver({ dbName: `run-${dbSeq++}` }),
  });

  const ended = await handle.done;
  return { events, ended, page };
}

const alwaysContinue = (): FakeTurn => ({
  kind: 'tool',
  name: 'click',
  args: { ref: 'e1', signal: 'CONTINUE' },
});

function followerSteps(events: RunEvent[]): number[] {
  return events
    .filter((e): e is Extract<RunEvent, { kind: 'step' }> => e.kind === 'step')
    .filter((e) => e.role === 'follower')
    .map((e) => e.n);
}

describe('safety valve (R-04)', () => {
  it('ends with max-steps after exactly maxSteps follower steps', async () => {
    const { events, ended } = await harness({
      maxSteps: 3,
      planningInterval: 5,
      follower: alwaysContinue,
    });

    expect(followerSteps(events)).toEqual([1, 2, 3]);
    expect(ended).toMatchObject({ kind: 'run.ended', status: 'max-steps', steps: 3 });
    // The valve fires, not a handoff: the leader is never consulted a second time.
    expect(events.filter((e) => e.kind === 'leader.plan')).toHaveLength(1);
    expect(events.at(-1)).toBe(ended);
  });
});

describe('pause and resume', () => {
  it('drains at a step boundary and resumes from the checkpoint with the step count intact', async () => {
    const { events, ended } = await harness({
      maxSteps: 6,
      planningInterval: 5,
      follower: alwaysContinue,
      react: (event, handle) => {
        if (event.kind === 'step' && event.role === 'follower' && event.n === 2) handle.pause();
        if (event.kind === 'run.paused') handle.resume();
      },
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'run.paused')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'run.resumed')).toHaveLength(1);
    expect(kinds.indexOf('run.paused')).toBeLessThan(kinds.indexOf('run.resumed'));

    // Step numbers continue across the pause: no step is replayed and none is lost.
    const steps = followerSteps(events);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(steps).size).toBe(steps.length);

    const pausedAfter = followerSteps(events.slice(0, kinds.indexOf('run.paused')));
    expect(pausedAfter.length).toBeGreaterThan(0);
    expect(pausedAfter.length).toBeLessThan(steps.length);

    expect(ended).toMatchObject({ status: 'max-steps', steps: 6 });
  });
});

describe('abort', () => {
  it('ends with aborted when the AbortSignal fires mid-run', async () => {
    const { events, ended, page } = await harness({
      maxSteps: 20,
      planningInterval: 10,
      follower: alwaysContinue,
      react: (event, handle) => {
        if (event.kind === 'step' && event.role === 'follower' && event.n === 2) handle.abort();
      },
    });

    expect(ended.status).toBe('aborted');
    expect(followerSteps(events).length).toBeLessThan(20);
    expect(events.some((e) => e.kind === 'run.paused')).toBe(false);
    // The run really stopped: no further page work after the abort.
    expect(page.names.filter((n) => n === 'click').length).toBeLessThan(20);
  });

  it('ends with aborted when the caller-supplied signal is already aborted', async () => {
    const events: RunEvent[] = [];
    const controller = new AbortController();
    controller.abort(new Error('worker shutting down'));

    const handle = startRun({
      prompt: 'never starts',
      config: { ...baseConfig, maxSteps: 5 },
      tools: new FakePageTools(),
      models: {
        leader: new FakeChatModel({ label: 'leader' }),
        follower: new FakeChatModel({ label: 'follower' }),
      },
      onEvent: (event) => events.push(event),
      checkpointer: new IndexedDBSaver({ dbName: `run-${dbSeq++}` }),
      signal: controller.signal,
    });

    const ended = await handle.done;
    expect(ended).toMatchObject({ status: 'aborted', steps: 0 });
    expect(events.some((e) => e.kind === 'step')).toBe(false);
  });
});
