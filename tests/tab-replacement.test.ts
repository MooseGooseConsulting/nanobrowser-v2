import { afterEach, describe, expect, it } from 'vitest';
import { PageDriver } from '@/src/page/driver';
import type { ChromeApi, TabUpdateInfo } from '@/src/page/driver';
import { currentTabId, recordTabReplaced, resetTabReplacements } from '@/src/page/tabReplacement';

/** A Chrome fake whose tabs can be swapped, the way prerender activation swaps them. */
function swappableChrome() {
  const live = new Set([10]);
  const sentTo: number[] = [];
  const replacedListeners: Array<(added: number, removed: number) => void> = [];
  const updatedListeners: Array<(tabId: number, info: TabUpdateInfo) => void> = [];
  const api: ChromeApi = {
    scripting: {
      async executeScript({ target }) {
        if (!live.has(target.tabId)) throw new Error(`No tab with id: ${target.tabId}`);
        return [];
      },
    },
    tabs: {
      async sendMessage(tabId, message) {
        if (!live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        sentTo.push(tabId);
        return message.op === 'ping' ? { ok: true, pong: true, url: 'u', title: 't', devicePixelRatio: 1, width: 1, height: 1 } : { ok: true };
      },
      async update(tabId) {
        if (!live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return {};
      },
      async get(tabId) {
        if (!live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return { windowId: 1 };
      },
      async captureVisibleTab() {
        return 'data:image/png;base64,AAAA';
      },
      onUpdated: {
        addListener: (fn) => void updatedListeners.push(fn),
        removeListener: (fn) => void updatedListeners.splice(updatedListeners.indexOf(fn), 1),
      },
      onReplaced: { addListener: (fn) => void replacedListeners.push(fn) },
    },
  };
  return {
    api,
    sentTo,
    swap(from: number, to: number) {
      live.delete(from);
      live.add(to);
      for (const fn of replacedListeners) fn(to, from);
    },
    complete(tabId: number) {
      for (const fn of [...updatedListeners]) fn(tabId, { status: 'complete' });
    },
  };
}

afterEach(() => resetTabReplacements());

describe('tab replacement', () => {
  it('page ops reach the tab Chrome swapped in for the one the run started on', async () => {
    const chrome = swappableChrome();
    const driver = new PageDriver(chrome.api);
    expect((await driver.click(10, 'e1')).ok).toBe(true);

    chrome.swap(10, 77);
    const after = await driver.click(10, 'e2');

    expect(after).toEqual({ ok: true });
    expect(chrome.sentTo.at(-1)).toBe(77);
  });

  it('a navigation settles when the replacement tab finishes loading', async () => {
    const chrome = swappableChrome();
    const driver = new PageDriver(chrome.api, { navigateTimeoutMs: 1000 });
    const pending = driver.navigate(10, 'https://example.test/next');
    chrome.swap(10, 78);
    chrome.complete(78);
    expect(await pending).toEqual({ ok: true });
  });

  it('follows a chain of replacements to the newest tab', () => {
    recordTabReplaced(2, 1);
    recordTabReplaced(3, 2);
    expect(currentTabId(1)).toBe(3);
    expect(currentTabId(9)).toBe(9);
  });
});
