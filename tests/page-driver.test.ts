import { describe, expect, it, vi } from 'vitest';
import { INJECTED_FILE, PageDriver } from '@/src/page/driver';
import type { ChromeApi, TabUpdateInfo } from '@/src/page/driver';
import type { PageRequest, PageResponse } from '@/src/page/handler';

interface Fake {
  api: ChromeApi;
  /** Every op the driver sent, in order. */
  sent: PageRequest[];
  injections: Array<{ tabId: number; allFrames?: boolean; files: string[] }>;
  updates: Array<{ tabId: number; url: string }>;
  captures: Array<{ windowId: number }>;
  downloads: Array<{ url: string; filename?: string }>;
  /** Fire `tabs.onUpdated` at every registered listener. */
  emitUpdated(tabId: number, info: TabUpdateInfo): void;
  updatedListenerCount(): number;
}

function fake(options: {
  /** Whether a page script is already present before the first injection. */
  scriptPresent?: boolean;
  withDownloads?: boolean;
  respond?: (request: PageRequest) => PageResponse | undefined;
} = {}): Fake {
  let present = options.scriptPresent ?? false;
  const sent: PageRequest[] = [];
  const injections: Fake['injections'] = [];
  const updates: Fake['updates'] = [];
  const captures: Fake['captures'] = [];
  const downloads: Fake['downloads'] = [];
  const updatedListeners: Array<(tabId: number, info: TabUpdateInfo) => void> = [];

  const api: ChromeApi = {
    scripting: {
      async executeScript(injection) {
        injections.push({
          tabId: injection.target.tabId,
          allFrames: injection.target.allFrames,
          files: injection.files,
        });
        present = true;
        return [];
      },
    },
    tabs: {
      async sendMessage(_tabId, message) {
        sent.push(message);
        if (!present) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (options.respond) return options.respond(message);
        if (message.op === 'ping') {
          return { ok: true, pong: true, url: 'https://example.test/', title: 'T', devicePixelRatio: 2, width: 800, height: 600 };
        }
        return { ok: true };
      },
      async update(tabId, props) {
        updates.push({ tabId, url: props.url });
        return {};
      },
      async get() {
        return { windowId: 7 };
      },
      async captureVisibleTab(windowId) {
        captures.push({ windowId });
        return 'data:image/png;base64,AAAA';
      },
      onUpdated: {
        addListener(fn) {
          updatedListeners.push(fn);
        },
        removeListener(fn) {
          const i = updatedListeners.indexOf(fn);
          if (i >= 0) updatedListeners.splice(i, 1);
        },
      },
    },
    ...(options.withDownloads
      ? {
          downloads: {
            async download(opts: { url: string; filename?: string }) {
              downloads.push({ url: opts.url, filename: opts.filename });
              return 99;
            },
          },
        }
      : {}),
  };

  return {
    api,
    sent,
    injections,
    updates,
    captures,
    downloads,
    emitUpdated(tabId, info) {
      for (const fn of [...updatedListeners]) fn(tabId, info);
    },
    updatedListenerCount: () => updatedListeners.length,
  };
}

