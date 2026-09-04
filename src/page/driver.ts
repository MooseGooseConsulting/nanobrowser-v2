/**
 * `PageDriver` — the service worker's side of the page tier.
 *
 * It owns injection (on demand, never standing — R-02), the request/response round trip to
 * `entrypoints/injected-content.ts`, and the handful of page operations that only the worker
 * can perform: `captureVisibleTab`, `tabs.update` navigation, and downloads.
 *
 * Everything Chrome-shaped goes through the `ChromeApi` seam so tests drive a fake and the
 * real API surface stays a single, auditable adapter.
 *
 * R-13: every op this class forwards to the page is the *in-page* tier and therefore
 * `isTrusted:false`. The driver deliberately holds no `chrome.debugger` code — the trusted
 * tier is a separate escalation path that reuses `getBox()`'s viewport coordinates.
 */
import type { PageRequest, PageResponse, PingResult } from './handler';
import type { ExtractTextOptions, ExtractTextResult } from './extractText';
import type { SnapshotOptions, SnapshotResult } from './snapshot';
import type { ActionResult, BoxResult, ScrollOptions, TypeOptions } from './actions';

/** Build-output path of the unlisted script. Must match the entrypoint's file name. */
export const INJECTED_FILE = 'injected-content.js';

export interface TabUpdateInfo {
  status?: string;
}

export interface ChromeApi {
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files: string[];
    }): Promise<unknown[]>;
  };
  tabs: {
    sendMessage(tabId: number, message: PageRequest): Promise<PageResponse | undefined>;
    update(tabId: number, props: { url: string }): Promise<unknown>;
    get(tabId: number): Promise<{ windowId?: number; status?: string; url?: string }>;
    captureVisibleTab(windowId: number, options: { format: 'png' | 'jpeg' }): Promise<string>;
    onUpdated: {
      addListener(fn: (tabId: number, info: TabUpdateInfo) => void): void;
      removeListener(fn: (tabId: number, info: TabUpdateInfo) => void): void;
    };
  };
  /** Absent unless the `downloads` permission is granted. */
  downloads?: {
    download(options: {
      url: string;
      filename?: string;
      saveAs?: boolean;
      conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
    }): Promise<number>;
  };
}

/** Adapter over the real extension APIs. Only ever called from the service worker. */
export function chromeApi(): ChromeApi {
  const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
  return api;
}

export interface ScreenshotResult extends ActionResult {
  dataUrl?: string;
  /** CSS-pixel viewport, as the injected side reports it. */
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  /** Device-pixel dimensions of `dataUrl` (`width * devicePixelRatio`, rounded). */
  deviceWidth?: number;
  deviceHeight?: number;
}

