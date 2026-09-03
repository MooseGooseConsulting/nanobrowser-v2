import { describe, expect, it } from 'vitest';
import { InPageInputTier, type PageDriverLike } from '@/src/input/inpage';
import { DebuggerInputTier, type DebuggerApi } from '@/src/input/debugger';
import { refToPoint, RunInput, selectTier, type Box } from '@/src/input/select';
import { seededRng } from './support/rng';

function fakeDebuggerApi(): DebuggerApi {
  return {
    async attach() {},
    async detach() {},
    async sendCommand() { return undefined; },
    onDetach: { addListener() {}, removeListener() {} },
  };
}

function fakePageDriver(calls: string[]): PageDriverLike {
  return {
    async click(tabId, ref) { calls.push(`click:${tabId}:${ref}`); },
    async type(tabId, ref, text) { calls.push(`type:${tabId}:${ref}:${text}`); },
    async press(tabId, ref, key) { calls.push(`press:${tabId}:${ref}:${key}`); },
    async scroll(tabId, ref, dx, dy) { calls.push(`scroll:${tabId}:${ref}:${dx}:${dy}`); },
  };
}

describe('selectTier', () => {
  it('routes "in-page" to the in-page tier and "escalated" to the debugger tier', () => {
    const inPageTier = new InPageInputTier(fakePageDriver([]));
    const debuggerTier = new DebuggerInputTier(fakeDebuggerApi());

    expect(selectTier('in-page', { inPageTier, debuggerTier })).toBe(inPageTier);
    expect(selectTier('escalated', { inPageTier, debuggerTier })).toBe(debuggerTier);
  });
});

describe('refToPoint', () => {
  it('always stays inside the box, off dead-center given noise', async () => {
    const box: Box = { x: 100, y: 200, width: 40, height: 20 };
    const getBox = async () => box;
    const rng = seededRng(1);

    const seen: { x: number; y: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const p = await refToPoint(getBox, 'ref-1', rng);
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width);
      expect(p.y).toBeGreaterThanOrEqual(box.y);
      expect(p.y).toBeLessThanOrEqual(box.y + box.height);
      seen.push(p);
    }
    // Not every draw lands on the exact center -> jitter is actually applied.
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(seen.some(p => p.x !== center.x || p.y !== center.y)).toBe(true);
  });
});

describe('RunInput', () => {
  it('forwards ref-based calls straight through for the in-page tier', async () => {
    const calls: string[] = [];
    const inPageTier = new InPageInputTier(fakePageDriver(calls));
    const getBox = async (): Promise<Box> => ({ x: 0, y: 0, width: 10, height: 10 });
    const run = new RunInput({ tier: inPageTier, getBox });

    await run.attach(1);
    await run.click('btn');
    await run.typeText('field', 'hello');
    await run.press('field', 'Enter');
    await run.scroll('list', 0, 50);

    expect(calls).toEqual([
      'click:1:btn',
      'type:1:field:hello',
      'press:1:field:Enter',
      'scroll:1:list:0:50',
    ]);
  });

  it('converts a ref to a viewport point via getBox for the debugger tier', async () => {
    const box: Box = { x: 100, y: 100, width: 20, height: 20 };
    const getBox = async (ref: string) => {
      expect(ref).toBe('target');
      return box;
    };
    const fake = fakeDebuggerApi();
    const sent: { method: string; params?: Record<string, unknown> }[] = [];
    fake.sendCommand = async (_target, method, params) => {
      sent.push({ method, params });
      return undefined;
    };
    const debuggerTier = new DebuggerInputTier(fake, { rng: seededRng(3), sleep: async () => {} });
    await debuggerTier.attach(1);

    const run = new RunInput({ tier: debuggerTier, getBox, rng: seededRng(9) });
    await run.click('target');

    const pressed = sent.find(c => c.params?.type === 'mousePressed')!;
    const x = pressed.params!.x as number;
    const y = pressed.params!.y as number;
    expect(x).toBeGreaterThanOrEqual(box.x);
    expect(x).toBeLessThanOrEqual(box.x + box.width);
    expect(y).toBeGreaterThanOrEqual(box.y);
    expect(y).toBeLessThanOrEqual(box.y + box.height);
  });
});
