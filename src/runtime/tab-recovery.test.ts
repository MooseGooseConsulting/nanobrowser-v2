/**
 * The two live-run infra failures this file pins:
 *
 * 1. `captureVisibleTab` stalled on a busy or hidden tab (`did not answer in
 *    20000ms`). One retry — a refresh, since the ping and the window id are
 *    resolved again — recovers the common one-off stall.
 * 2. Content-script injection against a dead tab id (`injection failed: No tab
 *    with id: N`), which killed runs when a swap escaped
 *    `chrome.tabs.onReplaced` tracking. The driver wrapper re-resolves the
 *    active tab and retries the op once against it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@/src/storage';
import { FakeChatModel } from '@/src/agent/models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import type { PageTools } from '@/src/agent/tools';
import type { ScreenshotResult, SnapshotResponse } from '@/src/page/driver';
import type { ActionResult, BoxResult } from '@/src/page/actions';
import type { ExtractTextOptions, ExtractTextResult } from '@/src/page/extractText';
import type { SnapshotOptions } from '@/src/page/snapshot';
import type { PingResult } from '@/src/page/handler';
import { currentTabId, resetTabReplacements } from '@/src/page/tabReplacement';
import {
  createPageTools,
  createInPageTier,
  createInputPagePort,
  EscalatableInput,
  isTimeoutFailure,
  rebindMissingTabDriver,
  TAB_MISSING_ERROR,
  type RuntimeDriver,
} from './pageTools';
import { RunManager, type RunManagerDeps, type TabsPort } from './runManager';

const okResult = { ok: true as const };

/* ------------------------------------------------------------------------- */
/* rebindMissingTabDriver                                                     */
/* ------------------------------------------------------------------------- */

/** Driver that records every op's tab id and can be scripted to fail. */
class RecordingDriver implements RuntimeDriver {
  readonly tabIds: number[] = [];
  readonly invalidated: number[] = [];
  /** When positive, the next op fails this many times before succeeding. */
  failNext = 0;
  error = 'No tab with id: 99';
  throwInstead = false;

  async snapshot(tabId: number, _opts?: SnapshotOptions): Promise<SnapshotResponse> {
    return (await this.op(tabId)) as SnapshotResponse;
  }
  async screenshot(tabId: number): Promise<ScreenshotResult> {
    return (await this.op(tabId)) as ScreenshotResult;
  }
  async extractText(
    tabId: number,
    _opts?: ExtractTextOptions,
  ): Promise<ActionResult & Partial<ExtractTextResult>> {
    return (await this.op(tabId)) as ActionResult & Partial<ExtractTextResult>;
  }
  async click(tabId: number, _ref: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async type(tabId: number, _ref: string, _text: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async press(tabId: number, _key: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async select(tabId: number, _ref: string, _value: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async scroll(tabId: number, _opts?: import('@/src/page/actions').ScrollOptions): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async hover(tabId: number, _ref: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async ping_(tabId: number): Promise<PingResult> {
    return (await this.op(tabId)) as PingResult;
  }
  async getBox(
    tabId: number,
    _ref: string,
  ): Promise<{ ok: boolean; error?: string; box?: { x: number; y: number; width: number; height: number; centerX: number; centerY: number } }> {
    return (await this.op(tabId)) as BoxResult;
  }
  async navigate(tabId: number, _url: string): Promise<ActionResult> {
    return (await this.op(tabId)) as ActionResult;
  }
  async download(_url: string, _filename?: string): Promise<ActionResult & { downloadId?: number }> {
    // No tab id in the signature: recorded nowhere, never remapped.
    return { ok: true };
  }
  async saveFile(_dataUrl: string, _filename: string): Promise<ActionResult & { downloadId?: number }> {
    return { ok: true };
  }
  invalidate(tabId: number): void {
    this.invalidated.push(tabId);
  }

  private op(tabId: number): Promise<unknown> {
    if (tabId !== -1) this.tabIds.push(tabId);
    if (this.failNext > 0) {
      this.failNext -= 1;
      if (this.throwInstead) throw new Error(this.error);
      return Promise.resolve({ ok: false, error: this.error });
    }
    return Promise.resolve(okResult);
  }
}

describe('rebindMissingTabDriver: "No tab with id" is a navigation event', () => {
  it('retries the op once against the re-resolved active tab', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.error = 'No tab with id: 99';
    const rebinds: Array<[number, number]> = [];
    const wrapped = rebindMissingTabDriver(driver, async () => 42, {
      onRebind: (oldId, freshId) => rebinds.push([oldId, freshId]),
    });

    const result = (await wrapped.click(99, 'e1')) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(driver.tabIds).toEqual([99, 42]);
    expect(rebinds).toEqual([[99, 42]]);
    // The dead tab's cached state goes with it.
    expect(driver.invalidated).toEqual([99]);
  });

  it('remembers the mapping: later ops skip re-resolution and aim at the fresh tab', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    let resolves = 0;
    const wrapped = rebindMissingTabDriver(driver, async () => {
      resolves += 1;
      return 42;
    });

    await wrapped.click(99, 'e1');
    await wrapped.snapshot(99);
    expect(driver.tabIds).toEqual([99, 42, 42]);
    expect(resolves).toBe(1);
  });

  it('returns the original failure when no active tab can be resolved', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.error = 'injection failed: No tab with id: 99';
    const wrapped = rebindMissingTabDriver(driver, async () => undefined);

    const result = (await wrapped.snapshot(99)) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No tab with id: 99');
    expect(driver.tabIds).toEqual([99]);
    expect(driver.invalidated).toEqual([]);
  });

  it('returns the original failure when the re-resolved id is the one that failed', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    const wrapped = rebindMissingTabDriver(driver, async () => 99);

    const result = (await wrapped.click(99, 'e1')) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(driver.tabIds).toEqual([99]);
  });

  it('rethrows the original error when the op threw and no rebind is possible', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.throwInstead = true;
    const wrapped = rebindMissingTabDriver(driver, async () => undefined);

    await expect(wrapped.click(99, 'e1')).rejects.toThrow('No tab with id: 99');
   expect(driver.tabIds).toEqual([99]);
  });

  it('propagates unrelated failures untouched, without consulting the resolver', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.error = 'the page did not answer';
    driver.throwInstead = true;
    let resolves = 0;
    const wrapped = rebindMissingTabDriver(driver, async () => {
      resolves += 1;
      return 42;
    });

    await expect(wrapped.click(7, 'e1')).rejects.toThrow('the page did not answer');
    expect(resolves).toBe(0);
  });

