// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractText } from '@/src/page/extractText';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-current.html');

function mountFixture(): void {
  document.body.innerHTML = readFileSync(FIXTURE, 'utf8');
}

describe('extract_text against the eBay current-offerings fixture', () => {
  it('reads the <main> results list rather than the header chrome', () => {
    mountFixture();
    const text = extractText({ maxChars: 60_000 }).text;
    // A result title is present...
    expect(text).toContain('Corsair Vengeance 16GB DDR5 5200 Desktop Memory');
    // ...but the sort/refine header controls, which sit outside <main>, are not.
    expect(text).not.toContain('Save this search');
  });

  it('renders the item link as "text (href)"', () => {
    mountFixture();
    const text = extractText({ maxChars: 60_000 }).text;
    expect(text).toContain('(https://www.ebay.com/itm/158192070642?_trkparms=pageci%3A0)');
  });

  it('is whitespace-collapsed: no run of two spaces anywhere', () => {
    mountFixture();
    const text = extractText({ maxChars: 60_000 }).text;
    expect(text).not.toMatch(/ {2,}/);
    expect(text).not.toMatch(/\n/);
  });

  it('truncates when the page is longer than maxChars, with a trailing marker', () => {
    mountFixture();
    const result = extractText({ maxChars: 2000 });
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('[truncated]')).toBe(true);
    expect(result.text.length).toBe(2000 + ' [truncated]'.length);
  });

  it('does not truncate the whole fixture at the default 20000-char budget', () => {
    // This particular fixture's <main> content is well under the default cap; the
    // truncation mechanics themselves are covered generically in extractText.test.ts.
    mountFixture();
    expect(extractText().truncated).toBe(false);
  });

  it('captures every real listing when given the full 60000-char budget', () => {
    mountFixture();
    const text = extractText({ maxChars: 60_000 }).text;
    // The last real listing (index 59, before the 60000 cap kicks in).
    expect(text).toContain('itm/158192070701');
  });
});
