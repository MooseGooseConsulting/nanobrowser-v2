import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesAny, matchesPattern, parseMatchPattern } from './match-pattern';

describe('match patterns', () => {
  const table: Array<[pattern: string, url: string, expected: boolean, why: string]> = [
    // scheme wildcard
    ['*://hyperagent.com/*', 'https://hyperagent.com/threads', true, 'scheme * covers https'],
    ['*://hyperagent.com/*', 'http://hyperagent.com/threads', true, 'scheme * covers http'],
    ['*://hyperagent.com/*', 'ftp://hyperagent.com/threads', false, 'scheme * is http/https only'],
    ['https://hyperagent.com/*', 'http://hyperagent.com/', false, 'literal scheme is exact'],
    // subdomain wildcard
    ['*://*.hyperagent.com/*', 'https://www.hyperagent.com/x', true, 'leading *. matches a subdomain'],
    ['*://*.hyperagent.com/*', 'https://hyperagent.com/x', true, 'leading *. also matches the bare host'],
    ['*://*.hyperagent.com/*', 'https://a.b.hyperagent.com/x', true, 'leading *. matches nested subdomains'],
    ['*://*.hyperagent.com/*', 'https://nothyperagent.com/x', false, 'leading *. is label-aligned'],
    ['*://*/*', 'https://anything.example/x', true, 'bare * host matches any host'],
    // path wildcard
    ['https://hyperagent.com/thread/*', 'https://hyperagent.com/thread/t-1', true, 'trailing path wildcard'],
    ['https://hyperagent.com/thread/*', 'https://hyperagent.com/threads', false, 'path prefix must match'],
    ['https://hyperagent.com/*/edit', 'https://hyperagent.com/t-1/edit', true, 'interior path wildcard'],
    ['https://hyperagent.com/*', 'https://hyperagent.com/a?b=c', true, 'path match includes the query'],
    ['https://hyperagent.com/', 'https://hyperagent.com/', true, 'exact path, no wildcard'],
    ['https://hyperagent.com/', 'https://hyperagent.com/x', false, 'exact path rejects deeper URLs'],
    // host must match
    ['*://hyperagent.com/*', 'https://evil.com/hyperagent.com/', false, 'host is not matched from the path'],
    // <all_urls>
    ['<all_urls>', 'https://anything.example/x', true, '<all_urls> covers https'],
    ['<all_urls>', 'file:///tmp/x.html', true, '<all_urls> covers file'],
    ['<all_urls>', 'chrome://extensions/', false, '<all_urls> does not cover chrome:'],
    // case-insensitivity of the host
    ['*://hyperagent.com/*', 'https://HyperAgent.com/x', true, 'host comparison is case-insensitive'],
  ];

  it.each(table)('%s vs %s -> %s (%s)', (pattern, url, expected) => {
    expect(matchesPattern(pattern, url)).toBe(expected);
  });

  it.each([
    'https://hyperagent.com/*',
    '*://*/*',
    '*://*.hyperagent.com/',
    '<all_urls>',
    'file:///*',
  ])('accepts %s', (pattern) => {
    expect(isValidMatchPattern(pattern)).toBe(true);
  });

  it.each([
    '',
    'hyperagent.com',
    'https://hyperagent.com',
    'https:/hyperagent.com/*',
    '*://*foo.com/*',
    '*://foo.*.com/*',
    '*://*./*',
    'https:///*',
    '://hyperagent.com/*',
  ])('rejects %s', (pattern) => {
    expect(isValidMatchPattern(pattern)).toBe(false);
    expect(parseMatchPattern(pattern)).toBeNull();
    expect(matchesPattern(pattern, 'https://hyperagent.com/x')).toBe(false);
  });

  it('never matches a URL that will not parse', () => {
    expect(matchesPattern('<all_urls>', 'not a url')).toBe(false);
  });

  it('matchesAny is a union, and an empty allow-list matches nothing', () => {
    const allow = ['*://hyperagent.com/*', '*://www.hyperagent.com/*'];
    expect(matchesAny(allow, 'https://www.hyperagent.com/thread/t-1')).toBe(true);
    expect(matchesAny(allow, 'https://hyperagent.com/')).toBe(true);
    expect(matchesAny(allow, 'https://example.com/')).toBe(false);
    expect(matchesAny([], 'https://hyperagent.com/')).toBe(false);
  });
});