export type SnapshotResponse = ActionResult & Partial<SnapshotResult>;

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PageDriver {
  private readonly api: ChromeApi;
  /** Tabs whose injected script has answered a ping at least once in this worker's life. */
  private readonly injected = new Set<number>();
  /** How long `navigate` waits for `status: 'complete'` before giving up. */
  readonly navigateTimeoutMs: number;

  constructor(api: ChromeApi = chromeApi(), options: { navigateTimeoutMs?: number } = {}) {
    this.api = api;
    this.navigateTimeoutMs = options.navigateTimeoutMs ?? 30_000;
  }

  /** Forget a tab's injection state — call on navigation, since the script does not survive it. */
  invalidate(tabId: number): void {
    this.injected.delete(tabId);
  }

  private async ping(tabId: number): Promise<PingResult | null> {
    try {
      const res = (await this.api.tabs.sendMessage(tabId, { op: 'ping' })) as PingResult | undefined;
      return res && res.ok ? res : null;
    } catch {
      // No receiver in the tab: the script is not there (or the tab is gone).
      return null;
    }
  }

  /**
   * Inject the page script if — and only if — a `ping` goes unanswered.
   *
   * `allFrames: false`: only the top frame is driven. Cross-origin subframes are reported by
   * the snapshot as opaque rather than injected into, which keeps the extension's footprint
   * to one frame per tab.
   */
  async ensureInjected(tabId: number): Promise<ActionResult> {
    if (await this.ping(tabId)) {
      this.injected.add(tabId);
      return { ok: true };
    }
    try {
      await this.api.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [INJECTED_FILE],
      });
    } catch (err) {
      return { ok: false, error: `injection failed: ${errorOf(err)}` };
    }
    if (!(await this.ping(tabId))) {
      return { ok: false, error: 'injected script did not respond to ping' };
    }
    this.injected.add(tabId);
    return { ok: true };
  }

  /** Send one op, injecting first if necessary. */
  private async send<T extends PageResponse>(tabId: number, request: PageRequest): Promise<T> {
    const ready = await this.ensureInjected(tabId);
    if (!ready.ok) return ready as T;
    try {
      const res = await this.api.tabs.sendMessage(tabId, request);
      if (!res) return { ok: false, error: 'no response from page' } as T;
      return res as T;
    } catch (err) {
      this.injected.delete(tabId);
      return { ok: false, error: errorOf(err) } as T;
    }
  }

  snapshot(tabId: number, opts: SnapshotOptions = {}): Promise<SnapshotResponse> {
    return this.send<SnapshotResponse>(tabId, { op: 'snapshot', ...opts });
  }

  extractText(tabId: number, opts: ExtractTextOptions = {}): Promise<ActionResult & Partial<ExtractTextResult>> {
    return this.send<ActionResult & Partial<ExtractTextResult>>(tabId, { op: 'extractText', ...opts });
  }

  click(tabId: number, ref: string): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'click', ref });
  }

  type(tabId: number, ref: string, text: string, opts: TypeOptions = {}): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'type', ref, text, ...opts });
  }

  press(tabId: number, key: string): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'press', key });
  }

  select(tabId: number, ref: string, value: string): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'select', ref, value });
  }

  scroll(tabId: number, opts: ScrollOptions = {}): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'scroll', ...opts });
  }

  getBox(tabId: number, ref: string): Promise<BoxResult> {
    return this.send<BoxResult>(tabId, { op: 'getBox', ref });
  }

  hover(tabId: number, ref: string): Promise<ActionResult> {
    return this.send<ActionResult>(tabId, { op: 'hover', ref });
  }

  /** Page metrics straight from the injected side (also the injection health check). */
  ping_(tabId: number): Promise<PingResult | ActionResult> {
    return this.send<PingResult>(tabId, { op: 'ping' });
  }

  /**
   * Capture the visible viewport (R-08 `pixels`/`both`).
   *
   * `captureVisibleTab` returns a device-pixel image with no dimensions attached, so the
   * CSS-pixel viewport and `devicePixelRatio` are read from the injected side and the device
   * dimensions derived — that is what lets a `[ref=eNN]` box from `getBox()` be located in
   * the screenshot.
   */
  async screenshot(tabId: number): Promise<ScreenshotResult> {
    const metrics = (await this.send<PingResult>(tabId, { op: 'ping' })) as PingResult;
    if (!metrics.ok) return { ok: false, error: metrics.error ?? 'page did not report metrics' };
    let windowId: number;
    try {
      const tab = await this.api.tabs.get(tabId);
      if (typeof tab.windowId !== 'number') return { ok: false, error: 'tab has no window' };
      windowId = tab.windowId;
    } catch (err) {
      return { ok: false, error: `tabs.get failed: ${errorOf(err)}` };
    }
    try {
      const dataUrl = await this.api.tabs.captureVisibleTab(windowId, { format: 'png' });
      const dpr = metrics.devicePixelRatio || 1;
      return {
        ok: true,
        dataUrl,
        width: metrics.width,
        height: metrics.height,
        devicePixelRatio: dpr,
        deviceWidth: Math.round(metrics.width * dpr),
        deviceHeight: Math.round(metrics.height * dpr),
      };
    } catch (err) {
      return { ok: false, error: `captureVisibleTab failed: ${errorOf(err)}` };
    }
  }

  /**
   * Navigate the tab and resolve when it reports `status: 'complete'`.
   *
   * The listener is removed on every exit path — success, timeout and throw — so nothing is
   * left attached (R-02's "leave no listeners behind" applies to the worker too). The tab's
   * injection state is dropped up front: the page script does not survive a navigation.
   */
  async navigate(tabId: number, url: string): Promise<ActionResult> {
    this.invalidate(tabId);
    const { onUpdated } = this.api.tabs;
    return new Promise<ActionResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const listener = (updatedTabId: number, info: TabUpdateInfo): void => {
        if (updatedTabId !== tabId || info.status !== 'complete') return;
        finish({ ok: true });
      };

      const finish = (result: ActionResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        onUpdated.removeListener(listener);
        resolve(result);
      };

      onUpdated.addListener(listener);
      timer = setTimeout(
        () => finish({ ok: false, error: `navigation to ${url} did not complete in ${this.navigateTimeoutMs}ms` }),
        this.navigateTimeoutMs,
      );

      this.api.tabs.update(tabId, { url }).catch((err: unknown) => {
        finish({ ok: false, error: `tabs.update failed: ${errorOf(err)}` });
      });
    });
  }

  /**
   * Start a download.
   *
   * `downloads` is NOT in the manifest today (see wxt.config.ts). Rather than editing the
   * manifest from this layer, this returns a clear error when the API is absent so the
   * omission is visible at the call site instead of silently failing.
   */
  async download(url: string, filename?: string): Promise<ActionResult & { downloadId?: number }> {
    const downloads = this.api.downloads;
    if (!downloads?.download) {
      return {
        ok: false,
        error:
          'the "downloads" permission is not granted: chrome.downloads is unavailable. ' +
          'Add "downloads" to the manifest permissions if download-as-a-tool is wanted (open item O-05).',
      };
    }
    try {
      const downloadId = await downloads.download({ url, filename, saveAs: false });
      return { ok: true, downloadId };
    } catch (err) {
      return { ok: false, error: `downloads.download failed: ${errorOf(err)}` };
    }
  }

  /**
   * `save_file`'s Downloads-folder half: a `data:` URL straight to
   * `nanobrowser/<filename>`, never overwriting an existing file (`conflictAction:
   * 'uniquify'` renames instead) and never prompting the user (`saveAs: false`).
   */
  async saveFile(dataUrl: string, filename: string): Promise<ActionResult & { downloadId?: number }> {
    const downloads = this.api.downloads;
    if (!downloads?.download) {
      return {
        ok: false,
        error: 'the "downloads" permission is not granted: chrome.downloads is unavailable.',
      };
    }
    try {
      const downloadId = await downloads.download({
        url: dataUrl,
        filename: `nanobrowser/${filename}`,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      return { ok: true, downloadId };
    } catch (err) {
      return { ok: false, error: `downloads.download failed: ${errorOf(err)}` };
    }
  }
}
