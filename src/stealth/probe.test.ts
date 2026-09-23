/**
 * The probe's detection logic, proven against fake scopes: a clean scope comes
 * back with no anomalies, and each planted signal fires exactly its own check.
 * Live execution against real Chrome (clean profile vs driven run) is still to
 * run — host access is down — and when it does, `runStealthProbe` is the same
 * function it calls.
 */
import { describe, expect, it } from 'vitest';
import {
  PROBE_CHECKS,
  SUSPECT_GLOBALS,
  probeAnomalies,
  runStealthProbe,
  type ProbeScope,
} from './probe';

function cleanScope(): ProbeScope {
  return {
    navigator: { userAgent: 'clean', plugins: [], languages: ['en-US'], hardwareConcurrency: 8, deviceMemory: 8 },
    errorInstanceStackDescriptor: { value: 'Error\n    at clean', writable: true, enumerable: false, configurable: true },
    pointerEventHasCoalesced: true,
    pageChromeRuntime: undefined,
    globalNames: ['window', 'document', 'foo'],
  };
}

describe('runStealthProbe', () => {
  it('covers every research signal, and none rots away unnoticed', () => {
    const checks = runStealthProbe(cleanScope()).map((f) => f.check);
    expect([...checks].sort()).toEqual([...PROBE_CHECKS].sort());
  });

  it('reports a clean scope with no anomalies', () => {
    const findings = runStealthProbe(cleanScope());
    expect(findings).toHaveLength(PROBE_CHECKS.length);
    expect(probeAnomalies(findings)).toEqual([]);
  });

  it('flags webdriver even when its value is undefined (presence is the tell)', () => {
    const scope = cleanScope();
    scope.navigator = { ...scope.navigator, webdriver: undefined };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['webdriver-including-undefined']);
  });

  it('flags an injected stack getter on a fresh error', () => {
    const scope = cleanScope();
    scope.errorInstanceStackDescriptor = { get() { return 'hooked'; }, enumerable: false, configurable: true };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['error-stack-accessor']);
  });

  it('flags a navigator whose property reads throw (interposed proxy trap)', () => {
    const scope = cleanScope();
    scope.navigator = {
      userAgent: 'proxied',
      get plugins(): unknown {
        throw new Error('trap');
      },
    };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['proxy-ownkeys']);
  });

  it('flags extension context leaking into page scope', () => {
    const scope = cleanScope();
    scope.pageChromeRuntime = { id: 'abcdef' };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['main-world-execution']);
  });

  it('flags known automation globals and names them', () => {
    const scope = cleanScope();
    scope.globalNames = [...(scope.globalNames ?? []), '__playwright'];
    const findings = runStealthProbe(scope);
    expect(probeAnomalies(findings)).toEqual(['playwright-init-globals']);
    expect(findings.find((f) => f.check === 'playwright-init-globals')?.observed).toContain('__playwright');
  });

  it('flags a stripped PointerEvent with no coalesced events', () => {
    const scope = cleanScope();
    scope.pointerEventHasCoalesced = false;
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['coalesced-events']);
  });

  it('fires every planted signal at once without cross-talk', () => {
    const findings = runStealthProbe({
      navigator: {
        webdriver: true,
        get plugins(): unknown {
          throw new Error('trap');
        },
      },
      errorInstanceStackDescriptor: { get() { return 'hooked'; }, enumerable: false, configurable: true },
      pointerEventHasCoalesced: false,
      pageChromeRuntime: { id: 'abcdef' },
      globalNames: [SUSPECT_GLOBALS[0]!],
    });
    expect(probeAnomalies(findings).sort()).toEqual(
      [
        'webdriver-including-undefined',
        'error-stack-accessor',
        'proxy-ownkeys',
        'main-world-execution',
        'playwright-init-globals',
        'coalesced-events',
      ].sort(),
    );
  });
});
