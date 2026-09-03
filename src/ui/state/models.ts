/**
 * Ordering and filtering for the Leader / Follower model selectors (R-11).
 * Pure so the panel's list order is testable without a DOM.
 */
import type { ModelInfo } from '@/src/messaging';

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

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((model) => model.id === id);
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}
