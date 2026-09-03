import { describe, expect, it } from 'vitest';
import { InPageInputTier, type PageDriverLike } from '@/src/input/inpage';

function fakeDriver() {
  const calls: string[] = [];
  const driver: PageDriverLike = {
    async click(tabId, ref) { calls.push(`click:${tabId}:${ref}`); },
    async moveTo(tabId, ref) { calls.push(`moveTo:${tabId}:${ref}`); },
    async type(tabId, ref, text) { calls.push(`type:${tabId}:${ref}:${text}`); },
    async press(tabId, ref, key) { calls.push(`press:${tabId}:${ref}:${key}`); },
    async scroll(tabId, ref, dx, dy) { calls.push(`scroll:${tabId}:${ref}:${dx}:${dy}`); },
  };
  return { driver, calls };
}

describe('InPageInputTier', () => {
  it('is unattached until attach(), then forwards every action to the driver with the tab id', async () => {
    const { driver, calls } = fakeDriver();
    const tier = new InPageInputTier(driver);
    expect(tier.isAttached()).toBe(false);

    await tier.attach(3);
    expect(tier.isAttached()).toBe(true);
    expect(tier.name).toBe('in-page');

    await tier.click('a');
    await tier.moveTo('b');
    await tier.typeText('c', 'hi');
    await tier.press('d', 'Enter');
    await tier.scroll('e', 1, 2);

    expect(calls).toEqual([
      'click:3:a',
      'moveTo:3:b',
      'type:3:c:hi',
      'press:3:d:Enter',
      'scroll:3:e:1:2',
    ]);

    await tier.detach();
    expect(tier.isAttached()).toBe(false);
  });

  it('throws instead of silently no-op-ing when an action runs before attach', async () => {
    const { driver } = fakeDriver();
    const tier = new InPageInputTier(driver);
    await expect(tier.click('a')).rejects.toThrow(/not attached/);
  });

  it('tolerates a driver with no moveTo (optional in PageDriverLike)', async () => {
    const driver: PageDriverLike = {
      async click() {},
      async type() {},
      async press() {},
      async scroll() {},
    };
    const tier = new InPageInputTier(driver);
    await tier.attach(1);
    await expect(tier.moveTo('a')).resolves.toBeUndefined();
  });
});
