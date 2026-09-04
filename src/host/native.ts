/**
 * Service-worker-side client for the native-messaging host (docs/host-protocol.md).
 *
 * Wire types below mirror `host/src/protocol.ts` exactly (field names, message
 * shapes). They are re-declared here rather than imported: the host is a separate
 * Node program with its own tsconfig (excluded from this project's `tsc`), while
 * this file ships inside the MV3 service worker bundle.
 *
 * `NativePortApi` is the seam over `chrome.runtime.connectNative` (production:
 * `ChromeNativePort`; tests: `FakeNativePort`). `HostClient` owns the port: lazy
 * connect, reconnect-with-backoff on disconnect, a request/response correlator
 * keyed by message id, and a streaming subscription registry for `llm.*` events
 * keyed by request id.
 */
import type { ModelInfo, PanelToWorker, Readiness, RunEvent } from '@/src/messaging';
import type { ModelSource } from '@/src/storage';
import { redactEvent, redactText } from './redact';

export const HOST_NAME = 'com.nanobrowser.host';

/** Initial reconnect delay; doubles on each consecutive disconnect, capped below. */
export const INITIAL_BACKOFF_MS = 250;
/** R-11/C-06 note aside: this is purely a liveness concern, capped per the build brief. */
export const MAX_BACKOFF_MS = 30_000;

/* ---------------- wire: extension -> host ---------------- */

export interface KeyStatusMsg {
  type: 'key.status';
  id: string;
}

export interface ModelsListMsg {
  type: 'models.list';
  id: string;
}

export interface LlmRequestMsg {
  type: 'llm.request';
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface LlmAbortMsg {
  type: 'llm.abort';
  id: string;
}

export interface RunLogAppendMsg {
  type: 'runlog.append';
  id?: string;
  runId: string;
  event: unknown;
}

/** `save_file`'s native-messaging half (docs/host-protocol.md). */
export interface ArtifactSaveMsg {
  type: 'artifact.save';
  id: string;
  runId: string;
  filename: string;
  content: string;
}

/** One extension-side diagnostic line. Same shape as the panel's `log.append` payload. */
export type ExtLogEntry = PanelToWorker['log.append'];

export interface LogAppendMsg extends ExtLogEntry {
  type: 'log.append';
  id?: string;
}

export type HostRequestMsg =
  | KeyStatusMsg
  | ModelsListMsg
  | LlmRequestMsg
  | LlmAbortMsg
  | RunLogAppendMsg
  | ArtifactSaveMsg
  | LogAppendMsg;

/* ---------------- wire: host -> extension ---------------- */

export type CassetteMode = 'off' | 'record' | 'replay';

export type ErrorCode =
  | 'bad_request'
  | 'unknown_type'
  | 'no_key'
  | 'upstream'
  | 'aborted'
  | 'cassette_miss'
  | 'io'
  | 'internal';

export interface HelloMsg {
  type: 'hello';
  hostVersion: string;
  dev: boolean;
  cassette: CassetteMode;
}

export interface KeyStatusResult {
  type: 'key.status.result';
  id: string;
  ready: boolean;
  reason?: string;
}

export interface ModelsListResult {
  type: 'models.list.result';
  id: string;
  status: number;
  body: unknown;
}

export interface LlmChunkMsg {
  type: 'llm.chunk';
  id: string;
  bytes: string;
}

export interface LlmEndMsg {
  type: 'llm.end';
  id: string;
  status: number;
  headers: Record<string, string>;
}

export interface LlmErrorMsg {
  type: 'llm.error';
  id: string;
  code: ErrorCode;
  message: string;
}

export interface RunLogAckMsg {
  type: 'runlog.ack';
  id?: string;
  runId: string;
  ok: true;
}

/** Answer to `artifact.save`: where the file landed and how big it is. */
export interface ArtifactSaveResultMsg {
  type: 'artifact.save.result';
  id: string;
  runId: string;
  filename: string;
  bytes: number;
  path: string;
}

export interface RunStartMsg {
  type: 'run.start';
  runId: string;
  prompt: string;
  url?: string;
  options?: Record<string, unknown>;
}

/** Host-pushed cancellation (the dev trigger's `cancel` op). */
export interface RunAbortMsg {
  type: 'run.abort';
  runId: string;
}

export interface LogAckMsg {
  type: 'log.ack';
  id?: string;
  ok: true;
}

/** Host-pushed self-reload for the dev loop; the worker answers with `chrome.runtime.reload()`. */
export interface ExtReloadMsg {
  type: 'ext.reload';
}

export interface ErrorMsg {
  type: 'error';
  id?: string;
  code: ErrorCode;
  message: string;
}

export type HostResponseMsg =
  | HelloMsg
  | KeyStatusResult
  | ModelsListResult
  | LlmChunkMsg
  | LlmEndMsg
  | LlmErrorMsg
  | RunLogAckMsg
  | ArtifactSaveResultMsg
  | RunStartMsg
  | RunAbortMsg
  | LogAckMsg
  | ExtReloadMsg
  | ErrorMsg;

/** Rejection thrown by the correlator when the host replies with a generic `error`. */
export class HostError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

/* ---------------- NativePortApi seam ---------------- */

/** The seam over `chrome.runtime.connectNative`. `ChromeNativePort` in production, `FakeNativePort` in tests. */
export interface NativePortApi {
  postMessage(message: HostRequestMsg): void;
  onMessage(handler: (message: HostResponseMsg) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  disconnect(): void;
}

/** `NativePortApi` backed by a real `chrome.runtime.connectNative` port. Only the SW may connect. */
export class ChromeNativePort implements NativePortApi {
  private constructor(private readonly port: chrome.runtime.Port) {}

