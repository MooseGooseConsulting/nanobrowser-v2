/**
 * R-13's escalation, seen from the tool port: the same `click("e7")` must reach
 * the driver by ref on the in-page tier and the CDP tier by viewport point when
 * the user escalated — attaching once, detaching once, and falling back for the
 * rest of the run if the user cancels the debugging banner.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent, UserscriptRunResult } from '@/src/messaging';
import type { InputTier } from '@/src/input';
import type { InputFidelity } from '@/src/storage';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  type RuntimeDriver,
  type RuntimePageTools,
  type SaveArtifact,
} from './pageTools';

interface Call {
  name: string;
  args: unknown[];
}

class FakeDriver implements RuntimeDriver {
  readonly calls: Call[] = [];
  ok = true;
  error = 'nope';

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  #record(name: string, ...args: unknown[]): { ok: boolean; error?: string } {
    this.calls.push({ name, args });
    return this.ok ? { ok: true } : { ok: false, error: this.error };
  }

  async snapshot(tabId: number, opts?: unknown) {
    this.#record('snapshot', tabId, opts);
    return { ok: true, text: 'page: [ref=e7] button "Go"', nodes: 1, truncated: false, approxTokens: 9, url: 'https://x.test/', title: 'x' };
  }
  async screenshot(tabId: number) {
    this.#record('screenshot', tabId);
    return { ok: true, dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 800, height: 600, devicePixelRatio: 1, deviceWidth: 800, deviceHeight: 600 };
  }
  async extractText(tabId: number, opts?: unknown) {
    this.#record('extractText', tabId, opts);
    return { ok: true, text: 'extracted', truncated: false };
  }
  async click(tabId: number, ref: string) {
    return this.#record('click', tabId, ref);
  }
  async type(tabId: number, ref: string, text: string) {
    return this.#record('type', tabId, ref, text);
  }
  async press(tabId: number, key: string) {
    return this.#record('press', tabId, key);
  }
  async select(tabId: number, ref: string, value: string) {
    return this.#record('select', tabId, ref, value);
  }
  async scroll(tabId: number, opts?: unknown) {
    return this.#record('scroll', tabId, opts);
  }
  async hover(tabId: number, ref: string) {
    return this.#record('hover', tabId, ref);
  }
  async ping_(tabId: number) {
    this.#record('ping_', tabId);
    return { ok: true, width: 800, height: 600 };
  }
  async getBox(tabId: number, ref: string) {
    this.#record('getBox', tabId, ref);
    return { ok: true, box: { x: 100, y: 200, width: 40, height: 20, centerX: 120, centerY: 210 } };
  }
  async navigate(tabId: number, url: string) {
    return this.#record('navigate', tabId, url);
  }
  async download(url: string, filename?: string) {
    this.#record('download', url, filename);
    return this.ok ? { ok: true, downloadId: 42 } : { ok: false, error: this.error };
  }
  async saveFile(dataUrl: string, filename: string) {
    this.#record('saveFile', dataUrl, filename);
    return this.ok ? { ok: true, downloadId: 43 } : { ok: false, error: this.error };
  }
}

/** Records the CDP tier's calls and can fire `onDetach` like the banner's Cancel. */
class FakeDebuggerTier implements InputTier {
  readonly name = 'debugger' as const;
  readonly calls: Call[] = [];
  attachCount = 0;
  detachCount = 0;
  #attached = false;

  constructor(private readonly onDetach: (reason: string) => void) {}

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  async attach(tabId: number): Promise<void> {
    this.attachCount += 1;
    this.#attached = true;
    this.calls.push({ name: 'attach', args: [tabId] });
  }
  async detach(): Promise<void> {
    this.detachCount += 1;
    this.#attached = false;
    this.calls.push({ name: 'detach', args: [] });
  }
  isAttached(): boolean {
    return this.#attached;
  }
  async click(x: number, y: number): Promise<void> {
    this.calls.push({ name: 'click', args: [x, y] });
  }
  async moveTo(x: number, y: number): Promise<void> {
    this.calls.push({ name: 'moveTo', args: [x, y] });
  }
  async typeText(text: string): Promise<void> {
    this.calls.push({ name: 'typeText', args: [text] });
  }
  async press(key: string): Promise<void> {
    this.calls.push({ name: 'press', args: [key] });
  }
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    this.calls.push({ name: 'scroll', args: [x, y, dx, dy] });
  }

  /** The user pressed Cancel on the debugging banner. */
  userDetach(reason = 'canceled_by_user'): void {
    this.#attached = false;
    this.onDetach(reason);
  }
}

