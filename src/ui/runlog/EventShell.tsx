import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { formatElapsed, formatTime } from './format';
import { useRunStart } from './runStart';

/** Common frame for every run-log entry: timestamp gutter, accent rail, body. */
export function EventShell({
  at,
  rail,
  className,
  children,
}: {
  at: number;
  rail?: string;
  className?: string;
  children: ReactNode;
}) {
  const startAt = useRunStart();
  // Relative to the run's own start once we know it (Requirement 4); the absolute
  // clock time never disappears, it just moves to the hover tooltip.
  const label = startAt !== undefined ? formatElapsed(at - startAt) : formatTime(at);

  return (
    <li data-testid="log-entry" className={cn('flex gap-2', className)}>
      <time
        dateTime={new Date(at).toISOString()}
        title={formatTime(at)}
        className="w-14 shrink-0 pt-1 text-right text-[11px] text-muted tabular-nums"
      >
        {label}
      </time>
      <div
        className={cn(
          'min-w-0 flex-1 border-l-2 pl-2',
          rail ?? 'border-line',
        )}
      >
        {children}
      </div>
    </li>
  );
}
