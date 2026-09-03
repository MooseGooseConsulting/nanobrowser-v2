/** Joins class names, dropping falsy values. Hand-rolled so `clsx` stays out of the bundle. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
