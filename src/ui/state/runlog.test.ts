import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import {
  initialRunLogState,
  runLogReducer,
  runPhase,
  toEntries,
  type RunLogState,
} from './runlog';

const RUN = 'run-1';

function call(callId: string, name: string, at: number): RunEvent {
  return { kind: 'tool.call', role: 'follower', call: { callId, name, args: { a: 1 } }, at };
}

function result(callId: string, ok: boolean, at: number): RunEvent {
  return {
    kind: 'tool.result',
    role: 'follower',
    result: { callId, name: 'click', ok, summary: ok ? 'clicked' : 'not found', durationMs: 12 },
    at,
  };
}

const step = (n: number, at: number): RunEvent => ({ kind: 'step', n, role: 'leader', at });

function feed(events: RunEvent[], from: RunLogState = initialRunLogState): RunLogState {
  return events.reduce(
    (state, event) => runLogReducer(state, { type: 'event', runId: RUN, event }),
    from,
  );
}

describe('runLogReducer', () => {
  it('keeps events in arrival order', () => {
    const state = feed([step(1, 10), call('c1', 'click', 11), step(2, 12)]);
    expect(state.events.map((e) => e.kind)).toEqual(['step', 'tool.call', 'step']);
    expect(state.runId).toBe(RUN);
  });

  it('ignores an event it already holds', () => {
    const once = feed([step(1, 10)]);
    const twice = runLogReducer(once, { type: 'event', runId: RUN, event: step(1, 10) });
    expect(twice.events).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('starts a clean log when a different run takes over', () => {
    const first = feed([step(1, 10), step(2, 11)]);
    const second = runLogReducer(first, { type: 'event', runId: 'run-2', event: step(1, 20) });
    expect(second.runId).toBe('run-2');
    expect(second.events).toHaveLength(1);
  });

  it('clears back to empty', () => {
    expect(runLogReducer(feed([step(1, 1)]), { type: 'clear' })).toEqual(initialRunLogState);
  });
});

describe('replay merge', () => {
  it('merges a replayed history without duplicating what the panel already has', () => {
    const live = feed([call('c1', 'click', 11), result('c1', true, 12), step(3, 13)]);
    const merged = runLogReducer(live, {
      type: 'replay',
      runId: RUN,
      events: [step(1, 9), call('c1', 'click', 11), result('c1', true, 12), step(2, 10)],
    });

    expect(merged.events).toHaveLength(5);
    expect(merged.keys).toHaveLength(new Set(merged.keys).size);
  });

  it('puts replayed history before events only the panel saw', () => {
    const live = feed([step(9, 90)]);
    const merged = runLogReducer(live, {
      type: 'replay',
      runId: RUN,
      events: [step(1, 10), step(2, 20)],
    });
    expect(merged.events.map((e) => (e.kind === 'step' ? e.n : -1))).toEqual([1, 2, 9]);
  });

  it('de-duplicates a history that repeats itself', () => {
    const merged = runLogReducer(initialRunLogState, {
      type: 'replay',
      runId: RUN,
      events: [step(1, 10), step(1, 10), call('c1', 'click', 11), call('c1', 'click', 99)],
    });
    expect(merged.events).toHaveLength(2);
  });

  it('replays into a fresh log when the run changed', () => {
    const live = feed([step(1, 10)]);
    const merged = runLogReducer(live, { type: 'replay', runId: 'run-2', events: [step(5, 50)] });
    expect(merged.runId).toBe('run-2');
    expect(merged.events).toHaveLength(1);
  });
});

describe('toEntries', () => {
  it('pairs a tool.call with its tool.result by callId', () => {
    const entries = toEntries([call('c1', 'click', 11), step(2, 12), result('c1', true, 13)]);
    expect(entries).toHaveLength(2);
    const tool = entries[0];
    if (tool?.kind !== 'tool') throw new Error('expected a tool entry first');
    expect(tool.callId).toBe('c1');
    expect(tool.call?.call.name).toBe('click');
    expect(tool.result?.result.ok).toBe(true);
  });

  it('does not pair results belonging to other calls', () => {
    const entries = toEntries([call('c1', 'click', 1), call('c2', 'type', 2), result('c2', false, 3)]);
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    if (first?.kind !== 'tool' || second?.kind !== 'tool') throw new Error('expected tool entries');
    expect(first.result).toBeUndefined();
    expect(second.result?.result.ok).toBe(false);
  });

  it('keeps an orphan result visible', () => {
    const entries = toEntries([result('ghost', false, 1)]);
    expect(entries).toHaveLength(1);
    const only = entries[0];
    if (only?.kind !== 'tool') throw new Error('expected a tool entry');
    expect(only.call).toBeUndefined();
    expect(only.result?.result.callId).toBe('ghost');
  });

  it('keeps plain events in order around tool pairs', () => {
    const entries = toEntries([
      step(1, 1),
      call('c1', 'click', 2),
      result('c1', true, 3),
      { kind: 'run.ended', status: 'done', message: 'ok', steps: 1, at: 4 },
    ]);
    expect(entries.map((e) => (e.kind === 'tool' ? 'tool' : e.event.kind))).toEqual([
      'step',
      'tool',
      'run.ended',
    ]);
  });
});

describe('runPhase', () => {
  it('is idle with no run', () => {
    expect(runPhase(initialRunLogState)).toBe('idle');
  });

  it('tracks pause, resume and end', () => {
    const started = feed([{ kind: 'run.started', runId: RUN, prompt: 'go', config: {
      leaderModel: 'a', followerModel: 'b', observe: 'dom', planningInterval: 5, maxSteps: 50,
      inputFidelity: 'in-page',
    }, tabId: 1, url: 'https://example.com', at: 1 }]);
    expect(runPhase(started)).toBe('running');

    const paused = runLogReducer(started, { type: 'event', runId: RUN, event: { kind: 'run.paused', at: 2 } });
    expect(runPhase(paused)).toBe('paused');

    const resumed = runLogReducer(paused, { type: 'event', runId: RUN, event: { kind: 'run.resumed', at: 3 } });
    expect(runPhase(resumed)).toBe('running');

    const ended = runLogReducer(resumed, {
      type: 'event',
      runId: RUN,
      event: { kind: 'run.ended', status: 'done', message: 'ok', steps: 3, at: 4 },
    });
    expect(runPhase(ended)).toBe('ended');
  });

  it('treats a claimed runId with no events as running', () => {
    expect(runPhase(runLogReducer(initialRunLogState, { type: 'run', runId: RUN }))).toBe('running');
  });
});
