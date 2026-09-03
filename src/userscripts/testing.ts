/**
 * Test-only fakes for the `chrome.userScripts` seam. Not exported from `index.ts`
 * and never imported by production code.
 *
 * `vmUserScriptsApi()` really evaluates the wrapped code with `node:vm`, compiled
 * as its own source unit, so stack line numbers line up with the wrapped source
 * exactly as they do in Chrome. That is what makes the wrapper's line-offset maths
 * testable at all — a stubbed result would only test the stub.
 */
import vm from 'node:vm';
import type { UserScriptsApi } from './runner';

export interface FakeUserScriptsApi extends UserScriptsApi {
  readonly injections: chrome.userScripts.UserScriptInjection[];
  readonly worldConfigs: chrome.userScripts.WorldProperties[];
}

export function vmUserScriptsApi(): FakeUserScriptsApi {
  const injections: chrome.userScripts.UserScriptInjection[] = [];
  const worldConfigs: chrome.userScripts.WorldProperties[] = [];

  return {
    injections,
    worldConfigs,
    async execute<T>(injection: chrome.userScripts.UserScriptInjection) {
      injections.push(injection);
      const source = injection.js[0].code;
      if (source === undefined) throw new Error('fake api only supports inline code');
      const value = (await vm.runInThisContext(source, { filename: 'userscript.js' })) as T;
      return [{ documentId: 'doc-1', frameId: 0, result: value }] as chrome.userScripts.InjectionResult<T>[];
    },
    async configureWorld(properties: chrome.userScripts.WorldProperties) {
      worldConfigs.push(properties);
    },
  };
}

/** An availability env that reports a healthy Chrome 135+ with the toggle on. */
export function availableEnv(api: unknown) {
  return { getNamespace: () => api, majorVersion: () => 140 };
}
