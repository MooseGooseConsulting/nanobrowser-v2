// @vitest-environment jsdom
/**
 * Two edge cases the review called out as explicitly required and missing
 * from `runner.test.ts`: a script with no top-level `return`, and a genuine
 * asynchronous/callback throw (not a manually dispatched `ErrorEvent`).
 * Plus the mid-flight tab-swap regression: the target is re-resolved just
 * before `execute()` and the allow-list check repeats when it changed.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Userscript } from '@/src/messaging';
import { recordTabReplaced, resetTabReplacements } from '@/src/page/tabReplacement';
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

/**
 * Chrome can swap a tab's id between the allow-list check and the injection
 * (`chrome.tabs.onReplaced`, prerender/redirect chains). The runner resolves the
 * target once more right before `execute()`, and repeats the URL check whenever
 * the target changed — the swap is what makes an unchecked page reachable.
 */
describe('runUserscript: the target tab is re-resolved before execute', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    resetTabReplacements();
  });

  it('re-checks the replacement tab and refuses it when its URL is out of scope', async () => {
    // The replacement is recorded the moment the first URL is resolved — the same
    // instant `chrome.tabs.onReplaced` would fire during a live run.
    const tabs = {
      get: async (tabId: number) => {
        recordTabReplaced(9, 7);
        return tabId === 7 ? { url: URL_IN_SCOPE } : { url: 'https://example.com/' };
      },
    };
    const api = vmUserScriptsApi();

    const result = await runUserscript({ tabId: 7, script: script('return 1;'), api, tabs });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused: https:\/\/example\.com\/ is not in this script's allow-list/);
    expect(api.injections).toHaveLength(0);
  });

  it('injects into the replacement tab when its URL is in scope', async () => {
    const tabs = {
      get: async (_tabId: number) => {
        recordTabReplaced(9, 7);
        return { url: URL_IN_SCOPE };
      },
    };
    const api = vmUserScriptsApi();

    await expect(runUserscript({ tabId: 7, script: script('return 1;'), api, tabs })).resolves.toMatchObject({
      ok: true,
    });
    expect(api.injections).toHaveLength(1);
    expect(api.injections[0]!.target).toEqual({ tabId: 9 });
  });

  it('cannot verify a changed target from a caller-supplied URL alone, and refuses', async () => {
    // The caller's `url` describes the tab it started on; once Chrome replaced it,
    // only a live resolution could vouch for the new target, and there is no tabs
    // seam to ask. Refusing beats injecting into an unverified page.
    const api = {
      execute: async () => {
        throw new Error('execute must not be reached: the changed target could not be verified');
      },
      configureWorld: async () => {
        recordTabReplaced(9, 7);
      },
    };

    const result = await runUserscript({ tabId: 7, script: script('return 1;'), url: URL_IN_SCOPE, api });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot resolve the tab URL');
  });
});
