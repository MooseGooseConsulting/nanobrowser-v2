/**
 * One run at a time, and everything a run needs assembled around it.
 *
 * The manager is the only place that knows how to turn a side-panel `Config`
 * (R-05/R-08/R-11/R-13) plus "the tab the user already has open" (R-01) into the
 * arguments `startRun` wants. It owns the fan-out of the run log (R-07): every
 * event goes to the connected panels, to the host's run-log sink, and to an
 * in-memory ring buffer that backs `runlog.replay` when the panel reopens.
 *
 * Model construction lives here because of C-07: the thing that holds the key
 * (the native host, behind `createHostFetch`) does not choose the model — the
 * panel does, separately for the Leader and the Follower (R-11).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { startRun as defaultStartRun, type RunEndedEvent, type RunHandle } from '@/src/agent/run';
import type { RunEvent, RunId } from '@/src/messaging';
import type { Config } from '@/src/storage';
import type { InputTier } from '@/src/input';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  type RunUserscript,
  type RuntimeDriver,
} from './pageTools';

/** The tab a run acts on. */
export interface TargetTab {
  id: number;
  url: string;
}

/** Tab resolution seam (R-01). Production wires this to `chrome.windows`/`chrome.tabs`. */
export interface TabsPort {
  /** The active tab of the last focused normal window. */
  activeTab(): Promise<TargetTab | undefined>;
  get(tabId: number): Promise<TargetTab | undefined>;
}

/**
 * The dev trigger's terminator (docs/host-protocol.md): the host closes a socket
 * subscriber when a run-log event's `type` is `run.end`. Our contract events are
 * keyed by `kind`, so this is a separate, host-only wire shape.
 */
export interface HostRunEndEvent {
  type: 'run.end';
  runId: string;
  status: RunEndedEvent['status'];
  message: string;
  steps: number;
  at: number;
}

/** The host's run-log sink. `HostClient` satisfies it. */
export interface RunLogSink {
  appendRunLog(runId: string, event: RunEvent | HostRunEndEvent): void;
}

export interface RunManagerDeps {
  driver: RuntimeDriver;
  tabs: TabsPort;
  host: RunLogSink;
  /** Builds a chat model for one model id (R-11: leader and follower separately). */
  createModel: (model: string) => BaseChatModel;
  /** Absent means escalation is impossible on this platform; runs stay in-page. */
  makeDebuggerTier?: (onDetach: (reason: string) => void) => InputTier;
  runUserscript: RunUserscript;
  /** Seam for tests. */
  start?: typeof defaultStartRun;
  checkpointer?: BaseCheckpointSaver;
  /** Persists `session:lastRunId` so a reopened panel can replay (R-07). */
  saveLastRunId?: (runId: RunId) => Promise<void>;
  newRunId?: () => RunId;
  now?: () => number;
  /** Events kept per run for `runlog.replay`. */
  ringSize?: number;
  /** Runs kept in the ring buffer. */
  ringRuns?: number;
}

export interface StartOptions {
  prompt: string;
  config: Config;
  /** Defaults to the active tab of the last focused normal window (R-01). */
  tabId?: number;
  /** Supplied by the dev trigger, which subscribes by run id. */
  runId?: RunId;
}

export interface StartResult {
  runId: RunId;
  /** False when the run was refused before it began; `done` still resolves. */
  ok: boolean;
  done: Promise<RunEndedEvent>;
}

export const DEFAULT_RING_SIZE = 2000;
const DEFAULT_RING_RUNS = 5;

/** Schemes a run may never touch: extension pages (the side panel itself) and browser UI. */
const REFUSED_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
];

/** Why this URL cannot be driven, or `undefined` when it can. */
export function refuseReason(url: string): string | undefined {
  const lower = url.toLowerCase();
  const scheme = REFUSED_SCHEMES.find((s) => lower.startsWith(s));
  if (!scheme) return undefined;
  if (scheme === 'chrome-extension://') {
    return `refusing to run on an extension page (${url}): open the page you want the agent to work on, then start the run`;
  }
  return `refusing to run on a browser page (${url}): ${scheme} pages cannot be scripted; open a normal web page first`;
}