  static connect(hostName: string = HOST_NAME): ChromeNativePort {
    return new ChromeNativePort(chrome.runtime.connectNative(hostName));
  }

  postMessage(message: HostRequestMsg): void {
    this.port.postMessage(message);
  }

  onMessage(handler: (message: HostResponseMsg) => void): () => void {
    const listener = (message: unknown) => handler(message as HostResponseMsg);
    this.port.onMessage.addListener(listener);
    return () => this.port.onMessage.removeListener(listener);
  }

  onDisconnect(handler: () => void): () => void {
    const listener = () => handler();
    this.port.onDisconnect.addListener(listener);
    return () => this.port.onDisconnect.removeListener(listener);
  }

  disconnect(): void {
    this.port.disconnect();
  }
}

/** In-memory `NativePortApi` double. Records everything posted; `emit`/`disconnect` simulate the host. */
export class FakeNativePort implements NativePortApi {
  readonly sent: HostRequestMsg[] = [];
  private readonly messageHandlers = new Set<(message: HostResponseMsg) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private isDisconnected = false;

  get disconnected(): boolean {
    return this.isDisconnected;
  }

  postMessage(message: HostRequestMsg): void {
    if (this.isDisconnected) return;
    this.sent.push(message);
  }

  onMessage(handler: (message: HostResponseMsg) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  /** Simulates a message arriving from the host. */
  emit(message: HostResponseMsg): void {
    if (this.isDisconnected) return;
    for (const handler of [...this.messageHandlers]) handler(message);
  }

  /** Simulates the host process going away (crash, disable, etc). */
  disconnect(): void {
    if (this.isDisconnected) return;
    this.isDisconnected = true;
    for (const handler of [...this.disconnectHandlers]) handler();
  }
}

/* ---------------- catalog mapping: OpenRouter and Kilo share a shape ---------------- */

interface CatalogModelRaw {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown };
  supported_parameters?: unknown;
  /** Kilo-specific catalog booleans; absent on OpenRouter's shape. */
  isFree?: unknown;
  mayTrainOnYourPrompts?: unknown;
}

/**
 * Maps one catalog entry (OpenRouter's `GET /models`, or Kilo's -- both report the
 * same base fields) to the panel's `ModelInfo`, tagged with which source it came
 * from. `free` prefers Kilo's explicit `isFree` when present; otherwise (OpenRouter,
 * which reports no such field) it falls back to pricing prompt+completion being the
 * string "0", or the id ending `:free`. `vision` when `architecture.input_modalities`
 * includes "image"; `tools` when `supported_parameters` includes "tools";
 * `contextLength` from `context_length`. `mayTrainOnYourPrompts` is carried through
 * when the source reports it (Kilo) -- it is exactly the signal that explains why a
 * model that 404s on OpenRouter (whose only endpoint trains on inputs, denied by our
 * `data_collection: deny` default for paid models) can still work on Kilo.
 */
function mapCatalogModel(raw: unknown, source: ModelSource): ModelInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as CatalogModelRaw;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const pricing = r.pricing ?? {};
  const freeByPricing = pricing.prompt === '0' && pricing.completion === '0';
  const freeById = r.id.endsWith(':free');
  const free = typeof r.isFree === 'boolean' ? r.isFree : freeByPricing || freeById;

