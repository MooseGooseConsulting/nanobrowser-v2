import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent' | 'leader' | 'follower';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface text-muted border-line',
  good: 'bg-emerald-500/12 text-emerald-700 border-emerald-500/35 dark:text-emerald-300',
  warn: 'bg-amber-500/12 text-amber-700 border-amber-500/35 dark:text-amber-300',
  bad: 'bg-rose-500/12 text-rose-700 border-rose-500/35 dark:text-rose-300',
  accent: 'bg-accent/12 text-accent border-accent/35',
  leader: 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300',
  follower: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  title,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
