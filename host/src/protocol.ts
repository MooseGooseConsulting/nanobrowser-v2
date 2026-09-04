/**
 * Wire types for the native-messaging channel and the dev unix socket.
 * See docs/host-protocol.md for the normative description.
 */

export const HOST_NAME = 'com.nanobrowser.host';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/';
/** Kilo AI Gateway: OpenAI-compatible, bearer-authed (docs/host-protocol.md). */
export const KILO_BASE = 'https://api.kilo.ai/api/gateway/';
export const CHUNK_BYTES = 64 * 1024; // 64 KiB of raw body per llm.chunk

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------------- extension -> host ---------------- */

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
  /** Path under https://openrouter.ai/api/v1, e.g. "/chat/completions". */
  url: string;
  method?: string;
  /** Never include Authorization; the host strips and supplies it. */
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

/** `save_file`'s native-messaging half: writes one Follower-produced file to disk. */
export interface ArtifactSaveMsg {
  type: 'artifact.save';
  id: string;
  runId: string;
  filename: string;
  content: string;
}

export type LogLevel = 'error' | 'warn' | 'info';
export type LogSource = 'worker' | 'panel';

/**
 * One extension-side diagnostic line. The extension redacts on the way out and the
 * host redacts again before it writes -- neither side trusts the other with a secret.
 */
export interface LogAppendMsg {
  type: 'log.append';
  id?: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  stack?: string;
  /** epoch ms, taken in the extension. */
  at: number;
}

export interface InputMsg {
  type: 'input.moveTo' | 'input.click' | 'input.typeText' | 'input.key';
  id: string;
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  name?: string;
  action?: string;
}

export type InboundMsg =
  | KeyStatusMsg
  | ModelsListMsg
  | LlmRequestMsg
  | LlmAbortMsg
  | RunLogAppendMsg
  | ArtifactSaveMsg
  | LogAppendMsg
  | InputMsg;

/* ---------------- host -> extension ---------------- */

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
  /** base64 of a slice of the raw upstream response body. */
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

export interface LogAckMsg {
  type: 'log.ack';
  id?: string;
  ok: true;
}

/**
 * Host -> extension self-reload (dev loop). The worker calls `chrome.runtime.reload()`,
 * which re-reads an unpacked extension from disk -- so a `pnpm build` needs no human
 * click on chrome://extensions.
 */
export interface ExtReloadMsg {
  type: 'ext.reload';
}

export interface InputResultMsg {
  type: 'input.result';
  id: string;
  ok: boolean;
  injector: string;
  reason?: string;
}

export interface ErrorMsg {
  type: 'error';
  id?: string;
  code: ErrorCode;
  message: string;
}

export type OutboundMsg =
  | HelloMsg
  | KeyStatusResult
  | ModelsListResult
  | LlmChunkMsg
  | LlmEndMsg
  | LlmErrorMsg
  | RunLogAckMsg
  | ArtifactSaveResultMsg
  | RunStartMsg
  | LogAckMsg
  | ExtReloadMsg
  | InputResultMsg
  | ErrorMsg;

export type ErrorCode =
  | 'bad_request'
  | 'unknown_type'
  | 'no_key'
  | 'upstream'
  | 'aborted'
  | 'cassette_miss'
  | 'io'
  | 'internal';

export type CassetteMode = 'off' | 'record' | 'replay';

/* ---------------- dev unix socket (NDJSON, not framed) ---------------- */

export type SocketRequest =
  | { op: 'run'; prompt: string; url?: string; runId?: string; options?: Record<string, unknown> }
  | { op: 'status' }
  | { op: 'reload' };

export type SocketResponse =
  | { op: 'accepted'; runId: string }
  | { op: 'event'; runId: string; event: unknown }
  | { op: 'end'; runId: string }
  | {
      op: 'status';
      ok: true;
      extensionConnected: boolean;
      hostVersion: string;
      /** This host process. nb-reload watches it change to prove a NEW host came up. */
      pid: number;
      key: { ready: boolean; reason?: string };
    }
  | { op: 'reloading'; pid: number }
  | { op: 'error'; message: string };