  const modalities = r.architecture?.input_modalities;
  const vision = Array.isArray(modalities) && modalities.includes('image');

  const supported = r.supported_parameters;
  const tools = Array.isArray(supported) && supported.includes('tools');

  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : r.id,
    free,
    vision,
    tools,
    contextLength: typeof r.context_length === 'number' ? r.context_length : 0,
    source,
    ...(typeof r.mayTrainOnYourPrompts === 'boolean' ? { mayTrainOnYourPrompts: r.mayTrainOnYourPrompts } : {}),
  };
}

export function mapOpenRouterModel(raw: unknown): ModelInfo | null {
  return mapCatalogModel(raw, 'openrouter');
}

export function mapKiloModel(raw: unknown): ModelInfo | null {
  return mapCatalogModel(raw, 'kilo');
}

/* ---------------- HostClient ---------------- */

/** Handlers for one in-flight `llm.request`, dispatched by request id. */
export interface LlmStreamHandlers {
  onChunk(bytes: string): void;
  onEnd(status: number, headers: Record<string, string>): void;
  onError(code: ErrorCode, message: string): void;
}

interface Pending {
  resolve: (msg: HostResponseMsg) => void;
  reject: (err: Error) => void;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Owns the one native-messaging port for the service worker's lifetime. Connects
 * lazily on first use, reconnects with exponential backoff (capped at
 * `MAX_BACKOFF_MS`) on disconnect, and resets the backoff once a fresh `hello`
 * proves the new port is talking to a live host.
 */
export class HostClient {
  #port: NativePortApi | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = INITIAL_BACKOFF_MS;
  readonly #portFactory: () => NativePortApi;
  readonly #pending = new Map<string, Pending>();
  readonly #llmStreams = new Map<string, LlmStreamHandlers>();
  readonly #runStartHandlers = new Set<(msg: RunStartMsg) => void>();
  readonly #runAbortHandlers = new Set<(msg: RunAbortMsg) => void>();
  readonly #extReloadHandlers = new Set<() => void>();

  constructor(portFactory: () => NativePortApi = () => ChromeNativePort.connect()) {
    this.#portFactory = portFactory;
  }

