// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads?tab=all" }
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROBE_GLOBALS, buildProbeCode, probePageAccess, probeScript } from './i03';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

describe('I-03 page-access probe', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
    document.body.innerHTML = '<main>threads</main>';
    document.cookie = 'session_hint=1';
  });

  it('reports what the world can reach on the page', async () => {
    (globalThis as Record<string, unknown>).__APP_STATE__ = { threads: 3 };

    const { result, report } = await probePageAccess({
      tabId: 1,
      url: 'https://hyperagent.com/threads?tab=all',
      api: vmUserScriptsApi(),
      globals: ['__APP_STATE__', '__NEVER_DEFINED__'],
    });

    expect(result.ok).toBe(true);
    expect(report).toMatchObject({
      origin: 'https://hyperagent.com',
      world: 'USER_SCRIPT',
      domVisible: true,
      visibleGlobals: ['__APP_STATE__'],
      hiddenGlobals: ['__NEVER_DEFINED__'],
      cookieReadable: true,
      cspMeta: "default-src 'self'",
      sameOriginFetch: null,
    });
    expect(report?.cookieNames).toContain('session_hint');
    expect(report?.extensionApis).toEqual({
      chrome: expect.any(Boolean),
      runtime: expect.any(Boolean),
      tabs: expect.any(Boolean),
      userScripts: expect.any(Boolean),
    });

    delete (globalThis as Record<string, unknown>).__APP_STATE__;
  });

  it('gates the one network request behind an explicit opt-in', () => {
    expect(buildProbeCode(DEFAULT_PROBE_GLOBALS, false)).toContain('const DO_FETCH = false;');
    expect(buildProbeCode(DEFAULT_PROBE_GLOBALS, true)).toContain('const DO_FETCH = true;');
  });

  it('is allow-listed to every URL because it only reads', () => {
    expect(probeScript(DEFAULT_PROBE_GLOBALS, false).matches).toEqual(['<all_urls>']);
  });
});
