/**
 * Two gaps the review found in `tests/input/debugger.test.ts`:
 *
 * 1. `createChromeDebuggerApi()` -- the real callback -> Promise adapter over
 *    `chrome.debugger`, including `chrome.runtime.lastError` translation -- had
 *    zero coverage; every existing test drives `DebuggerInputTier` against a
 *    hand-rolled fake `DebuggerApi` instead.
 * 2. No test isolates the "attach() alone sends no CDP command" invariant the
 *    module's own doc comment states, or documents what happens when the
 *    browser-side `detach()` call itself rejects.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChromeDebuggerApi, DebuggerInputTier, type DebuggerApi, type DebuggerTarget } from '@/src/input/debugger';

function fakeDebuggerApi(): DebuggerApi {
  return {
    async attach() {},
    async detach() {},
    async sendCommand() {
      return undefined;
    },
    onDetach: { addListener() {}, removeListener() {} },
  };
}

const originalChrome = (globalThis as Record<string, unknown>).chrome;

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = originalChrome;
});

describe('createChromeDebuggerApi: the real chrome.debugger adapter', () => {
  function installChromeDebuggerMock(overrides: {
    attach?: (target: unknown, version: unknown, cb: () => void) => void;
    detach?: (target: unknown, cb: () => void) => void;
    sendCommand?: (target: unknown, method: unknown, params: unknown, cb: (result: unknown) => void) => void;
    lastError?: { message: string } | undefined;
  }) {
    const listeners: Array<(source: DebuggerTarget, reason: string) => void> = [];
    (globalThis as Record<string, unknown>).chrome = {
      debugger: {
        attach: overrides.attach ?? ((_t, _v, cb) => cb()),
        detach: overrides.detach ?? ((_t, cb) => cb()),
        sendCommand: overrides.sendCommand ?? ((_t, _m, _p, cb) => cb(undefined)),
        onDetach: { addListener: (cb: (s: DebuggerTarget, r: string) => void) => listeners.push(cb) },
      },
      runtime: { lastError: overrides.lastError },
    };
    return listeners;
  }

  it('attach() resolves when chrome.debugger.attach succeeds with no lastError', async () => {
    installChromeDebuggerMock({});
    await expect(createChromeDebuggerApi().attach({ tabId: 1 }, '1.3')).resolves.toBeUndefined();
  });

  it('attach() rejects with chrome.runtime.lastError.message when the callback reports one', async () => {
    installChromeDebuggerMock({
      attach: (_t, _v, cb) => cb(),
      lastError: { message: 'Cannot attach to this target.' },
    });
    await expect(createChromeDebuggerApi().attach({ tabId: 1 }, '1.3')).rejects.toThrow('Cannot attach to this target.');
  });

  it('detach() resolves on success and rejects on lastError', async () => {
    installChromeDebuggerMock({});
    await expect(createChromeDebuggerApi().detach({ tabId: 1 })).resolves.toBeUndefined();

    installChromeDebuggerMock({ lastError: { message: 'Debugger is not attached to the tab' } });
    await expect(createChromeDebuggerApi().detach({ tabId: 1 })).rejects.toThrow('Debugger is not attached to the tab');
  });

  it('sendCommand() resolves with the result on success and rejects on lastError', async () => {
    installChromeDebuggerMock({ sendCommand: (_t, _m, _p, cb) => cb({ ok: true }) });
    await expect(
      createChromeDebuggerApi().sendCommand({ tabId: 1 }, 'Input.dispatchMouseEvent', {}),
    ).resolves.toEqual({ ok: true });

    installChromeDebuggerMock({ lastError: { message: 'boom' } });
    await expect(createChromeDebuggerApi().sendCommand({ tabId: 1 }, 'Input.dispatchMouseEvent', {})).rejects.toThrow(
      'boom',
    );
  });

  it('forwards a real onDetach event to the registered listener with the tabId and reason', () => {
    const listeners = installChromeDebuggerMock({});
    const seen: Array<{ target: DebuggerTarget; reason: string }> = [];
    createChromeDebuggerApi().onDetach.addListener((target, reason) => seen.push({ target, reason }));

    expect(listeners).toHaveLength(1);
    listeners[0]?.({ tabId: 7 } as never, 'target_closed');

    expect(seen).toEqual([{ target: { tabId: 7 }, reason: 'target_closed' }]);
  });
});

describe('DebuggerInputTier: attach() alone, isolated', () => {
  it('sends zero commands and adds exactly one onDetach listener', async () => {
    let listenerCount = 0;
    const api: DebuggerApi = {
      ...fakeDebuggerApi(),
      onDetach: {
        addListener() {
          listenerCount += 1;
        },
        removeListener() {
          listenerCount -= 1;
        },
      },
      sendCommand: async () => {
        throw new Error('attach() must never send a CDP command');
      },
    };
    const tier = new DebuggerInputTier(api);

    await tier.attach(1);

    expect(listenerCount).toBe(1);
    expect(tier.isAttached()).toBe(true);
  });
});

describe('DebuggerInputTier.detach(): the browser-side call rejects', () => {
  it('leaves the tier reporting attached, and its detach() call still rejects (documents current behaviour)', async () => {
    const api: DebuggerApi = {
      ...fakeDebuggerApi(),
      detach: async () => {
        throw new Error('Not attached');
      },
    };
    const tier = new DebuggerInputTier(api);
    await tier.attach(1);

    await expect(tier.detach()).rejects.toThrow('Not attached');
    // Current behaviour: the tier's own bookkeeping is only updated *after* a
    // successful browser-side detach, so a rejection leaves it believing it is
    // still attached. See docs/test-review.md for the "needs source change"
    // note on whether this should instead mark detached in a `finally`.
    expect(tier.isAttached()).toBe(true);
  });
});
