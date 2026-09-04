import { useCallback } from 'react';
import type { ModelInfo } from '@/src/messaging';
import { filterFree, formatContext, rankModels } from '../state/models';
import { Badge } from './Badge';
import { Combobox } from './Combobox';

/**
 * One role's model picker (R-11). Leader and Follower each render their own instance
 * with their own value, so the two selections are genuinely separate.
 */
export function ModelSelect({
  id,
  label,
  models,
  value,
  onChange,
  disabled,
  freeOnly = false,
}: {
  id: string;
  label: string;
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /**
   * Hides paid models from the *dropdown*'s search results (Setup's "free only"
   * filter). `models` itself stays the full, unfiltered catalog so a stored paid
   * selection still resolves and displays normally rather than reading as "unresolved".
   */
  freeOnly?: boolean;
}) {
  const filter = useCallback(
    (items: ModelInfo[], query: string) => rankModels(filterFree(items, freeOnly), query),
    [freeOnly],
  );

  return (
    <Combobox<ModelInfo>
      id={id}
      label={label}
      items={models}
      value={value}
      onChange={onChange}
      disabled={disabled}
      getKey={(model) => model.id}
      getLabel={(model) => model.name}
      filter={filter}
      emptyMessage={models.length === 0 ? 'Waiting for worker…' : 'No matching model.'}
      unresolvedHint={(id) =>
        models.length === 0
          ? `${id} — waiting for the model list to load…`
          : `${id} — not in the loaded catalog (still saved; the list may need a reload).`
      }
      renderItem={(model) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            <span className="truncate">{model.name}</span>
            {model.free ? <Badge tone="good">free</Badge> : null}
            {model.vision ? <Badge tone="accent">vision</Badge> : null}
            {model.tools ? <Badge tone="neutral">tools</Badge> : null}
          </span>
          <span className="text-[11px] text-muted tabular-nums">
            {model.id} · {formatContext(model.contextLength)}
          </span>
        </span>
      )}
    />
  );
}
