/**
 * `createHostFetch(client)` returns a `fetch`-shaped function that speaks the
 * native-messaging `llm.request` / `llm.chunk*` / `llm.end`|`llm.error` protocol
 * (docs/host-protocol.md) instead of the network. This is what `ChatOpenAI` from
 * `@langchain/openai` receives via `configuration: { fetch }`, so the returned
 * `Response`'s body must reconstruct the upstream SSE stream byte-for-byte.
 *
 * Status/headers are only known to the extension once `llm.end` arrives (the host
 * defers that message until the upstream body is fully read), so the `Response`
 * this returns is only produced at that point, with its body already a fully
 * populated, closed `ReadableStream` -- correct, if not perceptibly incremental
 * to whatever reads it first.
 *
 * The common case -- a plain string JSON body, which is all `ChatOpenAI` ever
 * sends -- is handled synchronously so `sendLlmRequest` fires before this
 * function returns, matching ordinary `fetch()` call semantics. Only a bare
 * `Request` with a stream body (not the case here) needs an async body read.
 */
import type { ErrorCode, LlmStreamHandlers } from './native';

const OPENROUTER_PREFIX = 'https://openrouter.ai/api/v1/';
const KILO_PREFIX = 'https://api.kilo.ai/api/gateway/';
/** The only two model sources this proxy will forward to (docs/host-protocol.md). */
const ALLOWED_PREFIXES = [OPENROUTER_PREFIX, KILO_PREFIX];

/** Minimal surface `createHostFetch` needs from `HostClient`. */
export interface LlmClient {
  sendLlmRequest(
    req: { url: string; method?: string; headers?: Record<string, string>; body?: unknown },
    handlers: LlmStreamHandlers,
  ): string;
  abortLlm(id: string): void;
}

/** Rejection surfaced for an `llm.error` (or a locally-aborted request). */
export class HostFetchError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostFetchError';
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Injects `provider: { data_collection: "deny" }` (C-07) when the body has none. Never touches `model`. */
function withDataCollectionDeny(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  if ('provider' in obj) return obj;
  return { ...obj, provider: { data_collection: 'deny' } };
}

/**
 * Parses a request body as JSON and injects the OpenRouter privacy default; falls
 * back to the raw text if it isn't JSON. `provider` is an OpenRouter-shaped field
 * that Kilo does not use, so it is only injected for an OpenRouter-bound request.
 */
function parseBody(text: string | undefined, isOpenRouter: boolean): unknown {
  if (text === undefined || text.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return isOpenRouter ? withDataCollectionDeny(parsed) : parsed;
}

function toBodyString(body: BodyInit | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  // Non-string bodies aren't expected for this proxy's JSON-only traffic; best effort.
  return String(body);
}

function collectHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const merged = new Headers();
  if (input instanceof Request) input.headers.forEach((v, k) => merged.set(k, v));
  if (init?.headers) new Headers(init.headers).forEach((v, k) => merged.set(k, v));
  const out: Record<string, string> = {};
  merged.forEach((v, k) => {
    if (k.toLowerCase() === 'authorization') return; // R-12: the host adds this, never the extension
    out[k] = v;
  });
  return out;
}

interface Resolved {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  bodyText: string | undefined;
  /** Only set for a bare `Request` whose body must be read as a stream. */
  bodyPromise: Promise<string> | undefined;
}

function resolve(input: RequestInfo | URL, init?: RequestInit): Resolved {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : input instanceof URL ? input.toString() : input;
  const method = init?.method ?? (isRequest ? input.method : 'GET');
  const signal = init?.signal ?? (isRequest ? input.signal : undefined);
  const headers = collectHeaders(input, init);

  const hasInitBody = init !== undefined && 'body' in init && init.body !== undefined;
  if (hasInitBody) {
    return { url, method, signal, headers, bodyText: toBodyString(init?.body), bodyPromise: undefined };
  }
  if (isRequest && input.body !== null) {
    return { url, method, signal, headers, bodyText: undefined, bodyPromise: input.clone().text() };
  }
  return { url, method, signal, headers, bodyText: undefined, bodyPromise: undefined };
}

function startRequest(
  client: LlmClient,
  req: { url: string; method: string; headers: Record<string, string>; body: unknown },
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const chunks: Uint8Array[] = [];
    let settled = false;

    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);

    function settleResolve(res: Response): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(res);
    }

    function settleReject(err: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    }

    const handlers: LlmStreamHandlers = {
      onChunk(bytes) {
        if (settled) return;
        chunks.push(base64ToUint8Array(bytes));
      },
      onEnd(status, responseHeaders) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        settleResolve(new Response(stream, { status, headers: responseHeaders }));
      },
      onError(code, message) {
        settleReject(new HostFetchError(code, message));
      },
    };

    const id = client.sendLlmRequest(
      { url: req.url, method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) },
      handlers,
    );

    function onAbort(): void {
      client.abortLlm(id);
      settleReject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
  });
}

export function createHostFetch(client: LlmClient): typeof fetch {
  return function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, method, headers, signal, bodyText, bodyPromise } = resolve(input, init);

    if (!ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      return Promise.reject(new TypeError(`refusing to proxy off-origin url: ${url}`));
    }
    const isOpenRouter = url.startsWith(OPENROUTER_PREFIX);

    const start = (text: string | undefined): Promise<Response> =>
      startRequest(client, { url, method, headers, body: parseBody(text, isOpenRouter) }, signal);

    return bodyPromise ? bodyPromise.then(start) : start(bodyText);
  };
}
