import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_CONFIG, getConfig, resetConfig, setConfig, configItem } from '@/src/storage';

describe('config storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('falls back to the typed defaults when nothing is stored', async () => {
    await expect(getConfig()).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('saves and restores a full config', async () => {
    await configItem.setValue({
      leaderModel: 'anthropic/claude-opus',
      followerModel: 'anthropic/claude-haiku',
      observe: 'both',
      planningInterval: 3,
      maxSteps: 120,
      inputFidelity: 'escalated',
    });

    await expect(getConfig()).resolves.toEqual({
      leaderModel: 'anthropic/claude-opus',
      followerModel: 'anthropic/claude-haiku',
      observe: 'both',
      planningInterval: 3,
      maxSteps: 120,
      inputFidelity: 'escalated',
    });
  });

  it('merges a partial update over what is stored', async () => {
    await setConfig({ leaderModel: 'openai/gpt-5' });
    const next = await setConfig({ observe: 'pixels', planningInterval: 8 });

    expect(next).toEqual({
      ...DEFAULT_CONFIG,
      leaderModel: 'openai/gpt-5',
      observe: 'pixels',
      planningInterval: 8,
    });
    await expect(getConfig()).resolves.toEqual(next);
  });

  it('reverts to defaults after a reset', async () => {
    await setConfig({ maxSteps: 1, inputFidelity: 'escalated' });
    await resetConfig();
    await expect(getConfig()).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('notifies watchers on change', async () => {
    const seen: number[] = [];
    const unwatch = configItem.watch((value) => seen.push(value.maxSteps));
    await setConfig({ maxSteps: 7 });
    unwatch();
    expect(seen).toEqual([7]);
  });
});
