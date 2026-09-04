// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads" }
/**
 * Two gaps the review found in `index.test.ts`:
 *
 * 1. Every `userscript.run` test there omits `context.session`, so the entire
 *    `DebugSession`-backed branch of `handleUserscriptMessage` (lines 87-91 of
 *    `index.ts`) was never exercised through the actual message-dispatch path
 *    the worker/panel use -- it was proven only in isolation, directly against
 *    `DebugSession`, in `debug.test.ts`.
 * 2. No test drives a *failing* script through `handleUserscriptMessage` with
 *    `context.emit` set, so the "error line mapped back" / final error event
 *    reaching the run log through this entry point (not just through
 *    `DebugSession.events()` directly) was unproven.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RunEvent } from '@/src/messaging';
import { saveUserscript } from './catalog';
import { DebugSession } from './debug';
import { handleUserscriptMessage, type UserscriptMessageContext } from './index';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

beforeEach(() => {
  fakeBrowser.reset();
  resetWorldConfiguration();
});

describe('handleUserscriptMessage: routed through a DebugSession', () => {
  it('reuses the session across two runs instead of running independently each time', async () => {
    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });
    const session = new DebugSession({ script: saved, tabId: 4, url: URL_IN_SCOPE, api: vmUserScriptsApi() });
    const context: UserscriptMessageContext = { tabId: 4, url: URL_IN_SCOPE, session };

    const first = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id, code: 'return 1;' } },
      context,
    );
    const second = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id, code: 'return 2;' } },
      context,
    );

    expect(first).toMatchObject({ type: 'userscript.result', payload: { value: 1 } });
    expect(second).toMatchObject({ type: 'userscript.result', payload: { value: 2 } });
    // The session (not a fresh run each time) holds exactly the latest result.
    expect(session.last(saved.id)?.value).toBe(2);
  });

  it('switches the session to a different script rather than running against the stale one', async () => {
    const a = await saveUserscript({ name: 'a', matches: ['*://hyperagent.com/*'], code: 'return "a";' });
    const b = await saveUserscript({ name: 'b', matches: ['*://hyperagent.com/*'], code: 'return "b";' });
    const session = new DebugSession({ script: a, tabId: 4, url: URL_IN_SCOPE, api: vmUserScriptsApi() });
    const context: UserscriptMessageContext = { tabId: 4, url: URL_IN_SCOPE, session };

    await handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: a.id } }, context);
    const reply = await handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: b.id } }, context);

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { value: 'b' } });
    expect(session.script.id).toBe(b.id);
  });
});

describe('handleUserscriptMessage: a failing script reaches the run log through this entry point', () => {
  it('emits a final error event and replies with ok:false, not just a thrown rejection', async () => {
    const saved = await saveUserscript({
      name: 'broken',
      matches: ['*://hyperagent.com/*'],
      code: "console.log('before the throw');\nthrow new Error('boom');",
    });
    const events: RunEvent[] = [];
    const context: UserscriptMessageContext = {
      tabId: 4,
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
      emit: (event) => events.push(event),
    };

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id } },
      context,
    );

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { ok: false } });
    expect(events.some((e) => e.kind === 'userscript.output' && e.level === 'log' && e.text === 'before the throw')).toBe(
      true,
    );
    const errorEvent = events.find((e) => e.kind === 'userscript.output' && e.level === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent && 'text' in errorEvent ? errorEvent.text : '').toContain('boom');
  });
});
