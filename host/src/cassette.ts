import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cassetteDir } from './paths.ts';
import { OPENROUTER_BASE } from './protocol.ts';
import type { CassetteMode, LlmRequestMsg } from './protocol.ts';

/** Recursively key-sorted JSON so an identical request always hashes identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class OffOriginError extends Error {}

/**
 * The request path under https://openrouter.ai/api/v1/, with no leading or
 * trailing slash. An absolute URL is accepted only if it is on the OpenRouter
 * origin -- anything else throws rather than being silently rewritten, so a
 * client cannot aim the host at another host.
 */
export function normalizePath(url: string): string {
  let s = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//')) {
    const abs = new URL(s.startsWith('//') ? `https:${s}` : s);
    if (abs.origin !== new URL(OPENROUTER_BASE).origin) {
      throw new OffOriginError(`refusing to proxy off-origin url: ${abs.origin}`);
    }
    s = abs.pathname.replace(/^\/api\/v1(?=\/|$)/, '') + abs.search;
  }
  const q = s.indexOf('?');
  const query = q >= 0 ? s.slice(q) : '';
  const path = (q >= 0 ? s.slice(0, q) : s).replace(/^\/+/, '').replace(/\/+$/, '');
  return path + query;
}

/**
 * Cassette identity is (url, model, messages) only. Sampling knobs, stream flags
 * and provider preferences deliberately do not participate, so a replay still
 * matches after an unrelated request-shape tweak.
 */
export function cassetteKey(msg: Pick<LlmRequestMsg, 'url' | 'body'>): string {
  const body = (msg.body ?? {}) as Record<string, unknown>;
  const canonical = stableStringify({
    url: normalizePath(msg.url),
    model: body['model'] ?? null,
    messages: body['messages'] ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface CassetteEntry {
  key: string;
  url: string;
  model: unknown;
  status: number;
  headers: Record<string, string>;
  /** base64 slices of the raw upstream body, in order. */
  chunks: string[];
}

export function cassetteMode(env: NodeJS.ProcessEnv = process.env): CassetteMode {
  const v = env['NANOBROWSER_CASSETTE'];
  return v === 'record' || v === 'replay' ? v : 'off';
}

export class CassetteStore {
  readonly #dir: string;

  constructor(dir: string = cassetteDir()) {
    this.#dir = dir;
  }

  fileFor(key: string): string {
    return path.join(this.#dir, `${key}.json`);
  }

  async read(key: string): Promise<CassetteEntry | null> {
    try {
      return JSON.parse(await fs.readFile(this.fileFor(key), 'utf8')) as CassetteEntry;
    } catch {
      return null;
    }
  }

  async write(entry: CassetteEntry): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });
    await fs.writeFile(this.fileFor(entry.key), JSON.stringify(entry, null, 2) + '\n', 'utf8');
  }
}
