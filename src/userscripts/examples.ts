/**
 * Bundled example userscripts. `seedDefaults()` installs these once, on an empty
 * catalog, so a fresh install has something real to run and debug (R-09/R-10).
 *
 * Every bundled example is read-only by construction: it reads the DOM and returns
 * JSON. No writes, no navigation, no fetch — a bundled script must never do
 * anything the user did not ask for on a site they happen to have open.
 *
 * The wrapper in `runner.ts` runs a script as the body of an async function, so a
 * script hands its result back with a top-level `return`.
 */
import type { Userscript } from '@/src/messaging';

/** A bundled example, before the catalog stamps an id and `updatedAt` on it. */
export type UserscriptSeed = Omit<Userscript, 'id' | 'updatedAt'>;

/**
 * Reads the Hyperagent thread list and reports each thread's title and status
 * badge. Purely observational: no DOM writes, no fetch, no cross-origin access.
 * Allow-listed to Hyperagent, and it re-checks the host itself before reading.
 */
const HYPERAGENT_OBSERVE_CODE = `// hyperagent-observe — read-only thread-list observer.
// Collects thread titles and status badges from the page DOM and returns them as
// JSON. Performs no DOM writes and no network requests of any kind.
const ALLOWED_HOSTS = ['hyperagent.com', 'www.hyperagent.com'];
const host = location.hostname.toLowerCase();
if (ALLOWED_HOSTS.indexOf(host) === -1) {
  return { scriptId: 'hyperagent-observe', ok: false, reason: 'host-not-allowed', host: host };
}

const clean = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');

const threadIdFrom = (container) => {
  const explicit = container.getAttribute && container.getAttribute('data-thread-id');
  if (explicit) return explicit;
  const link = container.matches && container.matches('a[href*="/thread/"]')
    ? container
    : container.querySelector('a[href*="/thread/"]');
  const href = link && link.getAttribute('href');
  const found = href && href.match(/\\/thread\\/([^/?#]+)/);
  return found ? found[1] : null;
};

const titleFrom = (container) =>
  clean(container.querySelector('[data-thread-title], .thread-title, a[href*="/thread/"], h1, h2, h3'));

const statusFrom = (container) => {
  const badge = container.querySelector('[data-status], .status-badge, .badge');
  if (!badge) return null;
  return (badge.getAttribute('data-status') || clean(badge)) || null;
};

const candidates = document.querySelectorAll('[data-thread-id], li.thread-row, a[href*="/thread/"]');
const seen = new Set();
const threads = [];
for (const candidate of candidates) {
  const container =
    (candidate.closest && candidate.closest('[data-thread-id], li, tr, article')) || candidate;
  const id = threadIdFrom(container);
  const key = id || titleFrom(container);
  if (!key || seen.has(key)) continue;
  seen.add(key);
  threads.push({ id: id, title: titleFrom(container) || null, status: statusFrom(container) });
}

return {
  scriptId: 'hyperagent-observe',
  ok: true,
  readOnly: true,
  host: host,
  path: location.pathname,
  threadCount: threads.length,
  threads: threads,
};
`;

export const HYPERAGENT_OBSERVE: UserscriptSeed = {
  name: 'hyperagent-observe',
  matches: ['*://hyperagent.com/*', '*://www.hyperagent.com/*'],
  code: HYPERAGENT_OBSERVE_CODE,
};

/** Everything `seedDefaults()` installs into an empty catalog. */
export const BUNDLED_USERSCRIPTS: readonly UserscriptSeed[] = [HYPERAGENT_OBSERVE];
