import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { followerVisionFor } from './usePanel';

const config: Config = {
  leaderModel: 'leader',
  followerModel: 'follower',
  observe: 'pixels',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

const model = (over: Partial<ModelInfo> & { id: string }): ModelInfo => ({
  name: over.id,
  free: false,
  vision: false,
  tools: true,
  contextLength: 0,
  ...over,
});

describe('followerVisionFor', () => {
  it('returns the configured follower catalog vision flag', () => {
    const models = [model({ id: 'leader', vision: true }), model({ id: 'follower', vision: false })];
    expect(followerVisionFor(models, config)).toBe(false);
  });

  it('prefers the configured source when both gateways list the id', () => {
    const models = [
      model({ id: 'follower', vision: false, source: 'openrouter' }),
      model({ id: 'follower', vision: true, source: 'kilo' }),
    ];
    expect(followerVisionFor(models, { ...config, followerModelSource: 'kilo' })).toBe(true);
    expect(followerVisionFor(models, { ...config, followerModelSource: 'openrouter' })).toBe(false);
  });

  it('returns undefined when the catalog does not name the follower, refusing nothing', () => {
    expect(followerVisionFor([], config)).toBeUndefined();
    expect(followerVisionFor([model({ id: 'other', vision: true })], config)).toBeUndefined();
  });
});
