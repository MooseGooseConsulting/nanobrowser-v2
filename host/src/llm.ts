import { CassetteStore, cassetteKey, normalizePath, type CassetteEntry } from './cassette.ts';
import { log } from './log.ts';
import { CHUNK_BYTES, OPENROUTER_BASE, type CassetteMode, type LlmRequestMsg, type OutboundMsg } from './protocol.ts';
import type { SecretStore } from './secrets.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LlmDeps {
  fetch: FetchLike;
  secrets: SecretStore;
  send: (msg: OutboundMsg) => void;
  cassetteMode: CassetteMode;
  cassettes: CassetteStore;
  referer?: string;
  title?: string;
}

/** Headers the client must not be able to set; the host owns them. */
const CLIENT_FORBIDDEN = new Set(['authorization', 'host', 'content-length', 'connection', 'http-referer', 'x-title']);

export function resolveUrl(pathOrUrl: string): string {
  // normalizePath throws OffOriginError on anything not on the OpenRouter origin.
  const url = new URL(normalizePath(pathOrUrl), OPENROUTER_BASE);
  if (url.origin !== new URL(OPENROUTER_BASE).origin) {
    throw new Error(`refusing to proxy off-origin url: ${url.origin}`);
  }
  return url.toString();
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export class LlmProxy {
  readonly #inflight = new Map<string, AbortController>();
  readonly deps: LlmDeps;

  constructor(deps: LlmDeps) {
    this.deps = deps;
  }

  abort(id: string): void {
    this.#inflight.get(id)?.abort();
  }

  abortAll(): void {
    for (const c of this.#inflight.values()) c.abort();
    this.#inflight.clear();
  }

  /** GET /key with the real key: validates readiness without spending a completion (R-11). */
  async keyStatus(): Promise<{ ready: boolean; reason?: string }> {
    const key = this.deps.secrets.openRouterKey;
    if (!key) return { ready: false, reason: this.deps.secrets.missingReason ?? 'no key loaded' };
    try {
      const res = await this.deps.fetch(resolveUrl('key'), {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, ...this.#brandHeaders() },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ready: false, reason: `GET /key returned ${res.status}` };
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `GET /key failed: ${(err as Error).message}` };
    }
  }

  /** GET /models. Public catalog; no Authorization needed or sent. */
  async models(): Promise<{ status: number; body: unknown }> {
    const res = await this.deps.fetch(resolveUrl('models'), {
      method: 'GET',
      headers: this.#brandHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  #brandHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': this.deps.referer ?? 'https://github.com/nanobrowser-v2',
      'X-Title': this.deps.title ?? 'nanobrowser',
    };
  }

  async request(msg: LlmRequestMsg): Promise<void> {
    const { send } = this.deps;
    let key: string;
    try {
      key = cassetteKey(msg);
    } catch (err) {
      send({ type: 'llm.error', id: msg.id, code: 'bad_request', message: (err as Error).message });
      return;
    }

    if (this.deps.cassetteMode === 'replay') {
      const entry = await this.deps.cassettes.read(key);
      if (!entry) {
        send({ type: 'llm.error', id: msg.id, code: 'cassette_miss', message: `no cassette for ${key}` });
        return;
      }
      for (const bytes of entry.chunks) send({ type: 'llm.chunk', id: msg.id, bytes });
      send({ type: 'llm.end', id: msg.id, status: entry.status, headers: entry.headers });
      return;
    }

    const apiKey = this.deps.secrets.openRouterKey;
    if (!apiKey) {
      send({
        type: 'llm.error',
        id: msg.id,
        code: 'no_key',
        message: this.deps.secrets.missingReason ?? 'no OpenRouter key loaded',
      });
      return;
    }

    let url: string;
    try {
      url = resolveUrl(msg.url);
    } catch (err) {
      send({ type: 'llm.error', id: msg.id, code: 'bad_request', message: (err as Error).message });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      if (!CLIENT_FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
    }
    if (msg.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    headers['authorization'] = `Bearer ${apiKey}`;
    Object.assign(headers, this.#brandHeaders());

    const controller = new AbortController();
    this.#inflight.set(msg.id, controller);
    const recorded: string[] = [];

    try {
      const res = await this.deps.fetch(url, {
        method: msg.method ?? (msg.body === undefined ? 'GET' : 'POST'),
        headers,
        body: msg.body === undefined ? undefined : JSON.stringify(msg.body),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          for (let off = 0; off < buf.byteLength; off += CHUNK_BYTES) {
            const bytes = buf.subarray(off, Math.min(off + CHUNK_BYTES, buf.byteLength)).toString('base64');
            if (this.deps.cassetteMode === 'record') recorded.push(bytes);
            send({ type: 'llm.chunk', id: msg.id, bytes });
          }
        }
      }

      const outHeaders = headersToObject(res.headers);
      send({ type: 'llm.end', id: msg.id, status: res.status, headers: outHeaders });

      if (this.deps.cassetteMode === 'record') {
        const entry: CassetteEntry = {
          key,
          url: normalizePath(msg.url),
          model: (msg.body as Record<string, unknown> | undefined)?.['model'] ?? null,
          status: res.status,
          headers: outHeaders,
          chunks: recorded,
        };
        await this.deps.cassettes.write(entry);
        log('info', 'cassette recorded', { key, chunks: recorded.length });
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      send({
        type: 'llm.error',
        id: msg.id,
        code: aborted ? 'aborted' : 'upstream',
        message: aborted ? 'aborted by client' : (err as Error).message,
      });
    } finally {
      this.#inflight.delete(msg.id);
    }
  }
}
