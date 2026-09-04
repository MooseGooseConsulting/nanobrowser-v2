/**
 * Ordering and filtering for the Leader / Follower model selectors (R-11).
 * Pure so the panel's list order is testable without a DOM.
 */
import type { ModelInfo } from '@/src/messaging';
import type { ModelSource } from '@/src/storage';

/** Vendor substring pinned to the top of the list when present, per the user's ask. */
const PINNED = 'nemotron';

export function isPinned(model: ModelInfo): boolean {
  return `${model.id} ${model.name}`.toLowerCase().includes(PINNED);
}

export function matchesQuery(model: ModelInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q
    .split(/\s+/)
    .every((term) => `${model.id} ${model.name}`.toLowerCase().includes(term));
}

/**
 * Search + rank: NVIDIA Nemotron first, then free models, then everything else.
 * Ties keep the order the worker sent, so an upstream ranking is not scrambled.
 */
export function rankModels(models: ModelInfo[], query = ''): ModelInfo[] {
  const rank = (model: ModelInfo): number => (isPinned(model) ? 0 : model.free ? 1 : 2);
  return models
    .filter((model) => matchesQuery(model, query))
    .map((model, index) => ({ model, index }))
    .sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
    .map(({ model }) => model);
}

/** A `ModelInfo` with no `source` predates Kilo; treat it as OpenRouter (R-11 continuity). */
export function sourceOf(model: ModelInfo): ModelSource {
  return model.source ?? 'openrouter';
}

/**
 * Finds a model by id. The same id can exist on both sources (item 4), so a
 * `source` disambiguates which one; omitted, this returns the first match by id
 * alone (pre-Kilo behaviour, and the right fallback for a stored id whose source
 * was never recorded).
 */
export function findModel(models: ModelInfo[], id: string, source?: ModelSource): ModelInfo | undefined {
  if (source !== undefined) {
    return models.find((model) => model.id === id && sourceOf(model) === source);
  }
  return models.find((model) => model.id === id);
}

/** The Setup tab's "filter by source" control. `'all'` (the default) passes every model through. */
export function filterSource(models: ModelInfo[], source: ModelSource | 'all'): ModelInfo[] {
  return source === 'all' ? models : models.filter((model) => sourceOf(model) === source);
}

/**
 * The Setup tab's "free models only" filter (default ON — the user has authorised
 * only free OpenRouter models, the nvidia/nemotron *:free pair, as the enforced norm).
 * Pure so the default-on / paid-warns behaviour is testable without rendering anything.
 */
export function filterFree(models: ModelInfo[], freeOnly: boolean): ModelInfo[] {
  return freeOnly ? models.filter((model) => model.free) : models;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}
