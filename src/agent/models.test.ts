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
