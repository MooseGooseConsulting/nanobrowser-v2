import { cn } from '../lib/cn';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/**
 * Segmented radio group. Native `<input type="radio">` under the styling, so arrow-key
 * navigation, grouping and screen-reader semantics come from the platform (R-08).
 */
export function RadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}: {
  name: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex rounded-md border border-line bg-surface p-0.5', className)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            title={option.title}
            className={cn(
              'cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors',
              'focus-within:ring-2 focus-within:ring-accent',
              checked ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