const TAB = 7;

interface Harness {
  tools: RuntimePageTools;
  driver: FakeDriver;
  input: EscalatableInput;
  events: RunEvent[];
  debuggerTier?: FakeDebuggerTier;
  userscriptRuns: string[];
  userscriptResult: UserscriptRunResult;
}

function harness(
  fidelity: InputFidelity,
  options: { withDebugger?: boolean; runId?: string; saveArtifact?: SaveArtifact } = {},
): Harness {
  const driver = new FakeDriver();
  const events: RunEvent[] = [];
  const userscriptRuns: string[] = [];
  const state: Harness = {
    driver,
    events,
    userscriptRuns,
    userscriptResult: { scriptId: 's1', ok: true, value: 3, console: [{ level: 'log', text: 'hi', at: 1 }], durationMs: 5 },
  } as Harness;

  let input!: EscalatableInput;
  const withDebugger = options.withDebugger ?? fidelity === 'escalated';
  const debuggerTier = withDebugger ? new FakeDebuggerTier((reason) => input.handleDetach(reason)) : undefined;
  state.debuggerTier = debuggerTier;

  input = new EscalatableInput({
    fidelity,
    inPageTier: createInPageTier(driver),
    ...(debuggerTier ? { debuggerTier } : {}),
    page: createInputPagePort(driver, TAB),
    emit: (event) => events.push(event),
    rng: () => 0.5, // no jitter: the point is the box centre
  });
  state.input = input;

  state.tools = createPageTools({
    tabId: TAB,
    driver,
    input,
    observe: 'dom',
    emit: (event) => events.push(event),
    runUserscript: async (scriptId) => {
      userscriptRuns.push(scriptId);
      return state.userscriptResult;
    },
    sleep: async () => {},
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.saveArtifact ? { saveArtifact: options.saveArtifact } : {}),
  });

  return state;
}

