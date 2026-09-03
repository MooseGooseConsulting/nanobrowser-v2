import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getLastRunId, lastRunIdItem, setLastRunId } from './lastRun';

describe('last run id', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('is null before any run', async () => {
    await expect(getLastRunId()).resolves.toBeNull();
  });

  it('round-trips through the session storage area', async () => {
    await setLastRunId('run-42');
    await expect(getLastRunId()).resolves.toBe('run-42');
    await expect(chrome.storage.session.get('lastRunId')).resolves.toEqual({ lastRunId: 'run-42' });
  });

  it('does not leak into local storage, so it dies with the browser session', async () => {
    await setLastRunId('run-42');
    await expect(chrome.storage.local.get('lastRunId')).resolves.toEqual({});
  });

  it('is overwritten by a newer run', async () => {
    await setLastRunId('run-1');
    await setLastRunId('run-2');
    await expect(lastRunIdItem.getValue()).resolves.toBe('run-2');
  });
});
