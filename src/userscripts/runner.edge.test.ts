// @vitest-environment jsdom
/**
 * Two edge cases the review called out as explicitly required and missing
 * from `runner.test.ts`: a script with no top-level `return`, and a genuine
 * asynchronous/callback throw (not a manually dispatched `ErrorEvent`).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Userscript } from '@/src/messaging';
import { resetWorldConfiguration, runUserscript } from './runner';
import { vmUserScriptsApi } from './testing';

function script(code: string): Userscript {
  return { id: 'script-1', name: 'probe', matches: ['*://hyperagent.com/*'], code, updatedAt: 0 };
}

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

beforeEach(() => {
  resetWorldConfiguration();
});

describe('runUserscript: no top-level return', () => {
  it('succeeds with an undefined value when the script never returns', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script("console.log('side effect only');"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.console).toEqual([{ level: 'log', text: 'side effect only', at: expect.any(Number) }]);
  });
});

describe('runUserscript: a genuine asynchronous throw', () => {
  it('captures an error thrown inside an awaited callback, not just a synchronous one', async () => {
    // Unlike a manually-dispatched ErrorEvent, this is a real throw that only
    // surfaces after control has already left the wrapper's try block once
    // (inside the Promise the user code awaits), proving the wrapper's own
    // async try/catch -- not a global error listener -- is what catches it.
    const result = await runUserscript({
      tabId: 1,
      script: script(
        "await new Promise((resolve) => setTimeout(resolve, 0));\nthrow new Error('late failure');",
      ),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('late failure');
  });

  it('captures a rejected promise awaited inside the script body', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script("await Promise.reject(new Error('rejected'));"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('rejected');
  });
});
