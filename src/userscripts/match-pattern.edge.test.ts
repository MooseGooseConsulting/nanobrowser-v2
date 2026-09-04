/**
 * Two small gaps the review found in `match-pattern.test.ts`'s otherwise
 * thorough table: port handling (Chrome match patterns have no port grammar,
 * so a port in the URL must be ignored) and a `file:` pattern with a non-empty
 * host (previously unspecified by any test, positive or negative).
 */
import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesPattern } from './match-pattern';

describe('match patterns: port is not part of the grammar and must be ignored', () => {
  it('matches a URL with a port the same as one without, since patterns cannot express a port', () => {
    expect(matchesPattern('https://hyperagent.com/*', 'https://hyperagent.com:8443/x')).toBe(true);
    expect(matchesPattern('https://hyperagent.com/*', 'https://hyperagent.com/x')).toBe(true);
  });

  it('still refuses a different host regardless of port', () => {
    expect(matchesPattern('https://hyperagent.com/*', 'https://evil.com:8443/x')).toBe(false);
  });
});

describe('match patterns: file: scheme with a non-empty host', () => {
  it('parses as a literal (non-matching-in-practice) host rather than being accepted as the empty-host file: form', () => {
    // `file://etc/passwd` is grammatically well-formed (scheme file:, non-empty
    // path) but is a different thing from the empty-host `file:///etc/passwd`
    // form: "etc" is parsed as a literal host, which no real file: URL's
    // hostname will ever equal, so it can never match a real file: URL. This
    // pins that (intentional-looking, previously unasserted) behavior down.
    expect(isValidMatchPattern('file://etc/passwd')).toBe(true);
    expect(matchesPattern('file://etc/passwd', 'file:///etc/passwd')).toBe(false);
    expect(matchesPattern('file:///*', 'file:///etc/passwd')).toBe(true);
  });
});
