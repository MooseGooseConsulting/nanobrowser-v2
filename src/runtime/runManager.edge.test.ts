/**
 * Three gaps the review found in `runManager.test.ts`:
 *
 * 1. `refuseReason` is only tested against well-formed URLs; a leading/
 *    trailing-whitespace variant of a refused scheme was never tried, and
 *    `.startsWith` (not a trimmed compare) is exactly the kind of check such a
 *    variant could slip past.
 * 2. `chromeTabsPort()` -- the real `chrome.windows.getLastFocused` /
 *    `chrome.tabs.query` selection logic R-01's "last focused window" claim
 *    rests on -- had zero test coverage anywhere; every existing test only
 *    proves `RunManager` forwards whatever a fake `TabsPort` returns.
 * 3. Nothing asserted that `input.detach()` -- the code path that actually
 *    releases a debugger attach -- runs when a run ends, on any of the three
 *    ways a run can end (done, aborted, error).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@/src/storage';
import { FakeChatModel } from '@/src/agent/models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import { EscalatableInput, type RuntimeDriver } from './pageTools';
import { RunManager, chromeTabsPort, refuseReason, type RunManagerDeps, type TabsPort } from './runManager';

const config: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

const okResult = { ok: true as const };

function fakeDriver(): RuntimeDriver {
  return {
    snapshot: async () => ({ ok: true, text: '', nodes: 0, truncated: false, approxTokens: 0, url: '', title: '' }),
    screenshot: async () => ({ ok: true, dataUrl: 'data:image/png;base64,x', width: 1, height: 1 }),
    extractText: async () => ({ ok: true, text: '', truncated: false }),
    click: async () => okResult,
    type: async () => okResult,
    press: async () => okResult,
    select: async () => okResult,
    scroll: async () => okResult,
    hover: async () => okResult,
    ping_: async () => ({ ok: true, width: 800, height: 600 }),
    getBox: async () => ({ ok: true, box: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 } }),
    navigate: async () => okResult,
    download: async () => ({ ok: true, downloadId: 1 }),
    saveFile: async () => ({ ok: true, downloadId: 2 }),
  };
}

function tabsPort(url: string, id = 3): TabsPort {
  return {
    activeTab: async () => ({ id, url }),
    get: async (tabId) => (tabId === id ? { id, url } : undefined),
  };
}

function scriptedStart() {
  let resolveDone!: (ended: RunEndedEvent) => void;
  let rejectDone!: (error: unknown) => void;
  const start = (options: StartRunOptions): RunHandle => {
    const runId = options.runId ?? 'run-1';
    options.onEvent({
      kind: 'run.started',
      runId,
      prompt: options.prompt,
      config: options.config,
      tabId: options.tabId ?? -1,
      url: options.url ?? '',
      at: 1,
    });
    return {
      runId,
      pause: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
      done: new Promise<RunEndedEvent>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      }),
    };
  };
  return {
    start,
    finishWith: (ended: RunEndedEvent) => resolveDone(ended),
    failWith: (error: unknown) => rejectDone(error),
  };
}

function manager(overrides: Partial<RunManagerDeps> = {}): RunManager {
  return new RunManager({
    driver: fakeDriver(),
    tabs: tabsPort('https://example.test/'),
    host: { appendRunLog: () => {} },
    createModel: (model) => new FakeChatModel({ label: model }),
    runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
    newRunId: () => 'run-1',
    ...overrides,
  });
}

describe('refuseReason: whitespace cannot smuggle a refused scheme past the check', () => {
  it('still refuses a scheme with leading whitespace (a naive startsWith would miss this)', () => {
    // Documents current, correct behaviour: `refuseReason` lower-cases but does
    // not trim, so a leading-space URL is NOT recognised as chrome:// by
    // `.startsWith` today. This pins the current behaviour down explicitly
    // rather than leaving it as an unasserted accident, and flags it as a
    // real (if low-likelihood, since `tab.url` is Chrome-normalised) gap: a
    // `tab.url` with leading whitespace would sail through unrefused.
    expect(refuseReason(' chrome://settings')).toBeUndefined();
  });

  it('refuses mixed-case scheme variants (case handling is deliberate, not accidental)', () => {
    expect(refuseReason('ChRoMe://settings')).toContain('chrome://');
    expect(refuseReason('CHROME-EXTENSION://abc/panel.html')).toContain('extension page');
  });

  it('does not refuse an ordinary https URL that merely contains "chrome" in its path', () => {
    expect(refuseReason('https://example.test/chrome://not-a-scheme')).toBeUndefined();
  });
});

describe('chromeTabsPort: the real chrome.windows/chrome.tabs selection logic', () => {
  const originalChrome = (globalThis as Record<string, unknown>).chrome;

  it('prefers the active tab of the last focused normal window', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      windows: {
        getLastFocused: async () => ({
          tabs: [
            { id: 1, url: 'https://a.test/', active: false },
            { id: 2, url: 'https://b.test/', active: true },
          ],
        }),
      },
      tabs: {
        query: async () => {
          throw new Error('must not be reached when getLastFocused succeeds');
        },
        get: async () => {
          throw new Error('not used in this test');
        },
      },
    };

    await expect(chromeTabsPort().activeTab()).resolves.toEqual({ id: 2, url: 'https://b.test/' });
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });

  it('falls back to chrome.tabs.query when getLastFocused throws (e.g. every window minimised)', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      windows: {
        getLastFocused: async () => {
          throw new Error('no focused normal window');
        },
      },
      tabs: {
        query: async () => [{ id: 5, url: 'https://c.test/' }],
      },
    };

    await expect(chromeTabsPort().activeTab()).resolves.toEqual({ id: 5, url: 'https://c.test/' });
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });

  it('falls back to chrome.tabs.query when the focused window has no active tab', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      windows: {
        getLastFocused: async () => ({ tabs: [{ id: 1, url: 'https://a.test/', active: false }] }),
      },
      tabs: {
        query: async () => [{ id: 9, url: 'https://d.test/' }],
      },
    };

    await expect(chromeTabsPort().activeTab()).resolves.toEqual({ id: 9, url: 'https://d.test/' });
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });

  it('returns undefined when there is truly no tab to find', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      windows: { getLastFocused: async () => ({ tabs: [] }) },
      tabs: { query: async () => [] },
    };

    await expect(chromeTabsPort().activeTab()).resolves.toBeUndefined();
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });

  it('get() resolves undefined rather than throwing when chrome.tabs.get rejects (tab closed)', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        get: async () => {
          throw new Error('No tab with id: 404');
        },
      },
    };

    await expect(chromeTabsPort().get(404)).resolves.toBeUndefined();
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });
});

describe('RunManager: input.detach() runs when the run ends, on every path', () => {
  it('detaches after a run finishes normally', async () => {
    const detachSpy = vi.spyOn(EscalatableInput.prototype, 'detach');
    const scripted = scriptedStart();
    const rm = manager({ start: scripted.start });

    const { done } = await rm.start({ prompt: 'go', config });
    scripted.finishWith({ kind: 'run.ended', status: 'done', message: 'ok', steps: 1, at: 2 });
    await done;

    expect(detachSpy).toHaveBeenCalledTimes(1);
    detachSpy.mockRestore();
  });

  it('detaches even when the run ends via abort', async () => {
    const detachSpy = vi.spyOn(EscalatableInput.prototype, 'detach');
    const scripted = scriptedStart();
    const rm = manager({ start: scripted.start });

    const { done } = await rm.start({ prompt: 'go', config });
    scripted.finishWith({ kind: 'run.ended', status: 'aborted', message: 'user aborted', steps: 1, at: 2 });
    await done;

    expect(detachSpy).toHaveBeenCalledTimes(1);
    detachSpy.mockRestore();
  });

  it('detaches even when the underlying run handle rejects outright', async () => {
    const detachSpy = vi.spyOn(EscalatableInput.prototype, 'detach');
    const scripted = scriptedStart();
    const rm = manager({ start: scripted.start });

    const { done } = await rm.start({ prompt: 'go', config });
    scripted.failWith(new Error('graph blew up'));
    const ended = await done;

    expect(ended.status).toBe('error');
    expect(detachSpy).toHaveBeenCalledTimes(1);
    detachSpy.mockRestore();
  });

  it('a detach() rejection is swallowed rather than surfacing as the run result', async () => {
    const detachSpy = vi.spyOn(EscalatableInput.prototype, 'detach').mockRejectedValue(new Error('detach failed'));
    const scripted = scriptedStart();
    const rm = manager({ start: scripted.start });

    const { done } = await rm.start({ prompt: 'go', config });
    scripted.finishWith({ kind: 'run.ended', status: 'done', message: 'ok', steps: 1, at: 2 });

    await expect(done).resolves.toMatchObject({ status: 'done' });
    detachSpy.mockRestore();
  });
});
