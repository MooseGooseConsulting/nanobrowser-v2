/**
 * The review found `RunInput`'s coordinate-tier (debugger) branch spot-tested
 * only via `click()` in `select.test.ts` -- `moveTo`, `typeText`, `press`, and
 * `scroll` each have their own `isRefTier(tier)` branch in `select.ts` that was
 * never exercised for a coordinate tier. This proves each one converts the ref
 * to a point via `getBox` (or, for `typeText`, does not -- it types into
 * whatever has focus, per the doc comment) rather than forwarding the ref.
 */
import { describe, expect, it } from 'vitest';
import type { InputTier } from '@/src/input/types';
import { RunInput, type Box } from '@/src/input/select';

interface Recorded {
  method: string;
  args: unknown[];
}

function fakeCoordinateTier(): { tier: InputTier; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const tier: InputTier = {
    name: 'debugger',
    async attach() {},
    async detach() {},
    isAttached: () => true,
    async click(x, y, opts) {
      calls.push({ method: 'click', args: [x, y, opts] });
    },
    async moveTo(x, y) {
      calls.push({ method: 'moveTo', args: [x, y] });
    },
    async typeText(text) {
      calls.push({ method: 'typeText', args: [text] });
    },
    async press(key, opts) {
      calls.push({ method: 'press', args: [key, opts] });
    },
    async scroll(x, y, dx, dy) {
      calls.push({ method: 'scroll', args: [x, y, dx, dy] });
    },
  };
  return { tier, calls };
}

const box: Box = { x: 100, y: 100, width: 20, height: 20 };
const getBox = async (): Promise<Box> => box;

describe('RunInput: the debugger (coordinate) tier branch, for every method click() does not already cover', () => {
  it('moveTo resolves the ref to a viewport point via getBox', async () => {
    const { tier, calls } = fakeCoordinateTier();
    const run = new RunInput({ tier, getBox, rng: () => 0.5 }); // rng 0.5 -> zero jitter, exact center

    await run.moveTo('target');

    expect(calls).toEqual([{ method: 'moveTo', args: [110, 110] }]);
  });

  it('scroll resolves the ref to a viewport point via getBox and forwards the delta', async () => {
    const { tier, calls } = fakeCoordinateTier();
    const run = new RunInput({ tier, getBox, rng: () => 0.5 });

    await run.scroll('target', 0, 40);

    expect(calls).toEqual([{ method: 'scroll', args: [110, 110, 0, 40] }]);
  });

  it('press does not resolve the ref at all -- it presses whatever currently has focus', async () => {
    const { tier, calls } = fakeCoordinateTier();
    const run = new RunInput({ tier, getBox, rng: () => 0.5 });

    await run.press('target', 'Enter');

    expect(calls).toEqual([{ method: 'press', args: ['Enter', undefined] }]);
  });

  it('typeText does not resolve the ref either -- it types into whatever has focus', async () => {
    const { tier, calls } = fakeCoordinateTier();
    const run = new RunInput({ tier, getBox, rng: () => 0.5 });

    await run.typeText('target', 'hello');

    expect(calls).toEqual([{ method: 'typeText', args: ['hello'] }]);
  });

  it('a getBox failure propagates rather than silently resolving to (0,0)', async () => {
    const { tier } = fakeCoordinateTier();
    const run = new RunInput({
      tier,
      getBox: async () => {
        throw new Error('unknown ref');
      },
    });

    await expect(run.moveTo('missing')).rejects.toThrow('unknown ref');
  });
});
