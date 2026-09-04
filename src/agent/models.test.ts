import { describe, expect, it } from 'vitest';
import { createChatModel, dataCollectionFor, DEFAULT_BASE_URL, KILO_BASE_URL } from './models';

describe('data collection policy per model', () => {
  it('allows training only for OpenRouter :free endpoints, denies for everything else', () => {
    expect(dataCollectionFor('nvidia/nemotron-3.5-lightning:free')).toBe('allow');
    expect(dataCollectionFor('deepseek/deepseek-v3.2')).toBe('deny');
  });

  it('puts the policy on the request body via modelKwargs', () => {
    const free = createChatModel({ model: 'x/y:free', fetch: globalThis.fetch, baseURL: 'https://openrouter.ai/api/v1' });
    const paid = createChatModel({ model: 'x/y', fetch: globalThis.fetch, baseURL: 'https://openrouter.ai/api/v1' });
    expect((free.modelKwargs as { provider: { data_collection: string } }).provider.data_collection).toBe('allow');
    expect((paid.modelKwargs as { provider: { data_collection: string } }).provider.data_collection).toBe('deny');
  });
});

import { hardenOpenRouterFetch } from './models';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('routing a run to the model\'s own source', () => {
  it('defaults to the OpenRouter base URL when no source is given (old stored configs)', () => {
    const model = createChatModel({ model: 'x/y', fetch: globalThis.fetch });
    expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL).toBe(DEFAULT_BASE_URL);
  });

  it('routes a Kilo-sourced model to the Kilo base URL', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL).toBe(KILO_BASE_URL);
  });

  it('never encodes the source into the model id sent to the provider', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect(model.model).toBe('meta/muse-spark-1.3-contributor');
  });

  it('omits the OpenRouter-shaped provider block entirely for a Kilo model', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect(model.modelKwargs).not.toHaveProperty('provider');
  });

  it('does not wrap a Kilo request with hardenOpenRouterFetch (no evidence Kilo needs it)', async () => {
    let calls = 0;
    const plainFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'gen-1', object: 'chat.completion' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const model = createChatModel({ model: 'x/y', fetch: plainFetch, source: 'kilo' });
    const wrapped = (model as unknown as { clientConfig: { fetch: typeof fetch } }).clientConfig.fetch;
    // hardenOpenRouterFetch would rewrite this reply to 502 (no `choices`); the plain
    // fetch used for Kilo passes it through untouched at status 200.
    const res = await wrapped('https://api.kilo.ai/api/gateway/chat/completions');
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe('hardenOpenRouterFetch', () => {
  it('passes a normal completion through untouched', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(200);
    expect((await res.json()).choices).toHaveLength(1);
  });

  it('turns an error-in-200 body into the status it names', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ error: { code: 429, message: 'rate limited' } }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toBe('rate limited');
  });

  it('turns a 200 without choices into a retryable 502', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ id: 'gen-1', object: 'chat.completion' }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(502);
  });

  it('leaves non-JSON and non-200 replies alone', async () => {
    const f = hardenOpenRouterFetch(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const res = await f('https://openrouter.ai/api/v1/models');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('nope');
  });
});
