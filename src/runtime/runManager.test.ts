/**
 * The run manager's own rules: one run at a time, the tab the user already has
 * open (R-01) and never a browser page, `run.started` first, and a fan-out that
 * reaches the panels, the host run log and the replay buffer alike (R-07).
 *
 * The graph itself is not exercised here — `start` is a seam. `smoke.test.ts`
 * covers the real graph over these page tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { FakeChatModel } from '@/src/agent/models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import { saveUserscript } from '@/src/userscripts';
import {
  RunManager,
  defaultListUserscriptsForAgent,
  refuseReason,
  type RunManagerDeps,
  type TabsPort,
} from './runManager';
import type { RuntimeDriver } from './pageTools';

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

/** A scripted `startRun` seam: emits what it is told, ends when released. */
function scriptedStart(script: RunEvent[], ended: RunEndedEvent) {
  const seen: StartRunOptions[] = [];
  let release: (() => void) | undefined;
  const start = (options: StartRunOptions): RunHandle => {
    seen.push(options);
    const runId = options.runId ?? 'generated';
    options.onEvent({
      kind: 'run.started',
      runId,
      prompt: options.prompt,
      config: options.config,
      tabId: options.tabId ?? -1,
      url: options.url ?? '',
      at: 1,
    });
    for (const event of script) options.onEvent(event);
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      runId,
      pause: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
      done: gate.then(() => {
        options.onEvent(ended);
        return ended;
      }),
    };
  };
  return { start, seen, finish: () => release?.() };
}

const endedOk: RunEndedEvent = { kind: 'run.ended', status: 'done', message: 'objective complete', steps: 2, at: 9 };

function manager(overrides: Partial<RunManagerDeps> = {}): {
  runManager: RunManager;
  events: Array<[string, RunEvent]>;
  hostLog: Array<[string, unknown]>;
} {
  const events: Array<[string, RunEvent]> = [];
  const hostLog: Array<[string, unknown]> = [];
  const runManager = new RunManager({
    driver: fakeDriver(),
    tabs: tabsPort('https://example.test/'),
    host: { appendRunLog: (runId, event) => hostLog.push([runId, event]) },
    createModel: (model) => new FakeChatModel({ label: model }),
    runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
    newRunId: () => 'run-1',
    ...overrides,
  });
  runManager.onEvent((runId, event) => events.push([runId, event]));
  return { runManager, events, hostLog };
}

describe('refuseReason', () => {
  it('refuses browser pages and extension pages, and allows normal ones', () => {
    expect(refuseReason('chrome://extensions')).toContain('chrome://');
    expect(refuseReason('chrome-extension://abc/sidepanel.html')).toContain('extension page');
    expect(refuseReason('about:blank')).toBeDefined();
    expect(refuseReason('https://example.test/')).toBeUndefined();
  });
});

