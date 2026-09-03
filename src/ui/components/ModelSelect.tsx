import type { ModelInfo } from '@/src/messaging';
import { formatContext, rankModels } from '../state/models';
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
}: {
  id: string;
  label: string;
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
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
      filter={rankModels}
      emptyMessage={models.length === 0 ? 'Waiting for worker…' : 'No matching model.'}
      renderItem={(model) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            <span className="truncate">{model.name}</span>
            {model.free ? <Badge tone="good">free</Badge> : null}
            {model.vision ? <Badge tone="accent">vision</Badge> : null}
            {model.tools ? <Badge tone="neutral">tools</Badge> : null}
          </span>
          <span className="text-[10px] text-muted tabular-nums">
            {model.id} · {formatContext(model.contextLength)}
          </span>
        </span>
      )}
    />
  );
}
