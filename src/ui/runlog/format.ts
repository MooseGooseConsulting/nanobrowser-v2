import type { Role } from '@/src/messaging';

export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function roleLabel(role: Role): string {
  return role === 'leader' ? 'Leader' : 'Follower';
}

/**
 * Pretty-prints tool arguments for the collapsible card (R-06). Non-serialisable values
 * (a cyclic object from a badly-behaved tool) must never take the panel down.
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
