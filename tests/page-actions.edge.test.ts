// @vitest-environment jsdom
/**
 * Six failure branches the review found untested in `page-actions.test.ts`:
 * `type()`'s four fail() paths (unfocusable element, no native value setter,
 * execCommand rejected, execCommand unavailable) and `scroll()`'s two
 * (no window, scrollBy unavailable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scroll, type } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';

function refOf(selector: string): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  const target = document.querySelector(selector);
  if (!target) throw new Error(`no element matched ${selector}`);
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error(`no ref for ${selector}`);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('type(): failure branches', () => {
  it('reports "element is not focusable" when focus() throws', () => {
    document.body.innerHTML = '<input id="f">';
    const el = document.getElementById('f') as HTMLInputElement;
    el.focus = () => {
      throw new Error('cannot focus this element');
    };
    const ref = refOf('#f');

    const result = type(ref, 'hi');

    expect(result).toEqual({ ok: false, error: 'element is not focusable' });
  });

  it('reports "no native value setter" when the direct prototype has none', () => {
    document.body.innerHTML = '<input id="f">';
    const el = document.getElementById('f') as HTMLInputElement;
    const ref = refOf('#f');
    // Jump the element's direct prototype past HTMLInputElement.prototype
    // (which is where the native `value` setter actually lives) to
    // HTMLElement.prototype, which has none -- but keep the rest of the
    // chain (Node.prototype etc.) intact so `isConnected` and everything
    // `resolveRef`/`element()` needs still works.
    Object.setPrototypeOf(el, HTMLElement.prototype);

    const result = type(ref, 'hi');

    expect(result).toEqual({ ok: false, error: 'no native value setter on this element' });
  });

  it('reports "execCommand(\\"insertText\\") was rejected" when it returns false', () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true"></div>';
    const ref = refOf('#ce');
    // jsdom does not implement execCommand at all, so it must be installed
    // before it can be stubbed.
    (document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = (cmd: string) =>
      cmd !== 'insertText';

    const result = type(ref, 'hi');

    expect(result).toEqual({ ok: false, error: 'execCommand("insertText") was rejected' });
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('reports "execCommand(\\"insertText\\") is unavailable" when it throws', () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true"></div>';
    const ref = refOf('#ce');
    (document as unknown as { execCommand: () => boolean }).execCommand = () => {
      throw new Error('not supported');
    };

    const result = type(ref, 'hi');

    expect(result).toEqual({ ok: false, error: 'execCommand("insertText") is unavailable' });
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
});

describe('scroll(): failure branches', () => {
  it('reports "no window to scroll" when document.defaultView is null', () => {
    const spy = vi.spyOn(document, 'defaultView', 'get').mockReturnValue(null);

    const result = scroll({ direction: 'down' });

    expect(result).toEqual({ ok: false, error: 'no window to scroll' });
    spy.mockRestore();
  });

  it('reports "window.scrollBy is unavailable" when it is missing', () => {
    const original = window.scrollBy;
    // @ts-expect-error -- deliberately removing it to prove the fallback
    delete window.scrollBy;

    const result = scroll({ direction: 'down' });

    expect(result).toEqual({ ok: false, error: 'window.scrollBy is unavailable' });
    window.scrollBy = original;
  });
});
