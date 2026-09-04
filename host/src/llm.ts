import { CassetteStore, cassetteKey, normalizePath, normalizeRequest, type CassetteEntry, type KnownOrigin } from './cassette.ts';
import { log } from './log.ts';
import { CHUNK_BYTES, KILO_BASE, OPENROUTER_BASE, type CassetteMode, type LlmRequestMsg, type OutboundMsg } from './protocol.ts';
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

const BASE_FOR: Record<KnownOrigin, string> = { openrouter: OPENROUTER_BASE, kilo: KILO_BASE };

/**
 * Resolves a request target to an absolute URL and the credentialed source it
 * belongs to (C-06/C-07 security seam: this is what picks the key, so it must
 * never guess wrong). `normalizeRequest` throws `OffOriginError` for anything
 * not on a known origin -- a relative path has no origin of its own and
 * defaults to OpenRouter, preserving every path sent before Kilo existed.
 */
export function resolveUrl(pathOrUrl: string): { url: string; source: KnownOrigin } {
  const { path, origin } = normalizeRequest(pathOrUrl);
  const source: KnownOrigin = origin ?? 'openrouter';
  const url = new URL(path, BASE_FOR[source]);
  return { url: url.toString(), source };
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

  /**
   * GET /key with the real key: validates readiness without spending a completion (R-11).
   * OpenRouter-specific -- Kilo has no documented equivalent validation endpoint, so its
   * readiness is presence-only (`SecretStore.status('kilo')`, checked wherever that
   * matters) rather than a live round trip.
   */
  async keyStatus(): Promise<{ ready: boolean; reason?: string }> {
    const key = this.deps.secrets.openRouterKey;
    if (!key) return { ready: false, reason: this.deps.secrets.missingReason ?? 'no key loaded' };
    try {
      const { url } = resolveUrl('key');
      const res = await this.deps.fetch(url, {
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

  /** GET /models for one source. Public catalog; no Authorization sent for OpenRouter. */
  async models(source: KnownOrigin = 'openrouter'): Promise<{ status: number; body: unknown }> {
    const url = new URL('models', BASE_FOR[source]).toString();
    // Kilo's catalog auth requirement is unconfirmed; attach the key when we have one
    // rather than assume it is public like OpenRouter's documented no-auth /models.
    const kiloKey = source === 'kilo' ? this.deps.secrets.key('kilo') : null;
    const res = await this.deps.fetch(url, {
      method: 'GET',
      headers: { ...this.#brandHeaders(), ...(kiloKey ? { authorization: `Bearer ${kiloKey}` } : {}) },
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

  /**
   * Fetches both catalogs in parallel and merges them into one `models.list.result`
   * body. A source that fails (network error or non-200) does not fail the whole
   * call -- the surviving source's models still come back, and `errors` names which
   * source failed and why, so the extension can say so rather than silently showing
   * half a catalog.
   */
  /**
   * Projects a provider catalog down to the fields the extension's mapper reads.
   *
   * Chrome caps a host->extension message at 1 MiB. Two full catalogs is 1.17 MB
   * -- the raw bodies carry a `description` paragraph per model -- so forwarding
   * them verbatim silently failed with "outbound message is 1167174 bytes".
   * `src/host/native.ts` only ever reads the keys kept here.
   */
  #slimCatalog(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) return body;
    const obj = body as { data?: unknown };
    if (!Array.isArray(obj.data)) return body;
    const data = obj.data.map((raw) => {
      if (typeof raw !== 'object' || raw === null) return raw;
      const m = raw as Record<string, unknown>;
      const architecture = m.architecture as { input_modalities?: unknown } | undefined;
      return {
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
        supported_parameters: m.supported_parameters,
        ...(architecture ? { architecture: { input_modalities: architecture.input_modalities } } : {}),
        ...(m.isFree !== undefined ? { isFree: m.isFree } : {}),
        ...(m.mayTrainOnYourPrompts !== undefined ? { mayTrainOnYourPrompts: m.mayTrainOnYourPrompts } : {}),
      };
    });
    return { ...obj, data };
  }

  async modelsAll(): Promise<{ status: number; body: unknown }> {
    const sources: KnownOrigin[] = ['openrouter', 'kilo'];
    const settled = await Promise.allSettled(sources.map((source) => this.models(source)));

    const catalogs: Partial<Record<KnownOrigin, { status: number; body: unknown }>> = {};
    const errors: Partial<Record<KnownOrigin, string>> = {};
    settled.forEach((result, i) => {
      const source = sources[i]!;
      if (result.status === 'fulfilled') {
        if (result.value.status === 200) {
          catalogs[source] = { status: result.value.status, body: this.#slimCatalog(result.value.body) };
        } else {
          errors[source] = `upstream status ${result.value.status}`;
        }
      } else {
        errors[source] = (result.reason as Error).message;
      }
    });

    const anyOk = Object.keys(catalogs).length > 0;
    return {
      status: anyOk ? 200 : 502,
      body: { sources: catalogs, ...(Object.keys(errors).length > 0 ? { errors } : {}) },
    };
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

    // Which credential to attach is decided by the request's own URL origin (C-06/C-07
    // security seam), never by anything the client asserts about itself -- so this
    // resolves before the key lookup, and an unrecognised origin never reaches it.
    let url: string;
    let source: KnownOrigin;
    try {
      ({ url, source } = resolveUrl(msg.url));
    } catch (err) {
      send({ type: 'llm.error', id: msg.id, code: 'bad_request', message: (err as Error).message });
      return;
    }

    const apiKey = this.deps.secrets.key(source);
    if (!apiKey) {
      const reason = this.deps.secrets.status(source).reason;
      send({
        type: 'llm.error',
        id: msg.id,
        code: 'no_key',
        message: reason ?? `no ${source} key loaded`,
      });
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
