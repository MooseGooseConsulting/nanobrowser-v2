// @vitest-environment jsdom
/**
 * Three spec-correct but previously-unasserted `accname.ts` behaviours the
 * review found: a hidden `aria-labelledby` target is exempt from the hidden
 * check (only a direct self-reference cycle was tested, not a hidden target);
 * a mutual two-element `aria-labelledby` cycle does not infinite-loop (only a
 * single-element self-reference was tested); and `aria-label` overrides a
 * native `<label>` (only each was tested in isolation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeAccessibleName } from '@/src/page/accname';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function one(html: string, selector: string): Element {
  const el = mount(html).querySelector(selector);
  if (!el) throw new Error(`no element matched ${selector}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('computeAccessibleName: aria-labelledby targets are exempt from the hidden check', () => {
  it('names from a hidden (display:none) aria-labelledby target', () => {
    const el = one(
      '<span id="lbl" style="display:none">Real name</span><button aria-labelledby="lbl">x</button>',
      'button',
    );
    expect(computeAccessibleName(el)).toBe('Real name');
  });

  it('names from an aria-hidden="true" aria-labelledby target', () => {
    const el = one('<span id="lbl" aria-hidden="true">Hidden but named</span><button aria-labelledby="lbl">x</button>', 'button');
    expect(computeAccessibleName(el)).toBe('Hidden but named');
  });
});

describe('computeAccessibleName: aria-labelledby does not infinite-loop on a mutual cycle', () => {
  it('a two-element mutual cycle resolves each to its own fallback content, not the other\'s', () => {
    const root = mount(
      '<button id="a" aria-labelledby="b">fallback-a</button>' +
        '<button id="b" aria-labelledby="a">fallback-b</button>',
    );
    const a = root.querySelector('#a')!;
    const b = root.querySelector('#b')!;

    // Neither call hangs; each resolves via its own content since the other's
    // aria-labelledby is not followed a second level deep (AccName step 2B).
    expect(computeAccessibleName(a)).toBe('fallback-b');
    expect(computeAccessibleName(b)).toBe('fallback-a');
  });

  it('a three-element cycle (a -> b -> c -> a) still terminates', () => {
    const root = mount(
      '<span id="a" aria-labelledby="b">A</span>' +
        '<span id="b" aria-labelledby="c">B</span>' +
        '<button id="c" aria-labelledby="a">C</button>',
    );
    const c = root.querySelector('#c')!;
    expect(() => computeAccessibleName(c)).not.toThrow();
  });
});

describe('computeAccessibleName: aria-label overrides a native <label>', () => {
  it('prefers aria-label over a <label for=...> association', () => {
    const el = one('<label for="e">Wrong</label><input id="e" aria-label="Right">', 'input');
    expect(computeAccessibleName(el)).toBe('Right');
  });

  it('falls back to the native <label> when aria-label is absent', () => {
    const el = one('<label for="e">Correct</label><input id="e">', 'input');
    expect(computeAccessibleName(el)).toBe('Correct');
  });
});
