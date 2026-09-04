import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/src/messaging';
import { filterFree, findModel, formatContext, isPinned, matchesQuery, rankModels } from './models';

function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    free: false,
    vision: false,
    tools: true,
    contextLength: 128_000,
    ...over,
  };
}

const CATALOG: ModelInfo[] = [
  model('openai/gpt-5'),
  model('meta/llama-4-free', { free: true }),
  model('nvidia/nemotron-ultra', { name: 'NVIDIA Nemotron Ultra' }),
  model('anthropic/claude-opus'),
  model('nvidia/nemotron-nano-free', { name: 'NVIDIA Nemotron Nano', free: true }),
  model('mistral/small-free', { free: true }),
];

describe('rankModels', () => {
  it('pins Nemotron entries at the top, then free models, then the rest', () => {
    expect(rankModels(CATALOG).map((m) => m.id)).toEqual([
      'nvidia/nemotron-ultra',
      'nvidia/nemotron-nano-free',
      'meta/llama-4-free',
      'mistral/small-free',
      'openai/gpt-5',
      'anthropic/claude-opus',
    ]);
  });

  it('keeps the upstream order inside a rank band', () => {
    const free = rankModels(CATALOG).filter((m) => m.free && !isPinned(m));
    expect(free.map((m) => m.id)).toEqual(['meta/llama-4-free', 'mistral/small-free']);
  });

  it('filters by a case-insensitive multi-term query', () => {
    expect(rankModels(CATALOG, 'NEMO nano').map((m) => m.id)).toEqual(['nvidia/nemotron-nano-free']);
    expect(rankModels(CATALOG, 'claude').map((m) => m.id)).toEqual(['anthropic/claude-opus']);
    expect(rankModels(CATALOG, '   ')).toHaveLength(CATALOG.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(rankModels(CATALOG, 'gemini')).toEqual([]);
  });

  it('leaves the input array untouched', () => {
    const before = CATALOG.map((m) => m.id);
    rankModels(CATALOG, 'a');
    expect(CATALOG.map((m) => m.id)).toEqual(before);
  });
});

describe('helpers', () => {
  it('matches a query against id and name', () => {
    expect(matchesQuery(model('x/y', { name: 'Big Model' }), 'big')).toBe(true);
    expect(matchesQuery(model('x/y', { name: 'Big Model' }), 'x/y')).toBe(true);
    expect(matchesQuery(model('x/y', { name: 'Big Model' }), 'nope')).toBe(false);
  });

  it('finds a model by id', () => {
    expect(findModel(CATALOG, 'openai/gpt-5')?.id).toBe('openai/gpt-5');
    expect(findModel(CATALOG, 'missing')).toBeUndefined();
  });

  it('formats context length compactly', () => {
    expect(formatContext(128_000)).toBe('128K ctx');
    expect(formatContext(1_000_000)).toBe('1M ctx');
    expect(formatContext(1_500_000)).toBe('1.5M ctx');
    expect(formatContext(512)).toBe('512 ctx');
  });
});

describe('filterFree', () => {
  it('keeps only free models when on', () => {
    expect(filterFree(CATALOG, true).every((m) => m.free)).toBe(true);
    expect(filterFree(CATALOG, true)).toHaveLength(3);
  });

  it('passes every model through when off', () => {
    expect(filterFree(CATALOG, false)).toEqual(CATALOG);
  });
});
