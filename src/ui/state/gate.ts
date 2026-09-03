/**
 * The single decision behind an enabled Run button (R-11): readiness is *validated*,
 * not assumed, and the panel says exactly what is missing when it is not.
 */
import type { Readiness } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { isWaiting, type AreaStatus } from './status';

export const PLANNING_INTERVAL = { min: 1, max: 100 } as const;
export const MAX_STEPS = { min: 1, max: 1000 } as const;

export interface Gate {
  ok: boolean;
  /** Present whenever `ok` is false. Shown verbatim next to the Run button. */
  reason?: string;
}

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

export function configGate(config: Config): Gate {
  if (!config.leaderModel) return { ok: false, reason: 'Pick a Leader model.' };
  if (!config.followerModel) return { ok: false, reason: 'Pick a Follower model.' };
  if (!inRange(config.planningInterval, PLANNING_INTERVAL)) {
    return {
      ok: false,
      reason: `Planning interval must be ${PLANNING_INTERVAL.min}–${PLANNING_INTERVAL.max}.`,
    };
  }
  if (!inRange(config.maxSteps, MAX_STEPS)) {
    return { ok: false, reason: `Max steps must be ${MAX_STEPS.min}–${MAX_STEPS.max}.` };
  }
  return { ok: true };
}

export function readinessGate(readiness: Readiness | undefined, status: AreaStatus): Gate {
  if (status === 'error') return { ok: false, reason: 'The worker could not report readiness.' };
  if (!readiness) {
    return {
      ok: false,
      reason: isWaiting(status)
        ? 'Waiting for the worker to report readiness.'
        : 'Readiness unknown.',
    };
  }
  if (!readiness.hostConnected) {
    return { ok: false, reason: readiness.reason ?? 'The native host is not connected.' };
  }
  if (!readiness.keyReady) {
    return { ok: false, reason: readiness.reason ?? 'No provider key is available.' };
  }
  return { ok: true };
}

export function runGate(
  readiness: Readiness | undefined,
  status: AreaStatus,
  config: Config,
): Gate {
  const ready = readinessGate(readiness, status);
  if (!ready.ok) return ready;
  return configGate(config);
}
