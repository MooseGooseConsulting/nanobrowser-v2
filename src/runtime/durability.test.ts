/**
 * M6 durability stores: memory backs round-trip, and the step counter reads
 * the restored log for the synthetic terminal event.
 */
import { describe, expect, it } from 'vitest';
import { memoryStores, stepsIn } from './durability';
import type { RunEvent } from '@/src/messaging';

const started: RunEvent = {
  kind: 'run.started',
  runId: 'r1',
  prompt: 'go',
  config: {
    leaderModel: 'l',
    followerModel: 'f',
    observe: 'dom',
    planningInterval: 5,
    maxSteps: 10,
    inputFidelity: 'in-page',
  },
  tabId: 3,
  url: 'https://example.test/',
  at: 1,
};

describe('memoryStores replay', () => {
  it('round-trips one run log without touching another', async () => {
    const { replay } = memoryStores();
    await replay.save('r1', [started, { kind: 'step', n: 1, role: 'follower', at: 2 }]);
    expect(await replay.load('r1')).toHaveLength(2);
    expect(await replay.load('r2')).toBeUndefined();
  });

  it('saves a copy: later publishes do not rewrite the stored array', async () => {
    const { replay } = memoryStores();
    const events: RunEvent[] = [started];
    await replay.save('r1', events);
    events.push({ kind: 'step', n: 1, role: 'follower', at: 2 });
    expect(await replay.load('r1')).toHaveLength(1);
  });
});

describe('memoryStores values', () => {
  it('reports missing until the first save, then returns the value', async () => {
    const { values } = memoryStores();
    expect(await values.load()).toEqual({ found: false });
    await values.save({ rows: [1, 2] });
    expect(await values.load()).toEqual({ found: true, value: { rows: [1, 2] } });
  });
});

describe('stepsIn', () => {
  it('returns the highest step number, or 0 for a log with no steps', () => {
    expect(
      stepsIn([started, { kind: 'step', n: 2, role: 'follower', at: 2 }, { kind: 'step', n: 1, role: 'leader', at: 3 }]),
    ).toBe(2);
    expect(stepsIn([started])).toBe(0);
  });
});
