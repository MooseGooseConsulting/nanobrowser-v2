import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ComboboxProps<T> {
  id: string;
  label: string;
  items: T[];
  value: string;
  /** Stable identity of an item; also what `value` holds. */
  getKey: (item: T) => string;
  /** Plain-text label used in the closed state and as the option's accessible name. */
  getLabel: (item: T) => string;
  /** Rich option body. Falls back to `getLabel` when absent. */
  renderItem?: (item: T) => ReactNode;
  /** Search hook: the query is owned here so ranking stays in a pure function. */
  filter: (items: T[], query: string) => T[];
  onChange: (key: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
}

/**
 * Searchable single-select. Radix is not installed, so this is the hand-built ARIA 1.2
 * combobox: an input with `role="combobox"`, a listbox popup and `aria-activedescendant`
 * so the input keeps focus while the arrow keys move the highlight.
 */
export function Combobox<T>({
  id,
  label,
  items,
  value,
  getKey,
  getLabel,
  renderItem,
  filter,
  onChange,
  placeholder = 'Search models…',
  emptyMessage = 'No matches.',
  disabled = false,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = `${useId()}-listbox`;

  const visible = useMemo(() => filter(items, open ? query : ''), [filter, items, open, query]);
  const selected = items.find((item) => getKey(item) === value);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const commit = (item: T | undefined) => {
    if (!item) return;
    onChange(getKey(item));
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => {
        if (visible.length === 0) return 0;
        return (index + delta + visible.length) % visible.length;
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      commit(visible[active]);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setQuery('');
      setOpen(false);
    }
  };

  const activeItem = visible[active];
  const activeId = open && activeItem ? `${listboxId}-${getKey(activeItem)}` : undefined;

  return (
    <div ref={rootRef} className="relative">
      <input
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : (selected ? getLabel(selected) : '')}
        placeholder={selected ? getLabel(selected) : placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'w-full rounded-md border border-line bg-paper px-2 py-1.5 text-xs text-ink',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60',
        )}
      />
      <ul
        id={listboxId}
        role="listbox"
        aria-label={label}
        hidden={!open}
        className={cn(
          'absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-paper shadow-lg',
          !open && 'hidden',
        )}
      >
        {visible.length === 0 ? (
          <li className="px-2 py-2 text-[11px] text-muted">{emptyMessage}</li>
        ) : (
          visible.map((item, index) => {
            const key = getKey(item);
            return (
              <li
                key={key}
                id={`${listboxId}-${key}`}
                role="option"
                aria-selected={key === value}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'cursor-pointer px-2 py-1.5 text-xs',
                  index === active ? 'bg-raised' : '',
                  key === value ? 'font-semibold text-ink' : 'text-ink/90',
                )}
              >
                {renderItem ? renderItem(item) : getLabel(item)}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
