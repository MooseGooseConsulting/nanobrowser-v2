import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from './format';

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
  return (
    <li className={cn('flex gap-2', className)}>
      <time
        dateTime={new Date(at).toISOString()}
        className="w-[52px] shrink-0 pt-1 text-right text-[10px] text-muted tabular-nums"
      >
        {formatTime(at)}
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
