import { cn } from '../lib/cn';

/**
 * Integer input with inline validation. Out-of-range values are shown but never
 * committed, so `planningInterval` / `maxSteps` (R-04) cannot be persisted invalid.
 */
export function NumberField({
  id,
  value,
  min,
  max,
  onChange,
  invalidMessage,
  className,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  invalidMessage?: string;
  className?: string;
}) {
  const invalid = !Number.isInteger(value) || value < min || value > max;
  const message = invalid ? (invalidMessage ?? `Enter a whole number from ${min} to ${max}.`) : undefined;

  return (
    <div className={className}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        aria-invalid={invalid}
        aria-describedby={message ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className={cn(
          'w-full rounded-md border bg-paper px-2 py-1.5 text-sm text-ink tabular-nums',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent',
          invalid ? 'border-rose-500' : 'border-line',
        )}
      />
      {message ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-rose-600 dark:text-rose-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function isValidInt(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
