/**
 * The whole loop with only the models and the browser faked: the real graph
 * (C-02), the real `startRun`, the real `createPageTools`, the real in-page
 * input tier, over a fake `PageDriver`.
 *
 * This is the test that would catch the wiring drifting apart — a tool name the
 * graph calls that the port does not implement, a driver result the tools do not
 * read, a ref that never reaches the page.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { FakeChatModel, type FakeCall, type FakeTurn } from '@/src/agent/models';
import { IndexedDBSaver } from '@/src/agent/checkpointer';
import { RunManager } from './runManager';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  type RuntimeDriver,
} from './pageTools';

const config: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

class FakePageDriver implements RuntimeDriver {
  readonly calls: Array<{ name: string; args: unknown[] }> = [];

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  #record(name: string, ...args: unknown[]): { ok: boolean; error?: string } {
    this.calls.push({ name, args });
    return { ok: true };
  }

  async snapshot(tabId: number, opts?: unknown) {
    this.#record('snapshot', tabId, opts);
    return {
      ok: true,
      text: 'document\n  button "Add to cart" [ref=e4]',
      nodes: 2,
      truncated: false,
      approxTokens: 12,
      url: 'https://shop.test/item',
      title: 'item',
    };
  }
  async screenshot(tabId: number) {
    this.#record('screenshot', tabId);
    return { ok: true, dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 1024, height: 768 };
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
    return { ok: true, width: 1024, height: 768 };
  }
  async getBox(tabId: number, ref: string) {
    this.#record('getBox', tabId, ref);
    return { ok: true, box: { x: 10, y: 20, width: 100, height: 40, centerX: 60, centerY: 40 } };
  }
  async navigate(tabId: number, url: string) {
    return this.#record('navigate', tabId, url);
  }
  async download(url: string) {
    this.#record('download', url);
    return { ok: true, downloadId: 7 };
  }
}

/** Click once, then declare the objective done: two Follower steps. */
function twoStepFollower(call: FakeCall): FakeTurn {
  return call.index === 0
    ? { kind: 'tool', name: 'click', args: { ref: 'e4', signal: 'CONTINUE', note: 'add it' } }
    : { kind: 'tool', name: 'done', args: { summary: 'added to cart', signal: 'SUBGOAL_COMPLETE' } };
}

let dbSeq = 0;

describe('a two-step run over the real graph and real page tools', () => {
  it('produces the run log the side panel renders, in order', async () => {
    const driver = new FakePageDriver();
    const events: RunEvent[] = [];
    const hostLog: RunEvent[] = [];

    const runManager = new RunManager({
      driver,
      tabs: {
        activeTab: async () => ({ id: 11, url: 'https://shop.test/item' }),
        get: async () => ({ id: 11, url: 'https://shop.test/item' }),
      },
      host: { appendRunLog: (_runId, event) => hostLog.push(event as RunEvent) },
      createModel: (model) =>
        model === config.leaderModel
          ? new FakeChatModel({
              label: 'leader',
              respond: () => ({
                kind: 'tool',
                name: 'set_plan',
                args: { plan: 'add the item to the cart', subgoals: ['click add to cart'], currentSubgoal: 0 },
              }),
            })
          : new FakeChatModel({ label: 'follower', respond: twoStepFollower }),
      runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
      checkpointer: new IndexedDBSaver({ dbName: `smoke-${dbSeq++}` }),
      newRunId: () => 'smoke-run',
    });
    runManager.onEvent((_runId, event) => events.push(event));

    const result = await runManager.start({ prompt: 'add the item to my cart', config });
    expect(result.ok).toBe(true);
    const ended = await result.done;

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'run.started',
      'input.fidelity',
      'step',
      'tool.call',
      'tool.result',
      'leader.plan',
      'handoff',
      'step',
      'observation',
      'tool.call',
      'tool.result',
      'follower.signal',
      'step',
      'observation',
      'tool.call',
      'tool.result',
      'follower.signal',
      'run.ended',
    ]);

    // The order the requirements name: the run starts, the leader plans, control
    // moves, tools are called and answered, the run ends (R-03/R-06/R-07).
    const spine = kinds.filter((kind) =>
      ['run.started', 'leader.plan', 'handoff', 'tool.call', 'tool.result', 'run.ended'].includes(kind),
    );
    expect(spine).toEqual([
      'run.started',
      'tool.call',
      'tool.result',
      'leader.plan',
      'handoff',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
      'run.ended',
    ]);

    expect(ended.status).toBe('done');
    expect(ended.steps).toBe(2);

    // The click really reached the page, by ref, through the in-page tier.
    expect(driver.calls).toContainEqual({ name: 'click', args: [11, 'e4'] });
    expect(driver.names.filter((n) => n === 'snapshot')).toHaveLength(2);
    expect(driver.names).not.toContain('getBox'); // in-page fidelity never resolves coordinates

    // Everything the panel saw, the host's run log saw too (R-07/R-12 redaction is inside the client).
    expect(hostLog.map((e) => e.kind)).toEqual(kinds);
  });

  it('reports a failing page action as a failed tool result instead of a crash', async () => {
    const driver = new FakePageDriver();
    driver.click = async (tabId: number, ref: string) => {
      driver.calls.push({ name: 'click', args: [tabId, ref] });
      return { ok: false, error: `no element for ref ${ref}` };
    };

    const events: RunEvent[] = [];
    const input = new EscalatableInput({
      fidelity: 'in-page',
      inPageTier: createInPageTier(driver),
      page: createInputPagePort(driver, 11),
      emit: (event) => events.push(event),
    });
    await input.attach(11);
    const tools = createPageTools({
      tabId: 11,
      driver,
      input,
      observe: 'dom',
      emit: (event) => events.push(event),
      runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
    });

    await expect(tools.click('e99')).rejects.toThrow('no element for ref e99');
  });
});
