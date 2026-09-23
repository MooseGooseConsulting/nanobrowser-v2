/**
 * The project's own stealth probe (M7).
 *
 * Public suites return green for unpatched Puppeteer since Chrome 138 and prove
 * nothing (docs/research/bot-detection-research.md), so the signals that matter
 * for *this* extension are collected here, against the page scope the extension
 * actually drives. Each check reports an observation; only the signals with an
 * absolute clean-room answer (`webdriver` absent, coalesced events present, no
 * extension leak into page scope, no automation globals, no throwing property
 * reads) raise `anomalous`. The structural checks (`error-stack-accessor`,
 * `proxy-ownkeys` counts) are differential evidence — run early vs late, or
 * clean profile vs driven run — and say so in their detail rather than crying
 * wolf on a single sample.
 *
 * `ProbeScope` is deliberately structural, not `Window`: production passes the
 * page scope, tests pass fakes with planted signals, and the detection logic is
 * what gets proven — not the browser it ran in.
 */
export interface ProbeNavigator {
  [key: string]: unknown;
}

export interface ProbeScope {
  /** The page's `navigator`. */
  navigator?: ProbeNavigator;
  /** `Object.getOwnPropertyDescriptor(new Error(), 'stack')` from the page scope. */
  errorInstanceStackDescriptor?: PropertyDescriptor;
  /** Whether `PointerEvent.prototype.getCoalescedEvents` exists in the page scope. */
  pointerEventHasCoalesced?: boolean;
  /** `window.chrome?.runtime` as seen from page scope. Must be absent: the
   * extension lives in the ISOLATED world and must not leak into the page. */
  pageChromeRuntime?: unknown;
  /** Own property names of the page global (for the automation-globals scan). */
  globalNames?: string[];
}

export interface ProbeFinding {
  /** One of {@link PROBE_CHECKS}. */
  check: string;
  /** What was seen, in one short line for the run log. */
  observed: string;
  /** True only for signals with an absolute clean-room answer (see above). */
  anomalous: boolean;
  /** Why this reading means what it means. */
  detail: string;
}

/** Every signal this probe covers. A test pins the list so none rots away silently. */
export const PROBE_CHECKS = [
  'webdriver-including-undefined',
  'error-stack-accessor',
  'proxy-ownkeys',
  'main-world-execution',
  'playwright-init-globals',
  'coalesced-events',
] as const;

/** Globals no clean page defines but automation harnesses have left behind. */
export const SUSPECT_GLOBALS = ['__playwright', '__pwInitScripts', '__puppeteer', '__nightmare', '_selenium', 'callPhantom'];

const NAVIGATOR_PROBE_PROPS = ['userAgent', 'plugins', 'languages', 'hardwareConcurrency', 'deviceMemory'];

export function runStealthProbe(scope: ProbeScope): ProbeFinding[] {
  const findings: ProbeFinding[] = [];

  // 1. webdriver, *including* undefined: `'webdriver' in navigator` is true in
  // drivers that define the property but leave it undefined. Presence itself is
  // the tell — a clean browser has no such property at all.
  if (!scope.navigator) {
    findings.push({
      check: 'webdriver-including-undefined',
      observed: 'no navigator in scope',
      anomalous: false,
      detail: 'nothing to read; the live probe always runs with a real navigator',
    });
  } else {
    const present = 'webdriver' in scope.navigator;
    findings.push({
      check: 'webdriver-including-undefined',
      observed: present
        ? `webdriver present with value ${String(scope.navigator.webdriver)}`
        : 'webdriver absent',
      anomalous: present,
      detail: 'clean Chrome/Firefox define no webdriver property, not even an undefined one',
    });
  }

  // 2. Error.stack accessor on the instance: V8 captures the stack as an own
  // *data* property. An accessor here is an injected getter watching stack reads
  // (a known instrumentation hook). Anything else is reported, not flagged.
  const descriptor = scope.errorInstanceStackDescriptor;
  const isAccessor = !!descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function');
  findings.push({
    check: 'error-stack-accessor',
    observed: !descriptor
      ? 'no own stack property on a fresh error'
      : isAccessor
        ? 'own stack ACCESSOR on a fresh error'
        : 'own stack data property on a fresh error',
    anomalous: isAccessor,
    detail: 'an accessor on the instance is an injected stack hook; data-or-inherited needs a clean-profile baseline to judge',
  });

  // 3. Proxy ownKeys/value traps around navigator: reading ordinary properties
  // must never throw. A throw means something interposes on property access —
  // the shape a `Proxy` around `navigator` takes when its traps are incomplete.
  if (!scope.navigator) {
    findings.push({
      check: 'proxy-ownkeys',
      observed: 'no navigator in scope',
      anomalous: false,
      detail: 'nothing to read; the live probe always runs with a real navigator',
    });
  } else {
    let threw: string | undefined;
    let read = 0;
    for (const prop of NAVIGATOR_PROBE_PROPS) {
      try {
        void (scope.navigator as Record<string, unknown>)[prop];
        read += 1;
      } catch {
        threw = prop;
        break;
      }
    }
    findings.push({
      check: 'proxy-ownkeys',
      observed: threw ? `reading navigator.${threw} threw` : `read ${read}/${NAVIGATOR_PROBE_PROPS.length} navigator properties cleanly`,
      anomalous: threw !== undefined,
      detail: 'ordinary navigator reads never throw on a clean browser; a throw is an interposed trap',
    });
  }

  // 4. MAIN-world execution leak: this probe runs in page scope. `chrome.runtime`
  // visible here means extension context is bleeding into the page (or the probe
  // is running in the wrong world, which is itself worth knowing).
  const leaked = scope.pageChromeRuntime !== undefined;
  findings.push({
    check: 'main-world-execution',
    observed: leaked ? 'chrome.runtime visible in page scope' : 'chrome.runtime not visible in page scope',
    anomalous: leaked,
    detail: 'the extension injects into the ISOLATED world only; the page must never see chrome.runtime',
  });

  // 5. Playwright/puppeteer init leftovers: best-effort name scan. Documented as
  // advisory — exotic harnesses use other names — but a hit is conclusive.
  const names = scope.globalNames ?? [];
  const hits = SUSPECT_GLOBALS.filter((g) => names.includes(g));
  findings.push({
    check: 'playwright-init-globals',
    observed: hits.length > 0 ? `automation globals present: ${hits.join(', ')}` : 'no known automation globals',
    anomalous: hits.length > 0,
    detail: 'absence proves nothing (renamed harnesses exist); presence proves automation',
  });

  // 6. getCoalescedEvents: real Chrome ships it on PointerEvent; stripped and
  // headless-mangled builds drop it. Missing here is a real-input tell in reverse.
  if (scope.pointerEventHasCoalesced === undefined) {
    findings.push({
      check: 'coalesced-events',
      observed: 'unknown (not provided)',
      anomalous: false,
      detail: 'the live probe always provides this; unknown only happens in a partial scope',
    });
  } else {
    findings.push({
      check: 'coalesced-events',
      observed: scope.pointerEventHasCoalesced
        ? 'PointerEvent.getCoalescedEvents present'
        : 'PointerEvent.getCoalescedEvents MISSING',
      anomalous: !scope.pointerEventHasCoalesced,
      detail: 'genuine desktop Chrome has coalesced events; stripped builds do not',
    });
  }

  return findings;
}

/** The check names that came back anomalous. Empty means a clean page. */
export function probeAnomalies(findings: ProbeFinding[]): string[] {
  return findings.filter((f) => f.anomalous).map((f) => f.check);
}
