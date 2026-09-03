import { cn } from '../lib/cn';

export interface TabItem<T extends string> {
  value: T;
  label: string;
}

/**
 * Hand-built tablist with the ARIA authoring practices' roving tabindex, so Left/Right
 * move between tabs and only the selected tab is in the tab sequence.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const move = (delta: number) => {
    const index = items.findIndex((item) => item.value === value);
    const next = items[(index + delta + items.length) % items.length];
    if (next) onChange(next.value);
  };

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line px-2">
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            id={`tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(-1);
              }
            }}
            className={cn(
              '-mb-px border-b-2 px-2 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel<T extends string>({
  value,
  active,
  children,
}: {
  value: T;
  active: T;
  children: React.ReactNode;
}) {
  const selected = value === active;
  return (
    <div
      role="tabpanel"
      id={`panel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={!selected}
      className={cn('min-h-0 flex-1 flex-col', selected ? 'flex' : 'hidden')}
    >
      {selected ? children : null}
    </div>
  );
}
