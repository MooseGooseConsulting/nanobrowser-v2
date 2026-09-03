/**
 * Wire types for the native-messaging channel and the dev unix socket.
 * See docs/host-protocol.md for the normative description.
 */

export const HOST_NAME = 'com.nanobrowser.host';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/';
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

export interface RunStartMsg {
  type: 'run.start';
  runId: string;
  prompt: string;
  url?: string;
  options?: Record<string, unknown>;
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
  | RunStartMsg
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
  | { op: 'status' };

export type SocketResponse =
  | { op: 'accepted'; runId: string }
  | { op: 'event'; runId: string; event: unknown }
  | { op: 'end'; runId: string }
  | { op: 'status'; ok: true; extensionConnected: boolean; hostVersion: string; key: { ready: boolean; reason?: string } }
  | { op: 'error'; message: string };
