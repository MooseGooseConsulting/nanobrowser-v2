// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, extractText } from './extractText';

describe('extractText', () => {
  it('prefers main over the rest of the body', () => {
    document.body.innerHTML = '<header>Skip this</header><main><p>Keep this</p></main><footer>And this</footer>';
    expect(extractText().text).toBe('Keep this');
  });

  it('falls back to [role=main] when there is no <main>', () => {
    document.body.innerHTML = '<div role="main"><p>Role main text</p></div><aside>Nope</aside>';
    expect(extractText().text).toBe('Role main text');
  });

  it('falls back to <article> when there is neither', () => {
    document.body.innerHTML = '<nav>Nope</nav><article><p>Article text</p></article>';
    expect(extractText().text).toBe('Article text');
  });

  it('falls back to the whole body when none of the three exist', () => {
    document.body.innerHTML = '<div><p>Body text</p></div>';
    expect(extractText().text).toBe('Body text');
  });

  it('collapses runs of whitespace to a single space', () => {
    document.body.innerHTML = '<main>  Line   one\n\n  Line   two  </main>';
    expect(extractText().text).toBe('Line one Line two');
  });

  it('renders an anchor with an href and text as "text (href)"', () => {
    document.body.innerHTML = '<main><p>See <a href="/more">more results</a> here.</p></main>';
    expect(extractText().text).toBe('See more results (/more) here.');
  });

  it('skips an anchor with no href or no text', () => {
    document.body.innerHTML =
      '<main><a name="anchor">skipped, no href</a><a href="/x"></a><p>kept text</p></main>';
    const text = extractText().text;
    expect(text).not.toContain('(/x)');
    expect(text).toContain('skipped, no href');
    expect(text).toContain('kept text');
  });

  it('omits script, style and hidden content, the same test as the snapshot', () => {
    document.body.innerHTML =
      '<main><script>evil()</script><style>.x{}</style>' +
      '<p hidden>hidden text</p><p aria-hidden="true">aria hidden</p><p>visible text</p></main>';
    const text = extractText().text;
    expect(text).toBe('visible text');
  });

  it('does not write anything to the DOM', () => {
    document.body.innerHTML = '<main><p>Some text</p></main>';
    const before = document.body.innerHTML;
    extractText();
    expect(document.body.innerHTML).toBe(before);
  });

  it('defaults to a 20000-char cap and marks truncation', () => {
    document.body.innerHTML = `<main><p>${'word '.repeat(5000)}</p></main>`;
    const result = extractText();
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('[truncated]')).toBe(true);
    expect(result.text.length).toBe(DEFAULT_MAX_CHARS + ' [truncated]'.length);
  });

  it('never returns more than the hard 60000-char cap even if asked', () => {
    document.body.innerHTML = `<main><p>${'word '.repeat(20000)}</p></main>`;
    const result = extractText({ maxChars: 1_000_000 });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(HARD_MAX_CHARS + ' [truncated]'.length);
  });

  it('does not truncate text that already fits', () => {
    document.body.innerHTML = '<main><p>short</p></main>';
    const result = extractText({ maxChars: 100 });
    expect(result).toMatchObject({ text: 'short', truncated: false });
  });
});

describe('startChar continuation', () => {
  // Regression: a live eBay scrape saved 38 of 60 listings because the readable
  // text ran past maxChars and there was no way to ask for the remainder.
  const fill = () => {
    document.body.innerHTML = `<main>${Array.from({ length: 200 }, (_, i) => `<p>listing number ${i} priced at $${i}.00</p>`).join('')}</main>`;
  };

  it('reports the whole length and where to resume', () => {
    fill();
    const first = extractText({ maxChars: 500 });
    expect(first.truncated).toBe(true);
    expect(first.totalChars).toBeGreaterThan(500);
    expect(first.nextStart).toBe(500);
    expect(first.text.endsWith('[truncated]')).toBe(true);
  });

  it('resumes from an offset and reaches the end without overlap or loss', () => {
    fill();
    let start = 0;
    let joined = '';
    for (let i = 0; i < 100; i++) {
      const page = extractText({ maxChars: 500, startChar: start });
      joined += page.text.replace(/ \[truncated\]$/, '');
      if (page.nextStart === undefined) break;
      start = page.nextStart;
    }
    expect(joined).toBe(extractText({ maxChars: 1_000_000 }).text);
    expect(joined).toContain('listing number 199');
  });

  it('returns an empty tail rather than throwing when startChar is past the end', () => {
    fill();
    const result = extractText({ maxChars: 500, startChar: 10_000_000 });
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });
});
