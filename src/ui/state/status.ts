/**
 * Per-area request status. The panel talks to a service worker that may not answer a
 * given request at all yet, so "no reply" is a first-class rendered state, not an error.
 */
export type AreaStatus = 'idle' | 'waiting' | 'ready' | 'error';

export function isWaiting(status: AreaStatus): boolean {
  return status === 'idle' || status === 'waiting';
}