describe('ensureInjected', () => {
  it('injects once when the ping fails, then never again', async () => {
    const f = fake({ scriptPresent: false });
    const driver = new PageDriver(f.api);

    expect(await driver.ensureInjected(1)).toEqual({ ok: true });
    expect(f.injections).toEqual([{ tabId: 1, allFrames: false, files: [INJECTED_FILE] }]);

    await driver.ensureInjected(1);
    await driver.ensureInjected(1);
    expect(f.injections).toHaveLength(1);
  });

  it('does not inject at all when the ping already answers', async () => {
    const f = fake({ scriptPresent: true });
    const driver = new PageDriver(f.api);
    expect(await driver.ensureInjected(1)).toEqual({ ok: true });
    expect(f.injections).toEqual([]);
    expect(f.sent).toEqual([{ op: 'ping' }]);
  });

  it('injects into the top frame only', async () => {
    const f = fake();
    await new PageDriver(f.api).ensureInjected(3);
    expect(f.injections[0]?.allFrames).toBe(false);
  });

  it('reports a failed injection', async () => {
    const f = fake();
    f.api.scripting.executeScript = async () => {
      throw new Error('Cannot access a chrome:// URL');
    };
    const result = await new PageDriver(f.api).ensureInjected(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cannot access a chrome:// URL');
  });

  it('reports a script that injects but never answers', async () => {
    const f = fake();
    f.api.scripting.executeScript = async () => [];
    expect(await new PageDriver(f.api).ensureInjected(1)).toEqual({
      ok: false,
      error: 'injected script did not respond to ping',
    });
  });

  it('re-injects after invalidate(), which navigation triggers', async () => {
    const f = fake();
    const driver = new PageDriver(f.api);
    await driver.ensureInjected(1);
    expect(f.injections).toHaveLength(1);
    driver.invalidate(1);
    await driver.ensureInjected(1);
    // The script is still live in the fake, so the ping succeeds and no second injection
    // is needed — the point is that the driver asked rather than assuming.
    expect(f.sent.filter((m) => m.op === 'ping')).toHaveLength(3);
  });
});

describe('op forwarding', () => {
  it('injects on demand before the first real op and forwards each one once', async () => {
    const f = fake();
    const driver = new PageDriver(f.api);
    await driver.snapshot(1, { interactiveOnly: true, maxNodes: 50 });
    await driver.click(1, 'e4');
    await driver.type(1, 'e5', 'text', { clear: false });
    await driver.press(1, 'Enter');
    await driver.select(1, 'e6', 'm');
    await driver.scroll(1, { direction: 'down', amount: 200 });
    await driver.getBox(1, 'e4');
    await driver.hover(1, 'e4');

    expect(f.injections).toHaveLength(1);
    expect(f.sent.filter((m) => m.op !== 'ping')).toEqual([
      { op: 'snapshot', interactiveOnly: true, maxNodes: 50 },
      { op: 'click', ref: 'e4' },
      { op: 'type', ref: 'e5', text: 'text', clear: false },
      { op: 'press', key: 'Enter' },
      { op: 'select', ref: 'e6', value: 'm' },
      { op: 'scroll', direction: 'down', amount: 200 },
      { op: 'getBox', ref: 'e4' },
      { op: 'hover', ref: 'e4' },
    ]);
  });

  it('surfaces a dropped connection as an error and forgets the injection', async () => {
    const f = fake({ scriptPresent: true });
    const driver = new PageDriver(f.api);
    await driver.ensureInjected(1);
    f.api.tabs.sendMessage = async (_tabId, message) => {
      if (message.op === 'ping') {
        return { ok: true, pong: true, url: '', title: '', devicePixelRatio: 1, width: 0, height: 0 };
      }
      throw new Error('The message port closed before a response was received.');
    };
    const result = await driver.click(1, 'e1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('message port closed');
  });

  it('reports an empty response rather than returning undefined', async () => {
    const f = fake({ scriptPresent: true, respond: (m) => (m.op === 'ping' ? { ok: true } : undefined) });
    const result = await new PageDriver(f.api).click(1, 'e1');
    expect(result).toEqual({ ok: false, error: 'no response from page' });
  });
});

describe('screenshot', () => {
  it('pairs the dataUrl with CSS and device dimensions from the injected side', async () => {
    const f = fake();
    const result = await new PageDriver(f.api).screenshot(1);
    expect(result).toEqual({
      ok: true,
      dataUrl: 'data:image/png;base64,AAAA',
      width: 800,
      height: 600,
      devicePixelRatio: 2,
      deviceWidth: 1600,
      deviceHeight: 1200,
    });
    expect(f.captures).toEqual([{ windowId: 7 }]);
  });

  it('reports a capture failure', async () => {
    const f = fake();
    f.api.tabs.captureVisibleTab = async () => {
      throw new Error('activeTab permission not in effect');
    };
    const result = await new PageDriver(f.api).screenshot(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('activeTab permission not in effect');
  });
});

describe('navigate', () => {
  it('resolves when the tab reports status complete', async () => {
    const f = fake({ scriptPresent: true });
    const driver = new PageDriver(f.api);
    const pending = driver.navigate(1, 'https://example.test/next');
    await Promise.resolve();
    expect(f.updates).toEqual([{ tabId: 1, url: 'https://example.test/next' }]);

    f.emitUpdated(1, { status: 'loading' });
    f.emitUpdated(2, { status: 'complete' }); // another tab: ignored
    f.emitUpdated(1, { status: 'complete' });

    expect(await pending).toEqual({ ok: true });
    expect(f.updatedListenerCount()).toBe(0);
  });

  it('drops the injection state so the next op re-pings', async () => {
    const f = fake({ scriptPresent: true });
    const driver = new PageDriver(f.api);
    await driver.ensureInjected(1);
    const pending = driver.navigate(1, 'https://example.test/next');
    await Promise.resolve();
    f.emitUpdated(1, { status: 'complete' });
    await pending;
    f.sent.length = 0;
    await driver.click(1, 'e1');
    expect(f.sent[0]).toEqual({ op: 'ping' });
  });

  it('times out, resolves with an error, and removes its listener', async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ scriptPresent: true });
      const driver = new PageDriver(f.api, { navigateTimeoutMs: 500 });
      const pending = driver.navigate(1, 'https://slow.test/');
      await Promise.resolve();
      vi.advanceTimersByTime(500);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('did not complete in 500ms');
      expect(f.updatedListenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed tabs.update and cleans up', async () => {
    const f = fake({ scriptPresent: true });
    f.api.tabs.update = async () => {
      throw new Error('No tab with id: 1');
    };
    const result = await new PageDriver(f.api).navigate(1, 'https://example.test/');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No tab with id: 1');
    expect(f.updatedListenerCount()).toBe(0);
  });
});

describe('download', () => {
  it('returns a clear error when the downloads permission is absent', async () => {
    const f = fake({ withDownloads: false });
    const result = await new PageDriver(f.api).download('https://example.test/f.csv');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"downloads" permission is not granted');
    expect(f.downloads).toEqual([]);
  });

  it('downloads when the API is available', async () => {
    const f = fake({ withDownloads: true });
    const result = await new PageDriver(f.api).download('https://example.test/f.csv', 'f.csv');
    expect(result).toEqual({ ok: true, downloadId: 99 });
    expect(f.downloads).toEqual([{ url: 'https://example.test/f.csv', filename: 'f.csv' }]);
  });

  it('reports a rejected download', async () => {
    const f = fake({ withDownloads: true });
    const downloads = f.api.downloads;
    if (!downloads) throw new Error('fake is missing the downloads API');
    downloads.download = async () => {
      throw new Error('Invalid URL');
    };
    const result = await new PageDriver(f.api).download('nope');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });
});
