import { describe, expect, it } from 'vitest';
import { createHostFetch, HostFetchError, type LlmClient } from './fetch';
import type { ErrorCode, LlmStreamHandlers } from './native';

interface SentRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

class FakeLlmClient implements LlmClient {
  readonly sent: SentRequest[] = [];
  readonly aborted: string[] = [];
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

  abortLlm(id: string): void {
    this.aborted.push(id);
  }

  chunk(id: string, text: string): void {
    this.#handlers.get(id)?.onChunk(btoa(text));
  }

  end(id: string, status = 200, headers: Record<string, string> = {}): void {
    this.#handlers.get(id)?.onEnd(status, headers);
  }

  error(id: string, code: ErrorCode, message: string): void {
    this.#handlers.get(id)?.onError(code, message);
  }
}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

describe('createHostFetch', () => {
  it('streams three chunks into a Response whose body concatenates them', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const resPromise = hostFetch(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
    const id = client.lastId;
    client.chunk(id, 'Hello, ');
    client.chunk(id, 'world');
    client.chunk(id, '!');
    client.end(id, 200, { 'content-type': 'application/json' });
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.text()).resolves.toBe('Hello, world!');
  });

  it('reassembles SSE chunks split mid-line', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const full = 'data: {"id":1}\n\ndata: {"id":2}\n\ndata: [DONE]\n\n';
    const resPromise = hostFetch(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [], stream: true }),
    });
    const id = client.lastId;
    // Split at offsets that do not line up with the SSE line boundaries.
    client.chunk(id, full.slice(0, 7));
    client.chunk(id, full.slice(7, 23));
    client.chunk(id, full.slice(23));
    client.end(id, 200, { 'content-type': 'text/event-stream' });
    const res = await resPromise;
    await expect(res.text()).resolves.toBe(full);
  });

  it('rejects the read on llm.error', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const resPromise = hostFetch(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
    const id = client.lastId;
    client.chunk(id, 'partial');
    client.error(id, 'upstream', 'connection reset');
    await expect(resPromise).rejects.toBeInstanceOf(HostFetchError);
    await expect(resPromise).rejects.toThrow('connection reset');
  });

  it('sends llm.abort and rejects when the request signal aborts', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const controller = new AbortController();
    const resPromise = hostFetch(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [] }),
      signal: controller.signal,
    });
    const id = client.lastId;
    controller.abort();
    expect(client.aborted).toEqual([id]);
    await expect(resPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an off-origin URL locally, without sending a message', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    await expect(hostFetch('https://evil.example.com/api/v1/chat/completions')).rejects.toThrow();
    expect(client.sent).toHaveLength(0);
  });

  it('injects provider.data_collection:"deny" when absent, never touching model', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const resPromise = hostFetch(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'nvidia/nemotron-3.5-lightning:free', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;
    expect(client.sent[0]?.body).toEqual({
      model: 'nvidia/nemotron-3.5-lightning:free',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { data_collection: 'deny' },
    });
  });

  it('leaves an existing provider block untouched', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const resPromise = hostFetch(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [], provider: { order: ['nvidia'] } }),
    });
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;
    expect(client.sent[0]?.body).toEqual({ model: 'x', messages: [], provider: { order: ['nvidia'] } });
  });

  it('never forwards a client-supplied Authorization header', async () => {
    const client = new FakeLlmClient();
    const hostFetch = createHostFetch(client);
    const resPromise = hostFetch(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer client-side-key', 'X-Foo': 'bar' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const id = client.lastId;
    client.end(id, 200, {});
    await resPromise;
    const headers = client.sent[0]?.headers ?? {};
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')).toBe(false);
    expect(Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'x-foo' && v === 'bar')).toBe(true);
  });
});