interface ActiveRun {
  runId: RunId;
  handle: RunHandle;
  input: EscalatableInput;
}

export class RunManager {
  readonly #deps: RunManagerDeps;
  readonly #listeners = new Set<(runId: RunId, event: RunEvent) => void>();
  readonly #ring = new Map<RunId, RunEvent[]>();
  #active: ActiveRun | undefined;

  constructor(deps: RunManagerDeps) {
    this.#deps = deps;
  }

  /** Subscribes to every event of every run. Returns an unsubscribe. */
  onEvent(listener: (runId: RunId, event: RunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get activeRunId(): RunId | undefined {
    return this.#active?.runId;
  }

  /** Buffered events for a run, oldest first (R-07's replay). */
  replay(runId: RunId): RunEvent[] {
    return [...(this.#ring.get(runId) ?? [])];
  }

  async start(options: StartOptions): Promise<StartResult> {
    const now = this.#deps.now ?? Date.now;
    const runId = options.runId ?? (this.#deps.newRunId ?? (() => crypto.randomUUID()))();
    const { config, prompt } = options;

    if (this.#active) {
      return this.#refuse(runId, `a run is already in progress (${this.#active.runId}); abort it first`);
    }

    const tab =
      options.tabId !== undefined
        ? await this.#deps.tabs.get(options.tabId)
        : await this.#deps.tabs.activeTab();
    if (!tab) {
      return this.#refuse(runId, 'no tab to act on: open the page you want the agent to work on');
    }
    const refusal = refuseReason(tab.url);
    if (refusal) return this.#refuse(runId, refusal);

    if (!config.leaderModel || !config.followerModel) {
      return this.#refuse(
        runId,
        'no model selected: choose a Leader model and a Follower model in the side panel',
      );
    }

    // Ordering guarantee: `run.started` is the first event of every run. Anything
    // emitted while the run is being assembled (e.g. `input.fidelity` from the
    // debugger attach) is held until it has gone out.
    let started = false;
    const pending: RunEvent[] = [];
    const publish = (event: RunEvent): void => this.#publish(runId, event);
    const emit = (event: RunEvent): void => {
      if (event.kind === 'run.started') {
        started = true;
        publish(event);
        for (const held of pending.splice(0)) publish(held);
        return;
      }
      if (!started) {
        pending.push(event);
        return;
      }
      publish(event);
    };

    let input!: EscalatableInput;
    const debuggerTier =
      config.inputFidelity === 'escalated'
        ? this.#deps.makeDebuggerTier?.((reason) => input?.handleDetach(reason))
        : undefined;

    input = new EscalatableInput({
      fidelity: config.inputFidelity,
      inPageTier: createInPageTier(this.#deps.driver),
      ...(debuggerTier ? { debuggerTier } : {}),
      page: createInputPagePort(this.#deps.driver, tab.id),
      emit,
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });

    const tools = createPageTools({
      tabId: tab.id,
      driver: this.#deps.driver,
      input,
      observe: config.observe,
      runUserscript: this.#deps.runUserscript,
      emit,
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });

    let models: { leader: BaseChatModel; follower: BaseChatModel };
    try {
      // C-07: two independent handles, both proxied through the host's fetch.
      models = {
        leader: this.#deps.createModel(config.leaderModel),
        follower: this.#deps.createModel(config.followerModel),
      };
    } catch (error) {
      return this.#refuse(runId, `could not build the models: ${describe(error)}`);
    }

    try {
      await input.attach(tab.id);
    } catch (error) {
      return this.#refuse(runId, `could not attach input to the tab: ${describe(error)}`);
    }

    const start = this.#deps.start ?? defaultStartRun;
    const handle = start({
      prompt,
      config,
      tools,
      models,
      onEvent: emit,
      runId,
      tabId: tab.id,
      url: tab.url,
      ...(this.#deps.checkpointer ? { checkpointer: this.#deps.checkpointer } : {}),
    });

    this.#active = { runId, handle, input };
    void this.#deps.saveLastRunId?.(runId).catch((error: unknown) => {
      console.warn('[nanobrowser] could not persist session:lastRunId', error);
    });

    const done = handle.done
      .catch(
        (error: unknown): RunEndedEvent => ({
          kind: 'run.ended',
          status: 'error',
          message: describe(error),
          steps: 0,
          at: now(),
        }),
      )
      .then(async (ended) => {
        // R-13 hygiene: the escalated session is held for exactly one run.
        await input.detach().catch((error: unknown) => {
          console.warn('[nanobrowser] input detach failed', error);
        });
        if (this.#active?.runId === runId) this.#active = undefined;
        return ended;
      });

    return { runId, ok: true, done };
  }

  pause(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.pause();
    return true;
  }

  resume(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.resume();
    return true;
  }

  abort(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.abort();
    return true;
  }

  /** Navigates the tab the run will act on. Used by the dev trigger's `url`. */
  async navigateActiveTab(url: string): Promise<void> {
    const tab = await this.#deps.tabs.activeTab();
    if (!tab) throw new Error('no tab to navigate');
    const refusal = refuseReason(tab.url);
    if (refusal) throw new Error(refusal);
    const result = await this.#deps.driver.navigate(tab.id, url);
    if (!result.ok) throw new Error(result.error ?? `navigation to ${url} failed`);
  }

  /** The tab a run would target right now, refusal reason included. */
  async resolveTabId(): Promise<number | undefined> {
    const tab = await this.#deps.tabs.activeTab();
    if (!tab || refuseReason(tab.url)) return undefined;
    return tab.id;
  }

  #refuse(runId: RunId, message: string): StartResult {
    const now = this.#deps.now ?? Date.now;
    const ended: RunEndedEvent = {
      kind: 'run.ended',
      status: 'error',
      message,
      steps: 0,
      at: now(),
    };
    this.#publish(runId, ended);
    return { runId, ok: false, done: Promise.resolve(ended) };
  }

  #publish(runId: RunId, event: RunEvent): void {
    this.#remember(runId, event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(runId, event);
      } catch (error) {
        console.warn('[nanobrowser] run-event listener threw', error);
      }
    }
    try {
      this.#deps.host.appendRunLog(runId, event);
    } catch (error) {
      console.warn('[nanobrowser] appendRunLog failed', error);
    }
  }

  #remember(runId: RunId, event: RunEvent): void {
    const size = this.#deps.ringSize ?? DEFAULT_RING_SIZE;
    let buffer = this.#ring.get(runId);
    if (!buffer) {
      buffer = [];
      this.#ring.set(runId, buffer);
      const maxRuns = this.#deps.ringRuns ?? DEFAULT_RING_RUNS;
      while (this.#ring.size > maxRuns) {
        const oldest = this.#ring.keys().next();
        if (oldest.done) break;
        this.#ring.delete(oldest.value);
      }
    }
    buffer.push(event);
    if (buffer.length > size) buffer.splice(0, buffer.length - size);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------- */
/* Production wiring helpers                                                  */
/* ------------------------------------------------------------------------- */

/** `TabsPort` over the real `chrome.windows`/`chrome.tabs` (R-01). */
export function chromeTabsPort(): TabsPort {
  return {
    async activeTab() {
      try {
        const window = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
        const active = window.tabs?.find((tab) => tab.active);
        if (active?.id !== undefined) return { id: active.id, url: active.url ?? '' };
      } catch {
        // Fall through to the query below: no focused normal window (all minimised, say).
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) return undefined;
      return { id: tab.id, url: tab.url ?? '' };
    },
    async get(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.id === undefined) return undefined;
        return { id: tab.id, url: tab.url ?? '' };
      } catch {
        return undefined;
      }
    },
  };
}
