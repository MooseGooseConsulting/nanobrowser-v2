import { useCallback } from 'react';
import type { ModelInfo } from '@/src/messaging';
import type { ModelSource } from '@/src/storage';
import { filterFree, filterSource, formatContext, rankModels, sourceOf } from '../state/models';
import { Badge } from './Badge';
import { Combobox } from './Combobox';

/**
 * Every model id is namespaced by its source for the combobox's own identity/value,
 * so the same id from both catalogs (item 4: "keep both entries") is two distinct,
 * independently selectable options rather than a collision. `:` is a safe separator:
 * the two source names never contain one, and a model id might (e.g. a `:free`
 * suffix), so splitting on the *first* `:` always isolates the source prefix.
 */
function keyFor(model: ModelInfo): string {
  return `${sourceOf(model)}:${model.id}`;
}

function splitKey(key: string): { id: string; source: ModelSource } {
  const sep = key.indexOf(':');
  if (sep < 0) return { id: key, source: 'openrouter' };
  return { id: key.slice(sep + 1), source: key.slice(0, sep) as ModelSource };
}

/**
 * One role's model picker (R-11). Leader and Follower each render their own instance
 * with their own value, so the two selections are genuinely separate.
 */
export function ModelSelect({
  id,
  label,
  models,
  value,
  source,
  onChange,
  disabled,
  freeOnly = false,
  sourceFilter = 'all',
}: {
  id: string;
  label: string;
  models: ModelInfo[];
  value: string;
  /** The stored source for `value`, if one was recorded. Absent means OpenRouter (R-11 continuity). */
  source?: ModelSource;
  onChange: (id: string, source: ModelSource) => void;
  disabled?: boolean;
  /**
   * Hides paid models from the *dropdown*'s search results (Setup's "free only"
   * filter). `models` itself stays the full, unfiltered catalog so a stored paid
   * selection still resolves and displays normally rather than reading as "unresolved".
   */
  freeOnly?: boolean;
  /** Setup's "filter by source" control. `'all'` (the default) shows every source. */
  sourceFilter?: ModelSource | 'all';
}) {
  const filter = useCallback(
    (items: ModelInfo[], query: string) => rankModels(filterSource(filterFree(items, freeOnly), sourceFilter), query),
    [freeOnly, sourceFilter],
  );
  const compositeValue = `${source ?? 'openrouter'}:${value}`;

  return (
    <Combobox<ModelInfo>
      id={id}
      label={label}
      items={models}
      value={compositeValue}
      onChange={(key) => {
        const split = splitKey(key);
        onChange(split.id, split.source);
      }}
      disabled={disabled}
      getKey={keyFor}
      getLabel={(model) => model.name}
      formatUnresolvedValue={(key) => splitKey(key).id}
      filter={filter}
      emptyMessage={models.length === 0 ? 'Waiting for worker…' : 'No matching model.'}
      unresolvedHint={(key) => {
        const rawId = splitKey(key).id;
        return models.length === 0
          ? `${rawId} — waiting for the model list to load…`
          : `${rawId} — not in the loaded catalog (still saved; the list may need a reload).`;
      }}
      renderItem={(model) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            <span className="truncate">{model.name}</span>
            <Badge tone={sourceOf(model) === 'kilo' ? 'accent' : 'neutral'}>{sourceOf(model)}</Badge>
            {model.free ? <Badge tone="good">free</Badge> : null}
            {model.vision ? <Badge tone="accent">vision</Badge> : null}
            {model.tools ? <Badge tone="neutral">tools</Badge> : null}
            {model.mayTrainOnYourPrompts ? (
              <Badge tone="warn" title="This endpoint trains on your prompts.">
                trains on prompts
              </Badge>
            ) : null}
          </span>
          <span className="text-[11px] text-muted tabular-nums">
            {model.id} · {formatContext(model.contextLength)}
          </span>
        </span>
      )}
    />
  );
}
