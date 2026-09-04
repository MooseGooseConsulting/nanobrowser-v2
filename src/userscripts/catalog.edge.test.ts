/**
 * The review found no size cap anywhere on stored userscript source (an
 * explicitly-named required edge case: "oversized scripts"). `validateUserscript`
 * now rejects code over `MAX_CODE_BYTES`; this proves the boundary.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MAX_CODE_BYTES, saveUserscript, validateUserscript } from './catalog';

const draft = { name: 'big', matches: ['*://hyperagent.com/*'], code: 'x' };

beforeEach(() => {
  fakeBrowser.reset();
});

describe('validateUserscript: code size cap', () => {
  it('accepts code exactly at the limit', () => {
    const result = validateUserscript({ ...draft, code: 'x'.repeat(MAX_CODE_BYTES) });
    expect(result.ok).toBe(true);
  });

  it('rejects code one byte over the limit, with a clear reason', () => {
    const result = validateUserscript({ ...draft, code: 'x'.repeat(MAX_CODE_BYTES + 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errors.some((e) => e.includes('exceeds') && e.includes('limit'))).toBe(true);
  });

  it('rejects an oversized script end-to-end through saveUserscript', async () => {
    await expect(
      saveUserscript({ ...draft, code: 'x'.repeat(MAX_CODE_BYTES * 4) }),
    ).rejects.toThrow(/exceeds/);
  });

  it('an oversized-code error does not mask other validation errors', () => {
    const result = validateUserscript({ name: '', matches: [], code: 'x'.repeat(MAX_CODE_BYTES + 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
