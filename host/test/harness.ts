import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CassetteStore } from '../src/cassette.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { LlmProxy, type FetchLike } from '../src/llm.ts';
import type { CassetteMode, OutboundMsg } from '../src/protocol.ts';
import { FakeSecretProvider, SecretStore } from '../src/secrets.ts';

export interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** A fetch double: no network, records every call, serves queued responses. */
export class FakeFetch {
  readonly calls: FetchCall[] = [];
  #queue: Array<(call: FetchCall) => Promise<Response> | Response> = [];

  enqueue(fn: (call: FetchCall) => Promise<Response> | Response): void {
    this.#queue.push(fn);
  }

  enqueueJson(status: number, body: unknown): void {
    this.enqueue(() => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }

  enqueueStream(status: number, chunks: Uint8Array[], headers: Record<string, string> = {}): void {
    this.enqueue(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const ch of chunks) c.enqueue(ch);
              c.close();
            },
          }),
          { status, headers },
        ),
    );
  }

  readonly fetch: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: FetchCall = { url, init, headers };
    this.calls.push(call);
    const next = this.#queue.shift();
    if (!next) throw new Error(`FakeFetch: unexpected request to ${url}`);
    return next(call);
  };
}

export interface Harness {
  dispatcher: Dispatcher;
  llm: LlmProxy;
  fetch: FakeFetch;
  sent: OutboundMsg[];
  runEvents: Array<{ runId: string; event: unknown }>;
  runsDir: string;
  cassetteDir: string;
  artifactsDir: string;
  cassettes: CassetteStore;
  cleanup: () => Promise<void>;
}

export async function makeHarness(
  opts: { key?: string | null; kiloKey?: string | null; cassetteMode?: CassetteMode } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-host-'));
  const runsDir = path.join(root, 'runs');
  const cassetteDir = path.join(root, 'cassettes');
  const artifactsDir = path.join(root, 'artifacts');
  const cassettes = new CassetteStore(cassetteDir);

  const secrets = new SecretStore(
    new FakeSecretProvider({
      OPENROUTER_API_KEY: opts.key === undefined ? 'fake-key-not-real' : opts.key,
      KILO_CODE_API_KEY: opts.kiloKey === undefined ? null : opts.kiloKey,
    }),
  );
  await secrets.load();

  const sent: OutboundMsg[] = [];
  const fetch = new FakeFetch();
  const llm = new LlmProxy({
    fetch: fetch.fetch,
    secrets,
    send: (m) => sent.push(m),
    cassetteMode: opts.cassetteMode ?? 'off',
    cassettes,
  });

  const runEvents: Array<{ runId: string; event: unknown }> = [];
  const dispatcher = new Dispatcher({
    send: (m) => sent.push(m),
    llm,
    runsDir,
    artifactsDir,
    onRunEvent: (runId, event) => runEvents.push({ runId, event }),
  });

  return {
    dispatcher,
    llm,
    fetch,
    sent,
    runEvents,
    runsDir,
    cassetteDir,
    artifactsDir,
    cassettes,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function decodeChunks(sent: OutboundMsg[], id: string): string {
  return Buffer.concat(
    sent
      .filter((m): m is Extract<OutboundMsg, { type: 'llm.chunk' }> => m.type === 'llm.chunk' && m.id === id)
      .map((m) => Buffer.from(m.bytes, 'base64')),
  ).toString('utf8');
}
