// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads" }
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RunEvent } from '@/src/messaging';
import { listUserscripts, saveUserscript } from './catalog';
import { handleUserscriptMessage, type UserscriptMessageContext } from './index';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

describe('handleUserscriptMessage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetWorldConfiguration();
  });

  it('seeds every bundled example the first time the panel lists scripts', async () => {
    const reply = await handleUserscriptMessage({ type: 'userscript.list', payload: {} });

    expect(reply?.type).toBe('userscript.list');
    const scripts = (reply as { payload: { scripts: Array<{ name: string }> } }).payload.scripts;
    expect(scripts.map((script) => script.name)).toEqual(['hyperagent-observe', 'ebay-search-extract']);
  });

  it('saves a script and replies with the refreshed list', async () => {
    const reply = await handleUserscriptMessage({
      type: 'userscript.save',
      payload: { id: 'given-id', name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;', updatedAt: 0 },
    });

    expect(reply?.type).toBe('userscript.list');
    await expect(listUserscripts()).resolves.toMatchObject([{ id: 'given-id', name: 'mine' }]);
  });

  it('replies with an error, and stores nothing, when a save is invalid', async () => {
    const reply = await handleUserscriptMessage({
      type: 'userscript.save',
      payload: { id: 'x', name: '', matches: ['nonsense'], code: '', updatedAt: 0 },
    });

    expect(reply).toEqual({
      type: 'error',
      payload: { message: expect.stringContaining('invalid userscript'), inReplyTo: 'userscript.save' },
    });
    await expect(listUserscripts()).resolves.toEqual([]);
  });

  it('deletes and replies with the refreshed list', async () => {
    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });

    const reply = await handleUserscriptMessage({ type: 'userscript.delete', payload: { id: saved.id } });

    expect(reply).toEqual({ type: 'userscript.list', payload: { scripts: [] } });
  });

  it('runs a stored script, replies with the result, and emits its console to the run log', async () => {
    const saved = await saveUserscript({
      name: 'mine',
      matches: ['*://hyperagent.com/*'],
      code: "console.log('running');\nreturn 'ok';",
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

    expect(reply).toMatchObject({
      type: 'userscript.result',
      payload: { scriptId: saved.id, ok: true, value: 'ok' },
    });
    expect(events).toEqual([
      { kind: 'userscript.output', scriptId: saved.id, level: 'log', text: 'running', at: expect.any(Number) },
    ]);
  });

  it('runs the panel’s edited code without persisting it (R-10)', async () => {
    const saved = await saveUserscript({
      name: 'mine',
      matches: ['*://hyperagent.com/*'],
      code: 'return 1;',
    });

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id, code: 'return 2;' } },
      { tabId: 4, url: URL_IN_SCOPE, api: vmUserScriptsApi() },
    );

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { value: 2 } });
    await expect(listUserscripts()).resolves.toMatchObject([{ code: 'return 1;' }]);
  });

  it('errors on an unknown script id and on a missing tab', async () => {
    await expect(
      handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: 'nope' } }, { tabId: 1 }),
    ).resolves.toEqual({
      type: 'error',
      payload: { message: 'unknown userscript: nope', inReplyTo: 'userscript.run' },
    });

    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });
    await expect(
      handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: saved.id } }, {}),
    ).resolves.toEqual({
      type: 'error',
      payload: { message: 'no target tab for the userscript run', inReplyTo: 'userscript.run' },
    });
  });

  it('resolves the tab through the context when no tabId is given', async () => {
    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id } },
      { resolveTabId: async () => 9, url: URL_IN_SCOPE, api: vmUserScriptsApi() },
    );

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { ok: true } });
  });

  it('ignores messages it does not own', async () => {
    await expect(
      handleUserscriptMessage({ type: 'readiness.get', payload: {} }),
    ).resolves.toBeUndefined();
  });
});