  /** Connects now if not already connected, cancelling any pending backoff wait. */
  connect(): void {
    if (this.#port) return;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const port = this.#portFactory();
    this.#port = port;
    port.onMessage((msg) => this.#onMessage(msg));
    port.onDisconnect(() => this.#onDisconnect());
  }

  /** Disconnects deliberately; does not auto-reconnect afterwards. */
  close(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const port = this.#port;
    this.#port = null;
    port?.disconnect();
    this.#settleAllPendingOnDisconnect();
  }

  /** `GET /key` readiness (R-11): never assumed, always the host's validated answer. */
  async keyStatus(): Promise<Readiness> {
    try {
      const res = await this.#call<KeyStatusResult>({ type: 'key.status', id: nextId() });
      return { hostConnected: true, keyReady: res.ready, ...(res.reason ? { reason: res.reason } : {}) };
    } catch (err) {
      return { hostConnected: false, keyReady: false, reason: (err as Error).message };
    }
  }

  /**
   * Both catalogs merged (host/src/llm.ts `modelsAll`), mapped to the panel's
   * `ModelInfo[]` and tagged by source. Throws only when *both* sources failed
   * (host reports that as a non-200 outer status); a single source failing is a
   * partial catalog, not a thrown error -- it is logged so the failure is still
   * visible, per "say which source failed".
   */
  async listModels(): Promise<ModelInfo[]> {
    const res = await this.#call<ModelsListResult>({ type: 'models.list', id: nextId() });
    if (res.status !== 200) {
      throw new Error(`models.list failed: upstream status ${res.status}`);
    }
    const body = res.body as {
      sources?: {
        openrouter?: { body?: { data?: unknown[] } };
        kilo?: { body?: { data?: unknown[] } };
      };
      errors?: Record<string, string>;
    };
    const models: ModelInfo[] = [];
    const openrouterData = body.sources?.openrouter?.body?.data;
    if (Array.isArray(openrouterData)) {
      for (const entry of openrouterData) {
        const mapped = mapOpenRouterModel(entry);
        if (mapped) models.push(mapped);
      }
    }
    const kiloData = body.sources?.kilo?.body?.data;
    if (Array.isArray(kiloData)) {
      for (const entry of kiloData) {
        const mapped = mapKiloModel(entry);
        if (mapped) models.push(mapped);
      }
    }
    if (body.errors) {
      for (const [source, message] of Object.entries(body.errors)) {
        console.warn(`[nanobrowser] ${source} model catalog fetch failed: ${message}`);
      }
    }
    return models;
  }

  /** Redacts then fire-and-forgets a run-log event (protocol: `id` is optional on `runlog.append`). */
  appendRunLog(runId: string, event: RunEvent): void {
    this.connect();
    this.#port?.postMessage({ type: 'runlog.append', runId, event: redactEvent(event) });
  }

  /** `save_file`'s host half: writes `content` to `artifacts/<runId>/<filename>`. Throws on failure. */
  async saveArtifact(runId: string, filename: string, content: string): Promise<{ path: string; bytes: number }> {
    const res = await this.#call<ArtifactSaveResultMsg>({ type: 'artifact.save', id: nextId(), runId, filename, content });
    return { path: res.path, bytes: res.bytes };
  }

  /**
   * Fire-and-forget diagnostic to the host's ext.log. Redacted here as well as in the
   * host: R-12 makes stripping secrets the extension's job on the way out.
   *
   * Never awaits and never throws -- this is called from an error handler, and a
   * forwarder that can fail would turn one error into two.
   */
  appendLog(entry: ExtLogEntry): void {
    try {
      this.connect();
      this.#port?.postMessage({
        type: 'log.append',
        level: entry.level,
        source: entry.source,
        message: redactText(entry.message),
        ...(entry.stack ? { stack: redactText(entry.stack) } : {}),
        at: entry.at,
      });
    } catch {
      /* the host is not reachable; the console still has the original */
    }
  }

  /** Sends `llm.abort` for a request id. Unknown ids are a silent no-op on the host side. */
  abortLlm(id: string): void {
    if (!this.#port) return;
    this.#port.postMessage({ type: 'llm.abort', id });
  }

  /**
   * Sends `llm.request` and subscribes `handlers` to `llm.chunk`/`llm.end`/`llm.error`
   * for the returned request id. The subscription is removed once a terminal
   * (`llm.end` or `llm.error`) message arrives.
   */
  sendLlmRequest(
    req: { url: string; method?: string; headers?: Record<string, string>; body?: unknown },
    handlers: LlmStreamHandlers,
  ): string {
    this.connect();
    const id = nextId();
    this.#llmStreams.set(id, handlers);
    this.#port?.postMessage({
      type: 'llm.request',
      id,
      url: req.url,
      ...(req.method ? { method: req.method } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return id;
  }

  /** Registers a handler for host-pushed `run.start` (the dev trigger). Returns an unsubscribe. */
  onRunStart(handler: (msg: RunStartMsg) => void): () => void {
    this.connect();
    this.#runStartHandlers.add(handler);
    return () => this.#runStartHandlers.delete(handler);
  }

  /** Registers a handler for host-pushed `run.abort` (the dev trigger's `cancel` op). Returns an unsubscribe. */
  onRunAbort(handler: (msg: RunAbortMsg) => void): () => void {
    this.connect();
    this.#runAbortHandlers.add(handler);
    return () => this.#runAbortHandlers.delete(handler);
  }

  /** Registers a handler for host-pushed `ext.reload` (the dev loop). Returns an unsubscribe. */
  onExtReload(handler: () => void): () => void {
    this.connect();
    this.#extReloadHandlers.add(handler);
    return () => this.#extReloadHandlers.delete(handler);
  }

  #call<T extends HostResponseMsg>(msg: HostRequestMsg & { id: string }): Promise<T> {
    this.connect();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(msg.id, { resolve: resolve as (msg: HostResponseMsg) => void, reject });
      this.#port?.postMessage(msg);
    });
  }

