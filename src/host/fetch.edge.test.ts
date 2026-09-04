/**
 * `createHostFetch`'s `input instanceof Request` branch (`resolve()` in
 * `fetch.ts`) was entirely dead in `fetch.test.ts` -- every existing test
 * calls `hostFetch(url, init)` with a plain string URL. This covers the same
 * off-origin refusal, Authorization-stripping, and body-forwarding guarantees
 * for a real `new Request(...)` argument, which is how `fetch()` may also be
 * called (and is the shape `ChatOpenAI`'s underlying HTTP client could choose,
 * depending on its transport).
 */
import { describe, expect, it } from 'vitest';
import { createHostFetch, type LlmClient } from './fetch';
import type { LlmStreamHandlers } from './native';

interface SentRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

class FakeLlmClient implements LlmClient {
  readonly sent: SentRequest[] = [];
  readonly #handlers = new Map<string, LlmStreamHandlers>();
  #n = 0;
  lastId = '';

  sendLlmRequest(req: SentRequest, handlers: LlmStreamHandlers): string {
    this.#n += 1;
    const id = `req-${this.#n}`;
    this.lastId = id;
    this.sent.push(req);
    this.#handlers.set(id, handlers);
    return id;
  }

  abortLlm(): void {}

  end(id: string, status = 200, headers: Record<string, string> = {}): void {
    this.#handlers.get(id)?.onEnd(status, headers);
  }
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

describe('createHostFetch: called with a real Request instance', () => {
  it('never forwards a client-supplied Authorization header from a Request', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const req = new Request(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-side-key', 'X-Foo': 'bar' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });

    const resPromise = hostFetch(req);
    await new Promise((r) => setTimeout(r, 0)); // let the Request body clone/read microtasks settle
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;

    const headers = client.sent[0]?.headers ?? {};
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')).toBe(false);
    expect(Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'x-foo' && v === 'bar')).toBe(true);
  });

  it('rejects an off-origin Request locally, without sending a message', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const req = new Request('https://evil.example.com/api/v1/chat/completions');

    await expect(hostFetch(req)).rejects.toThrow();
    expect(client.sent).toHaveLength(0);
  });

  it('reads the body off a Request whose body was not set via init, and injects the privacy default', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const req = new Request(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const resPromise = hostFetch(req);
    await new Promise((r) => setTimeout(r, 0)); // let the Request body clone/read microtasks settle
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;

    expect(client.sent[0]?.body).toEqual({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { data_collection: 'deny' },
    });
  });

  it('forwards the method from the Request itself', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const req = new Request(CHAT_URL, { method: 'POST', body: '{}' });

    const resPromise = hostFetch(req);
    await new Promise((r) => setTimeout(r, 0)); // let the Request body clone/read microtasks settle
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;

    expect(client.sent[0]?.method).toBe('POST');
  });
});
