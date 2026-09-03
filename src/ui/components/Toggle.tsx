import { cn } from '../lib/cn';

/**
 * Two-state switch built on the ARIA `switch` role. Used for input fidelity (R-13),
 * where "on" means the escalated, debugger-backed path.
 */
export function Toggle({
  checked,
  onChange,
  label,
  id,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  id?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line p-0.5 transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent',
        checked ? 'bg-accent' : 'bg-raised',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-3.5 rounded-full bg-paper shadow transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}
