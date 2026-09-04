import { useId, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Disclosure primitive. Radix is not installed, so this is the hand-built equivalent:
 * a real `<button>` (Enter/Space for free) wired to its region with
 * `aria-expanded` / `aria-controls`.
 */
export function Collapsible({
  summary,
  defaultOpen = false,
  className,
  toggleTestId,
  children,
}: {
  summary: (open: boolean) => ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** Distinguishes this disclosure's own toggle button from any nested inside `children`. */
  toggleTestId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  return (
    <div className={className}>
      <button
        type="button"
        data-testid={toggleTestId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-hidden className={cn('text-muted transition-transform', open && 'rotate-90')}>
          &#9656;
        </span>
        <span className="min-w-0 flex-1">{summary(open)}</span>
      </button>
      <div id={regionId} role="region" hidden={!open} className="px-2 pb-2">
        {open ? children : null}
      </div>
    </div>
  );
}
