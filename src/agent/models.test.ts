import { describe, expect, it } from 'vitest';
import { createChatModel, dataCollectionFor } from './models';

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
