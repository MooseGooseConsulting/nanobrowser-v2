import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';

/**
 * Integer input with inline validation. Out-of-range values are shown but never
 * committed, so `planningInterval` / `maxSteps` (R-04) cannot be persisted invalid.
 *
 * The draft is local state rather than the `value` prop because those two things are
 * genuinely different: what is typed, and what has been accepted. Committing straight
 * from the input meant clearing the field wrote `NaN` (an empty `<input type=number>`
 * reports `valueAsNumber: NaN`) through to `chrome.storage`, which contradicted the
 * promise above -- the field could not show an invalid value without also persisting it.
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
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ''));

  // A committed change from elsewhere (config load, Reset) wins over a stale draft.
  useEffect(() => {
    setDraft(Number.isFinite(value) ? String(value) : '');
  }, [value]);

  const parsed = draft.trim() === '' ? Number.NaN : Number(draft);
  const invalid = !isValidInt(parsed, min, max);
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
        value={draft}
        aria-invalid={invalid}
        aria-describedby={message ? `${id}-error` : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const asNumber = next.trim() === '' ? Number.NaN : Number(next);
          if (isValidInt(asNumber, min, max)) onChange(asNumber);
        }}
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
