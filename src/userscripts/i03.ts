/**
 * I-03: "Whether R-09/R-10 can route around R-13 entirely by calling the page's own
 * APIs instead of synthesizing input."
 *
 * This is the executable half of the answer — a read-only probe that reports what a
 * userscript in the `USER_SCRIPT` world can actually reach on a given page. The
 * written half is `docs/research/i03-userscript-page-access.md`; run this against a
 * real site to check that doc against reality rather than trusting it.
 *
 * The probe writes nothing and, unless `sameOriginFetch` is explicitly asked for,
 * issues no network request at all.
 */
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { runUserscript, type AvailabilityEnv, type TabsApi, type UserScriptsApi } from './runner';

export interface PageAccessReport {
  url: string;
  origin: string;
  /** The world we asked Chrome for. Recorded so a report cannot be misread later. */
  world: 'USER_SCRIPT';
  /** DOM reachable? The USER_SCRIPT world shares the page's DOM. */
  domVisible: boolean;
  /** Which of the caller's named page globals are visible from this world. */
  visibleGlobals: string[];
  /** Which are not — the page's own JS objects, if this world does not share them. */
  hiddenGlobals: string[];
  /** `document.cookie` readable (never includes HttpOnly cookies). */
  cookieReadable: boolean;
  cookieNames: string[];
  /** Page CSP declared via meta tag, if any. Header CSP is not visible to JS. */
  cspMeta: string | null;
  /** Extension surface reachable from the script. All false is the expected result. */
  extensionApis: { chrome: boolean; runtime: boolean; tabs: boolean; userScripts: boolean };
  sameOriginFetch: null | { ok: boolean; status: number | null; error: string | null };
}

export interface ProbeOptions {
  tabId: number;
  url?: string;
  api?: UserScriptsApi;
  tabs?: TabsApi;
  env?: AvailabilityEnv;
  now?: () => number;
  /** Page globals to look for by name, e.g. `['__NEXT_DATA__', 'React']`. */
  globals?: string[];
  /** Opt in to one same-origin `GET` of the current URL with credentials. */
  sameOriginFetch?: boolean;
}

/** Globals worth probing on almost any app: framework hooks and hydration payloads. */
export const DEFAULT_PROBE_GLOBALS = ['__NEXT_DATA__', '__NUXT__', '__APP_STATE__', 'React', 'jQuery', 'Vue'];

export function buildProbeCode(globals: string[], sameOriginFetch: boolean): string {
  return `// i03-page-access — read-only capability probe. No DOM writes.
const NAMES = ${JSON.stringify(globals)};
const DO_FETCH = ${sameOriginFetch ? 'true' : 'false'};

const visible = [];
const hidden = [];
for (const name of NAMES) {
  if (typeof globalThis[name] !== 'undefined') visible.push(name); else hidden.push(name);
}

let cookieReadable = false;
let cookieNames = [];
try {
  const raw = document.cookie;
  cookieReadable = typeof raw === 'string';
  cookieNames = raw ? raw.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean) : [];
} catch (e) { cookieReadable = false; }

const cspNode = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
const chromeApi = typeof globalThis.chrome === 'undefined' ? null : globalThis.chrome;

let sameOriginFetch = null;
if (DO_FETCH) {
  try {
    const response = await fetch(location.href, { method: 'GET', credentials: 'include' });
    sameOriginFetch = { ok: response.ok, status: response.status, error: null };
  } catch (e) {
    sameOriginFetch = { ok: false, status: null, error: String(e && e.message ? e.message : e) };
  }
}

return {
  url: location.href,
  origin: location.origin,
  world: 'USER_SCRIPT',
  domVisible: typeof document !== 'undefined' && !!document.documentElement,
  visibleGlobals: visible,
  hiddenGlobals: hidden,
  cookieReadable: cookieReadable,
  cookieNames: cookieNames,
  cspMeta: cspNode ? cspNode.getAttribute('content') : null,
  extensionApis: {
    chrome: !!chromeApi,
    runtime: !!(chromeApi && chromeApi.runtime),
    tabs: !!(chromeApi && chromeApi.tabs),
    userScripts: !!(chromeApi && chromeApi.userScripts),
  },
  sameOriginFetch: sameOriginFetch,
};
`;
}

/** The probe as a `Userscript`, allow-listed to every URL because it only reads. */
export function probeScript(globals: string[], sameOriginFetch: boolean): Userscript {
  return {
    id: 'i03-page-access',
    name: 'i03-page-access',
    matches: ['<all_urls>'],
    code: buildProbeCode(globals, sameOriginFetch),
    updatedAt: 0,
  };
}

export interface ProbeOutcome {
  result: UserscriptRunResult;
  report: PageAccessReport | null;
}

/** Runs the probe in a tab and returns both the raw run result and the parsed report. */
export async function probePageAccess(options: ProbeOptions): Promise<ProbeOutcome> {
  const result = await runUserscript({
    tabId: options.tabId,
    script: probeScript(options.globals ?? DEFAULT_PROBE_GLOBALS, options.sameOriginFetch === true),
    url: options.url,
    api: options.api,
    tabs: options.tabs,
    env: options.env,
    now: options.now,
  });

  return { result, report: result.ok ? ((result.value as PageAccessReport) ?? null) : null };
}