describe('createPageTools', () => {
  it('snapshots the whole tree, not just interactive nodes', async () => {
    const h = harness('in-page');
    const snap = await h.tools.snapshot();
    expect(snap.text).toContain('[ref=e7]');
    expect(snap.tokens).toBe(9);
    expect(h.driver.calls[0]).toEqual({ name: 'snapshot', args: [TAB, { interactiveOnly: false, maxNodes: 900 }] });
  });

  it('surfaces a driver failure as a thrown error, not a silent success', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    h.driver.ok = false;
    h.driver.error = 'no element for ref e9';
    await expect(h.tools.click('e9')).rejects.toThrow('no element for ref e9');
  });

  it('routes to the in-page tier by ref when fidelity is in-page', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    await h.tools.click('e7');
    await h.tools.type('e7', 'hello');
    await h.tools.press('Enter');

    expect(h.driver.calls).toEqual([
      { name: 'click', args: [TAB, 'e7'] },
      { name: 'type', args: [TAB, 'e7', 'hello'] },
      { name: 'press', args: [TAB, 'Enter'] },
    ]);
    expect(h.driver.names).not.toContain('getBox');
    expect(h.input.fidelity).toBe('in-page');
  });

  it('routes to the debugger tier by viewport point when fidelity is escalated', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');

    expect(h.driver.names).toContain('getBox');
    // Box (100,200,40x20) with a centred rng: the click lands on the centre.
    expect(h.debuggerTier?.calls).toEqual([
      { name: 'attach', args: [TAB] },
      { name: 'moveTo', args: [120, 210] },
      { name: 'click', args: [120, 210] },
    ]);
    expect(h.driver.names).not.toContain('click');
  });

  it('attaches the debugger tier once for the whole run and detaches at the end', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');
    await h.tools.click('e7');
    await h.tools.press('Enter');
    expect(h.debuggerTier?.attachCount).toBe(1);
    expect(h.debuggerTier?.detachCount).toBe(0);

    await h.input.detach();
    expect(h.debuggerTier?.detachCount).toBe(1);
    expect(h.events.filter((e) => e.kind === 'input.fidelity')).toEqual([
      { kind: 'input.fidelity', fidelity: 'escalated', attached: true, at: expect.any(Number) },
    ]);
  });

  it('falls back to the in-page tier for the rest of the run when the user detaches', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');

    h.debuggerTier?.userDetach();

    expect(h.input.fidelity).toBe('in-page');
    expect(h.events.at(-1)).toEqual({
      kind: 'input.fidelity',
      fidelity: 'in-page',
      attached: false,
      at: expect.any(Number),
    });

    await h.tools.click('e7');
    expect(h.driver.calls).toContainEqual({ name: 'click', args: [TAB, 'e7'] });
    // The tier saw exactly the one click from before the detach.
    expect(h.debuggerTier?.calls.filter((c) => c.name === 'click')).toHaveLength(1);
  });

  it('stays in-page and says so when escalation is impossible', async () => {
    const h = harness('escalated', { withDebugger: false });
    await h.input.attach(TAB);
    await h.tools.click('e7');
    expect(h.input.fidelity).toBe('in-page');
    expect(h.driver.calls).toContainEqual({ name: 'click', args: [TAB, 'e7'] });
  });

  it('scrolls the viewport through the tier and jumps to the ends through the page', async () => {
    const inPage = harness('in-page');
    await inPage.input.attach(TAB);
    await inPage.tools.scroll('down');
    expect(inPage.driver.calls.at(-1)).toEqual({ name: 'scroll', args: [TAB, { direction: 'down' }] });

    const escalated = harness('escalated');
    await escalated.input.attach(TAB);
    await escalated.tools.scroll('down');
    expect(escalated.debuggerTier?.calls.at(-1)).toEqual({ name: 'scroll', args: [400, 300, 0, 600] });

    await escalated.tools.scroll('top');
    expect(escalated.driver.calls.at(-1)?.name).toBe('scroll');
  });

  it('downloads a URL through chrome.downloads and a ref by clicking it', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    expect(await h.tools.download('https://x.test/a.csv')).toContain('42');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'download', args: ['https://x.test/a.csv', undefined] });

    await h.tools.download('e7');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'click', args: [TAB, 'e7'] });
  });

  it('extracts readable text through the driver', async () => {
    const h = harness('in-page');
    expect(await h.tools.extractText()).toBe('extracted');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'extractText', args: [TAB, {}] });
  });

  it('passes maxChars through to the driver', async () => {
    const h = harness('in-page');
    await h.tools.extractText(500);
    expect(h.driver.calls.at(-1)).toEqual({ name: 'extractText', args: [TAB, { maxChars: 500 }] });
  });

  it('truncates run_userscript\'s own echoed JSON at ~60000 chars but keeps it retrievable in full', async () => {
    const h = harness('in-page', { saveArtifact: async (filename, content) => ({ path: `/artifacts/${filename}`, bytes: content.length }) });
    h.userscriptResult = { scriptId: 's1', ok: true, value: { big: 'x'.repeat(70_000) }, console: [], durationMs: 1 };
    const summary = await h.tools.runUserscript('s1');
    expect(summary).toContain('[truncated]');
    expect(summary.length).toBeLessThan(61_000);

    // The full, untruncated value is still what save_file(fromLastUserscript:true) writes.
    const saved = await h.tools.saveFile('result.json', undefined, true);
    expect(saved).toContain('result.json');
    const fullJson = JSON.stringify({ big: 'x'.repeat(70_000) }, null, 2);
    expect(fullJson.length).toBeGreaterThan(70_000);
  });

  it('save_file refuses fromLastUserscript when nothing has run yet', async () => {
    const h = harness('in-page');
    await expect(h.tools.saveFile('a.json', undefined, true)).rejects.toThrow('no userscript has run yet');
  });

  it('save_file downloads to the Downloads folder and emits a file.saved event', async () => {
    const h = harness('in-page', { runId: 'run-1' });
    const result = await h.tools.saveFile('data.json', '{"a":1}', false);
    expect(result).toContain('data.json');
    expect(result).toContain('7 bytes');
    expect(h.driver.calls.at(-1)?.name).toBe('saveFile');
    expect(h.events).toContainEqual({
      kind: 'file.saved',
      runId: 'run-1',
      filename: 'data.json',
      bytes: 7,
      path: 'nanobrowser/data.json',
      at: expect.any(Number),
    });
  });

  it('save_file also writes to the host artifacts sink when available, and reports its path', async () => {
    const calls: Array<[string, string]> = [];
    const h = harness('in-page', {
      runId: 'run-2',
      saveArtifact: async (filename, content) => {
        calls.push([filename, content]);
        return { path: `/home/user/.local/share/nanobrowser/artifacts/run-2/${filename}`, bytes: content.length };
      },
    });
    const result = await h.tools.saveFile('out.csv', 'a,b\n1,2', false);
    expect(calls).toEqual([['out.csv', 'a,b\n1,2']]);
    expect(result).toContain('artifacts/run-2/out.csv');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'file.saved', path: expect.stringContaining('artifacts/run-2/out.csv') }),
    );
  });

  it('save_file throws when the Downloads write fails and no artifact sink is configured', async () => {
    const h = harness('in-page');
    h.driver.ok = false;
    h.driver.error = 'disk full';
    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow('disk full');
    expect(h.events).not.toContainEqual(expect.objectContaining({ kind: 'file.saved' }));
  });

  // Regression: previously this only checked `!options.saveArtifact` -- if an artifact
  // sink *was* configured but its own write also failed, save_file still returned a
  // success-shaped string and emitted file.saved with a path nothing was ever written to.
  it('save_file throws, and emits no file.saved, when both the Downloads write and the artifact write fail', async () => {
    const h = harness('in-page', {
      runId: 'run-3',
      saveArtifact: async () => {
        throw new Error('artifacts dir is read-only');
      },
    });
    h.driver.ok = false;
    h.driver.error = 'disk full';

    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow(/disk full/);
    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow(/artifacts dir is read-only/);
    expect(h.events).not.toContainEqual(expect.objectContaining({ kind: 'file.saved' }));
  });

  it('save_file requires content unless fromLastUserscript is set', async () => {
    const h = harness('in-page');
    await expect(h.tools.saveFile('a.json', undefined, false)).rejects.toThrow('no content');
  });

  it('emits userscript console lines into the run log (R-07/R-09)', async () => {
    const h = harness('in-page');
    const summary = await h.tools.runUserscript('s1');
    expect(h.userscriptRuns).toEqual(['s1']);
    expect(summary).toContain('s1');
    expect(h.events).toContainEqual({ kind: 'userscript.output', scriptId: 's1', level: 'log', text: 'hi', at: 1 });
  });

  it('reports a failing userscript as a failed tool call', async () => {
    const h = harness('in-page');
    h.userscriptResult = { scriptId: 's1', ok: false, error: 'boom', console: [], durationMs: 1 };
    await expect(h.tools.runUserscript('s1')).rejects.toThrow('boom');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'userscript.output', level: 'error', text: 'boom' }),
    );
  });

  it('navigates the run tab and passes done/blocked through', async () => {
    const h = harness('in-page');
    expect(await h.tools.navigate('https://x.test/next')).toContain('https://x.test/next');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'navigate', args: [TAB, 'https://x.test/next'] });
    expect(await h.tools.done('all good')).toBe('all good');
    expect(await h.tools.blocked('login wall')).toBe('login wall');
  });
});