  it('leaves failures that are not tab-missing alone', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.error = 'element is covered by another element';
    let resolves = 0;
    const wrapped = rebindMissingTabDriver(driver, async () => {
      resolves += 1;
      return 42;
    });

    const result = (await wrapped.click(7, 'e1')) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('element is covered by another element');
    expect(resolves).toBe(0);
  });

  it('follows a chain of rebinds (99 → 42 → 43) from the original id', async () => {
    const driver = new RecordingDriver();
    driver.failNext = 1;
    driver.error = 'No tab with id: 99';
    const first = rebindMissingTabDriver(driver, async () => 42);
    await first.click(99, 'e1');

    driver.failNext = 1;
    driver.error = 'No tab with id: 42';
    const second = rebindMissingTabDriver(driver, async () => 43);
    await second.click(99, 'e1');

    expect(driver.tabIds.slice(-1)).toEqual([43]);
  });

  it('passes download and saveFile through: their first argument is not a tab id', async () => {
    const driver = new RecordingDriver();
    const wrapped = rebindMissingTabDriver(driver, async () => 42);

    await expect(wrapped.download('https://x.test/f.bin')).resolves.toMatchObject({ ok: true });
    expect(driver.tabIds).toEqual([]);
  });

  it('matches the exact Chrome rejection text through the injection path', () => {
    expect(TAB_MISSING_ERROR.test('No tab with id: 390206752')).toBe(true);
    expect(TAB_MISSING_ERROR.test('injection failed: No tab with id: 390206752')).toBe(true);
    expect(TAB_MISSING_ERROR.test('scripting.executeScript failed')).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Screenshot retry: a timeout is a stall, not a verdict                      */
/* ------------------------------------------------------------------------- */

/** Screenshot scripted per call; every other op is a plain success. */
class ScreenshotScriptDriver implements RuntimeDriver {
  /** Per call: the error to fail with, or success on `undefined`. */
  script: Array<string | undefined> = [];
  calls = 0;

  async screenshot(): Promise<{ ok: boolean; error?: string; dataUrl?: string; width: number; height: number }> {
    const error = this.script[this.calls];
    this.calls += 1;
    if (error !== undefined) return { ok: false, error, width: 0, height: 0 };
    return { ok: true, dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 800, height: 600 };
  }
  async snapshot() {
    return { ok: true, text: '', nodes: 0, truncated: false, approxTokens: 0, url: '', title: '' };
  }
  async extractText() {
    return { ok: true, text: '', truncated: false };
  }
  async click() {
    return okResult;
  }
  async type() {
    return okResult;
  }
  async press() {
    return okResult;
  }
  async select() {
    return okResult;
  }
  async scroll() {
    return okResult;
  }
  async hover() {
    return okResult;
  }
  async ping_() {
    return { ok: true, width: 800, height: 600 };
  }
  async getBox() {
    return { ok: true, box: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 } };
  }
  async navigate() {
    return okResult;
  }
  async download() {
    return okResult;
  }
  async saveFile() {
    return okResult;
  }
}

const TAB = 7;
const TIMEOUT = 'captureVisibleTab did not answer in 20000ms';

function screenshotTools(driver: RuntimeDriver) {
  return createPageTools({
    tabId: TAB,
    driver,
    input: new EscalatableInput({
      fidelity: 'in-page',
      inPageTier: createInPageTier(driver),
      page: createInputPagePort(driver, TAB),
      emit: () => {},
    }),
    observe: 'dom',
    emit: () => {},
    runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
    sleep: async () => {},
  });
}

describe('createPageTools: a timed-out captureVisibleTab is retried, not accepted', () => {
  it('retries once after a timeout and returns the refreshed capture', async () => {
    const driver = new ScreenshotScriptDriver();
    driver.script = [TIMEOUT, undefined];
    const shot = await screenshotTools(driver).screenshot();

    expect(shot.dataUrl).toBeDefined();
    expect(driver.calls).toBe(2);
  });

  it('reports the failure after the retry times out too (at most one refresh)', async () => {
    const driver = new ScreenshotScriptDriver();
    driver.script = [TIMEOUT, TIMEOUT];
    await expect(screenshotTools(driver).screenshot()).rejects.toThrow('did not answer in 20000ms');
    expect(driver.calls).toBe(2);
  });

  it('does not retry a failure that is not a timeout', async () => {
    const driver = new ScreenshotScriptDriver();
    driver.script = ['the tab has no window'];
    await expect(screenshotTools(driver).screenshot()).rejects.toThrow('the tab has no window');
    expect(driver.calls).toBe(1);
  });

  it('isTimeoutFailure matches the driver stall message, not every timeout wording', () => {
    expect(isTimeoutFailure('page op "ping" did not answer in 20000ms')).toBe(true);
    expect(isTimeoutFailure('navigation to https://x.test/ did not complete in 30000ms')).toBe(false);
    expect(isTimeoutFailure(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* RunManager wiring: the rebind wraps the run's driver                       */
/* ------------------------------------------------------------------------- */

const config: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

function tabsPort(id: number, url: string, activeTabId: () => number = () => id): TabsPort {
  return {
    activeTab: async () => ({ id: activeTabId(), url }),
    get: async (tabId) => (tabId === id ? { id, url } : undefined),
  };
}

describe('RunManager: a run whose tab died mid-op keeps going on the active tab', () => {
  beforeEach(() => resetTabReplacements());

  it('re-resolves the active tab and retries the op against it', async () => {
    const clicks: number[] = [];
    let firstClick = true;
    const driver: RuntimeDriver = {
      snapshot: async () => ({ ok: true, text: '', nodes: 0, truncated: false, approxTokens: 0, url: '', title: '' }),
      screenshot: async () => ({ ok: true, dataUrl: 'data:image/png;base64,x', width: 1, height: 1 }),
      extractText: async () => ({ ok: true, text: '', truncated: false }),
      click: async (tabId) => {
        clicks.push(tabId);
        if (firstClick) {
          firstClick = false;
          return { ok: false, error: 'No tab with id: 3' };
        }
        return okResult;
      },
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

    let capturedTools: PageTools | undefined;
    const scripted = (options: StartRunOptions): RunHandle => {
      capturedTools = options.tools;
      return {
        runId: 'run-1',
        pause: () => {},
        resume: () => {},
        abort: () => {},
        done: Promise.resolve({
          kind: 'run.ended',
          status: 'done',
          message: 'ok',
          steps: 1,
          at: 2,
        } as RunEndedEvent),
      };
    };

    const rm = new RunManager({
      driver,
      // The first resolution finds the run's (dead) tab 3; once the run
      // re-resolves, the active tab is 42.
      tabs: tabsPort(3, 'https://example.test/', () => (firstClick ? 3 : 42)),
      host: { appendRunLog: () => {} },
      createModel: (model) => new FakeChatModel({ label: model }),
      runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
      newRunId: () => 'run-1',
      start: scripted,
    } satisfies RunManagerDeps);

    const { done } = await rm.start({ prompt: 'go', config });
    void done.catch(() => {});

    // The run started on tab 3, whose id is dead: every click the tools make is
    // re-bound to the active tab (42) before it reaches the driver.
    const result = await capturedTools!.click('e1');
    expect(result).toContain('clicked e1');
    expect(clicks).toEqual([3, 42]);
    // The swap is recorded, so every other holder of the old id follows too.
    expect(currentTabId(3)).toBe(42);
  });
});