  #onMessage(msg: HostResponseMsg): void {
    switch (msg.type) {
      case 'hello':
        this.#backoffMs = INITIAL_BACKOFF_MS;
        return;

      case 'key.status.result':
      case 'models.list.result':
      case 'runlog.ack':
      case 'artifact.save.result': {
        const pending = msg.id ? this.#pending.get(msg.id) : undefined;
        if (pending && msg.id) {
          this.#pending.delete(msg.id);
          pending.resolve(msg);
        }
        return;
      }

      case 'error': {
        if (!msg.id) return;
        const pending = this.#pending.get(msg.id);
        if (pending) {
          this.#pending.delete(msg.id);
          pending.reject(new HostError(msg.code, msg.message));
        }
        return;
      }

      case 'llm.chunk': {
        this.#llmStreams.get(msg.id)?.onChunk(msg.bytes);
        return;
      }

      case 'llm.end': {
        const handlers = this.#llmStreams.get(msg.id);
        this.#llmStreams.delete(msg.id);
        handlers?.onEnd(msg.status, msg.headers);
        return;
      }

      case 'llm.error': {
        const handlers = this.#llmStreams.get(msg.id);
        this.#llmStreams.delete(msg.id);
        handlers?.onError(msg.code, msg.message);
        return;
      }

      case 'run.start': {
        for (const handler of [...this.#runStartHandlers]) handler(msg);
        return;
      }

      case 'run.abort': {
        for (const handler of [...this.#runAbortHandlers]) handler(msg);
        return;
      }

      case 'ext.reload': {
        for (const handler of [...this.#extReloadHandlers]) handler();
        return;
      }

      case 'log.ack':
        // Fire-and-forget on the way out; nothing is waiting on the ack.
        return;
    }
  }

  #onDisconnect(): void {
    this.#port = null;
    this.#settleAllPendingOnDisconnect();
    this.#scheduleReconnect();
  }

  #settleAllPendingOnDisconnect(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error('host disconnected'));
    this.#pending.clear();
    for (const handlers of this.#llmStreams.values()) handlers.onError('io', 'host disconnected');
    this.#llmStreams.clear();
  }

  #scheduleReconnect(): void {
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

let singleton: HostClient | undefined;

/** The service worker's one `HostClient`. Lazily constructed on first use. */
export function getHostClient(): HostClient {
  if (!singleton) singleton = new HostClient();
  return singleton;
}
