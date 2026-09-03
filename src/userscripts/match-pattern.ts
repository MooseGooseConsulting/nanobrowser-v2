/**
 * Chrome match patterns, parsed and compiled to RegExp here rather than handed to
 * the browser.
 *
 * `chrome.userScripts.execute()` has no `matches` field — it injects into whatever
 * tab you name. The allow-list on a stored {@link Userscript} is therefore ours to
 * enforce before we inject (R-09), so we need our own matcher. Keeping it a pure
 * function also makes the allow-list testable without a browser.
 *
 * Grammar (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns):
 *   <scheme>://<host><path>   |   <all_urls>
 *   scheme  `*` (http or https only), or a literal scheme
 *   host    `*`, `*.` + hostname, or a literal hostname (never `*foo.com`)
 *   path    must start with `/`; `*` is the only wildcard
 */

/** Schemes `<all_urls>` covers, per Chrome's definition. */
const ALL_URLS_SCHEMES = ['http', 'https', 'file', 'ftp'];

/** Schemes a bare `*` scheme covers. `*` is deliberately not "any scheme". */
const STAR_SCHEMES = ['http', 'https'];

const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;

export interface ParsedMatchPattern {
  /** The pattern as written. */
  readonly source: string;
  /** Lowercased schemes this pattern accepts. */
  readonly schemes: readonly string[];
  /** Host part as written (`*`, `*.example.com`, `example.com`, or `''` for file:). */
  readonly host: string;
  /** Path part as written, always starting with `/`. */
  readonly path: string;
  /** Compiled host test (case-insensitive). `null` means "any host". */
  readonly hostRegex: RegExp | null;
  /** Compiled path test against `pathname + search`. */
  readonly pathRegex: RegExp;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a `*`-wildcarded glob (no other metacharacters) to an anchored RegExp. */
function globToRegExp(glob: string, flags = ''): RegExp {
  const body = glob.split('*').map(escapeRegExp).join('.*');
  return new RegExp('^' + body + '$', flags);
}

/**
 * Parses a match pattern. Returns `null` when the pattern is not valid, which is
 * what {@link isValidMatchPattern} and the catalog's validation report on.
 */
export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;

  if (pattern === '<all_urls>') {
    return {
      source: pattern,
      schemes: ALL_URLS_SCHEMES,
      host: '*',
      path: '/*',
      hostRegex: null,
      pathRegex: /^.*$/,
    };
  }

  const schemeEnd = pattern.indexOf('://');
  if (schemeEnd <= 0) return null;
  const schemeText = pattern.slice(0, schemeEnd).toLowerCase();
  const rest = pattern.slice(schemeEnd + 3);

  let schemes: readonly string[];
  if (schemeText === '*') {
    schemes = STAR_SCHEMES;
  } else if (SCHEME_RE.test(schemeText)) {
    schemes = [schemeText];
  } else {
    return null;
  }

  const pathStart = rest.indexOf('/');
  if (pathStart < 0) return null;
  const host = rest.slice(0, pathStart).toLowerCase();
  const path = rest.slice(pathStart);
  if (path.length === 0 || path[0] !== '/') return null;

  // `file:` is the only scheme with an empty host; every other scheme needs one.
  if (host.length === 0 && schemeText !== 'file') return null;

  let hostRegex: RegExp | null = null;
  if (host === '*') {
    hostRegex = null;
  } else if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    // `*.` must be followed by a real hostname, and cannot itself contain `*`.
    if (suffix.length === 0 || suffix.includes('*')) return null;
    hostRegex = new RegExp('^(?:[^.]+\\.)*' + escapeRegExp(suffix) + '$', 'i');
  } else if (host.includes('*')) {
    // `*foo.com` / `foo.*.com` are not legal: `*` is only allowed as the whole
    // host or as a leading `*.` label.
    return null;
  } else if (host.length > 0) {
    hostRegex = new RegExp('^' + escapeRegExp(host) + '$', 'i');
  }

  return { source: pattern, schemes, host, path, hostRegex, pathRegex: globToRegExp(path) };
}

export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null;
}

/** True when `url` is inside the pattern's allow-list. Invalid input is never a match. */
export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  return parsed === null ? false : matchesParsed(parsed, url);
}

export function matchesParsed(parsed: ParsedMatchPattern, url: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  const scheme = parsedUrl.protocol.replace(/:$/, '').toLowerCase();
  if (!parsed.schemes.includes(scheme)) return false;
  if (parsed.hostRegex !== null && !parsed.hostRegex.test(parsedUrl.hostname)) return false;
  return parsed.pathRegex.test(parsedUrl.pathname + parsedUrl.search);
}

/** True when any pattern in the allow-list matches. An empty list matches nothing. */
export function matchesAny(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, url));
}
