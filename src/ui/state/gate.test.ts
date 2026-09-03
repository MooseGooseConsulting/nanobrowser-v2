import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '@/src/storage';
import { configGate, readinessGate, runGate } from './gate';

const GOOD: Config = {
  ...DEFAULT_CONFIG,
  leaderModel: 'nvidia/nemotron-ultra',
  followerModel: 'meta/llama-4',
};

describe('readinessGate', () => {
  it('is not ok while the worker has not answered', () => {
    const gate = readinessGate(undefined, 'waiting');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/waiting for the worker/i);
  });

  it('surfaces the worker\'s own reason for a missing host', () => {
    const gate = readinessGate(
      { hostConnected: false, keyReady: false, reason: 'native host not registered' },
      'ready',
    );
    expect(gate).toEqual({ ok: false, reason: 'native host not registered' });
  });

  it('names the key when only the key is missing', () => {
    expect(readinessGate({ hostConnected: true, keyReady: false }, 'ready').reason).toMatch(/key/i);
  });

  it('is ok when the host and key are both good', () => {
    expect(readinessGate({ hostConnected: true, keyReady: true }, 'ready')).toEqual({ ok: true });
  });

  it('reports an errored readiness request', () => {
    expect(readinessGate(undefined, 'error').reason).toMatch(/could not report/i);
  });
});

describe('configGate', () => {
  it('requires both models, separately', () => {
    expect(configGate(DEFAULT_CONFIG).reason).toMatch(/leader/i);
    expect(configGate({ ...DEFAULT_CONFIG, leaderModel: 'a' }).reason).toMatch(/follower/i);
    expect(configGate(GOOD)).toEqual({ ok: true });
  });

  it('rejects out-of-range or non-integer cadence values', () => {
    expect(configGate({ ...GOOD, planningInterval: 0 }).reason).toMatch(/planning interval/i);
    expect(configGate({ ...GOOD, planningInterval: 2.5 }).reason).toMatch(/planning interval/i);
    expect(configGate({ ...GOOD, maxSteps: 0 }).reason).toMatch(/max steps/i);
    expect(configGate({ ...GOOD, maxSteps: 5000 }).reason).toMatch(/max steps/i);
    expect(configGate({ ...GOOD, maxSteps: Number.NaN }).ok).toBe(false);
  });
});

describe('runGate', () => {
  it('reports readiness before config', () => {
    expect(runGate(undefined, 'waiting', DEFAULT_CONFIG).reason).toMatch(/waiting for the worker/i);
  });

  it('is ok only when readiness and config are both good', () => {
    const ready = { hostConnected: true, keyReady: true };
    expect(runGate(ready, 'ready', DEFAULT_CONFIG).ok).toBe(false);
    expect(runGate(ready, 'ready', GOOD)).toEqual({ ok: true });
  });
});