describe('RunManager.start', () => {
  it('refuses a chrome:// tab with a run.ended error rather than starting', async () => {
    const { runManager, events, hostLog } = manager({ tabs: tabsPort('chrome://settings') });
    const result = await runManager.start({ prompt: 'go', config });

    expect(result.ok).toBe(false);
    const ended = (await result.done) as RunEndedEvent;
    expect(ended.status).toBe('error');
    expect(ended.message).toContain('chrome://');
    expect(events).toEqual([['run-1', ended]]);
    // The refusal is in the run log too, so the panel and the host agree.
    expect(hostLog).toEqual([['run-1', ended]]);
    expect(runManager.activeRunId).toBeUndefined();
  });

  it('refuses the side panel itself', async () => {
    const { runManager } = manager({ tabs: tabsPort('chrome-extension://abcdef/sidepanel.html') });
    const ended = await (await runManager.start({ prompt: 'go', config })).done;
    expect(ended.status).toBe('error');
    expect(ended.message).toContain('extension page');
  });

  it('refuses when no model is selected (R-11)', async () => {
    const { runManager } = manager();
    const ended = await (
      await runManager.start({ prompt: 'go', config: { ...config, followerModel: '' } })
    ).done;
    expect(ended.message).toContain('choose a Leader model');
  });

  it('acts on the active tab of the last focused window and names it in run.started (R-01)', async () => {
    const scripted = scriptedStart([], endedOk);
    const { runManager, events } = manager({ start: scripted.start });
    const result = await runManager.start({ prompt: 'find the price', config });

    expect(result.ok).toBe(true);
    expect(scripted.seen[0]?.tabId).toBe(3);
    expect(scripted.seen[0]?.url).toBe('https://example.test/');
    expect(events[0]?.[1]).toMatchObject({ kind: 'run.started', tabId: 3, url: 'https://example.test/' });
    scripted.finish();
    await result.done;
  });

  it('builds the leader and the follower models separately (R-11/C-07)', async () => {
    const scripted = scriptedStart([], endedOk);
    const built: string[] = [];
    const { runManager } = manager({
      start: scripted.start,
      createModel: (model) => {
        built.push(model);
        return new FakeChatModel({ label: model });
      },
    });
    const result = await runManager.start({ prompt: 'go', config });
    expect(built).toEqual(['fake/leader', 'fake/follower']);
    scripted.finish();
    await result.done;
  });

  it('threads each role\'s stored source through to createModel, independently of the other role', async () => {
    const scripted = scriptedStart([], endedOk);
    const built: Array<[string, string | undefined]> = [];
    const { runManager } = manager({
      start: scripted.start,
      createModel: (model, source) => {
        built.push([model, source]);
        return new FakeChatModel({ label: model });
      },
    });
    const result = await runManager.start({
      prompt: 'go',
      config: { ...config, leaderModelSource: 'kilo' },
    });
    expect(built).toEqual([
      ['fake/leader', 'kilo'],
      ['fake/follower', undefined],
    ]);
    scripted.finish();
    await result.done;
  });

  it('runs one run at a time', async () => {
    const scripted = scriptedStart([], endedOk);
    const { runManager } = manager({ start: scripted.start, newRunId: () => 'run-a' });
    const first = await runManager.start({ prompt: 'one', config });
    const second = await runManager.start({ prompt: 'two', config });

    expect(second.ok).toBe(false);
    expect((await second.done).message).toContain('already in progress');
    scripted.finish();
    await first.done;

    // Once it ends, the next run is accepted.
    const third = await runManager.start({ prompt: 'three', config });
    expect(third.ok).toBe(true);
    scripted.finish();
  });

  it('emits run.started first even when the input tier speaks earlier', async () => {
    const scripted = scriptedStart([], endedOk);
    const { runManager, events } = manager({ start: scripted.start });
    const result = await runManager.start({ prompt: 'go', config });
    expect(events.map(([, e]) => e.kind)).toEqual(['run.started', 'input.fidelity']);
    scripted.finish();
    await result.done;
  });

  it('buffers events for replay and persists the run id', async () => {
    const step: RunEvent = { kind: 'step', n: 1, role: 'follower', at: 2 };
    const scripted = scriptedStart([step], endedOk);
    const saved: string[] = [];
    const { runManager, hostLog } = manager({
      start: scripted.start,
      saveLastRunId: async (runId) => {
        saved.push(runId);
      },
    });

    const result = await runManager.start({ prompt: 'go', config });
    scripted.finish();
    await result.done;

    const replayed = runManager.replay('run-1');
    expect(replayed.map((e) => e.kind)).toEqual(['run.started', 'input.fidelity', 'step', 'run.ended']);
    expect(hostLog.map(([, e]) => (e as RunEvent).kind)).toEqual(replayed.map((e) => e.kind));
    expect(saved).toEqual(['run-1']);
    expect(runManager.replay('nope')).toEqual([]);
  });

  it('keeps only the last ringSize events per run', async () => {
    const many: RunEvent[] = Array.from({ length: 5 }, (_, n) => ({ kind: 'step', n, role: 'follower', at: n }));
    const scripted = scriptedStart(many, endedOk);
    const { runManager } = manager({ start: scripted.start, ringSize: 3 });
    const result = await runManager.start({ prompt: 'go', config });
    scripted.finish();
    await result.done;
    expect(runManager.replay('run-1')).toHaveLength(3);
  });

  it('delegates pause, resume and abort to the live run only', async () => {
    const scripted = scriptedStart([], endedOk);
    const { runManager } = manager({ start: scripted.start });
    const result = await runManager.start({ prompt: 'go', config });
    expect(runManager.pause('run-1')).toBe(true);
    expect(runManager.resume('run-1')).toBe(true);
    expect(runManager.abort('other')).toBe(false);
    scripted.finish();
    await result.done;
    expect(runManager.abort('run-1')).toBe(false);
  });

  it('uses the run id the dev trigger chose', async () => {
    const scripted = scriptedStart([], endedOk);
    const { runManager, events } = manager({ start: scripted.start });
    const result = await runManager.start({ prompt: 'go', config, runId: 'run-mgh1-9f3c' });
    expect(events[0]?.[0]).toBe('run-mgh1-9f3c');
    scripted.finish();
    await result.done;
  });

  it('will not navigate a browser page for the dev trigger', async () => {
    const { runManager } = manager({ tabs: tabsPort('chrome://settings') });
    await expect(runManager.navigateActiveTab('https://x.test/')).rejects.toThrow('chrome://');
    expect(await runManager.resolveTabId()).toBeUndefined();
  });

  it('passes the tab-filtered available userscripts through to the run (R-09)', async () => {
    const scripted = scriptedStart([], endedOk);
    const listAvailableUserscripts = vi.fn(async (url: string) =>
      url.includes('ebay.com') ? [{ id: 's1', name: 'ebay-search-extract' }] : [],
    );
    const { runManager } = manager({
      start: scripted.start,
      tabs: tabsPort('https://www.ebay.com/sch/i.html?_nkw=ddr5'),
      listAvailableUserscripts,
    });
    const result = await runManager.start({ prompt: 'go', config });
    scripted.finish();
    await result.done;

    expect(listAvailableUserscripts).toHaveBeenCalledWith('https://www.ebay.com/sch/i.html?_nkw=ddr5');
    expect(scripted.seen[0]?.availableUserscripts).toEqual([{ id: 's1', name: 'ebay-search-extract' }]);
  });

  it('surfaces the bundled ebay-search-extract userscript on an eBay search page by default', async () => {
    fakeBrowser.reset();
    const scripted = scriptedStart([], endedOk);
    const { runManager } = manager({
      start: scripted.start,
      tabs: tabsPort('https://www.ebay.com/sch/i.html?_nkw=ddr5&_sacat=0&_ipg=60'),
    });
    const result = await runManager.start({ prompt: 'go', config });
    scripted.finish();
    await result.done;

    expect(scripted.seen[0]?.availableUserscripts).toContainEqual(
      expect.objectContaining({ name: 'ebay-search-extract' }),
    );
  });

  it('wires save_file to the host artifact sink when the host supports it', async () => {
    const scripted = scriptedStart([], endedOk);
    const saveArtifact = vi.fn(async (runId: string, filename: string, content: string) => ({
      path: `/artifacts/${runId}/${filename}`,
      bytes: content.length,
    }));
    const { runManager } = manager({
      start: scripted.start,
      host: { appendRunLog: () => {}, saveArtifact },
      newRunId: () => 'run-save',
    });
    await runManager.start({ prompt: 'go', config });
    scripted.finish();

    const passedTools = scripted.seen[0]?.tools;
    expect(passedTools).toBeDefined();
    const result = await passedTools!.saveFile('a.json', '{"a":1}', false);
    expect(saveArtifact).toHaveBeenCalledWith('run-save', 'a.json', '{"a":1}');
    expect(result).toContain('a.json');
    expect(result).toContain('/artifacts/run-save/a.json');
  });
});

describe('what list_userscripts may show the Follower', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  /**
   * Handing the model every id in the catalog combines with `navigate` into "go to
   * the host this script targets and run it" -- including user-written scripts that
   * the authoring rails never vetted and which may write the DOM or submit forms.
   */
  it('shows the agent its own scripts and the user\'s that already apply to the tab', async () => {
    await saveUserscript({ name: 'applies here', matches: ['*://example.com/*'], code: 'return 1;' });
    await saveUserscript({ name: 'somewhere else', matches: ['*://elsewhere.test/*'], code: 'return 2;' });
    await saveUserscript({ name: 'mine', matches: ['*://elsewhere.test/*'], code: 'return 3;', author: 'agent' });

    const visible = await defaultListUserscriptsForAgent('https://example.com/page');

    // The bundled i03 probe is there because it applies to every http/https page,
    // which is its job. The point of the assertion is what is *absent*: the user's
    // script for another host, and the two bundled examples for hyperagent and eBay.
    expect(visible.map((s) => s.name).sort()).toEqual(['applies here', 'i03-page-access', 'mine']);
    expect(visible.map((s) => s.name)).not.toContain('somewhere else');
  });
});
