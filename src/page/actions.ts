/**
 * In-page action primitives — the R-13 **tier 1 ("in-page")** input path, and the default.
 *
 * EVERY event dispatched from this file carries `isTrusted: false`, unavoidably and
 * unforgeably: inside an extension there is no content-script API that produces trusted
 * input (I-01). That is ranked-leak row 1, it cannot be fixed here, and it is precisely why
 * R-13 exists. When a site gates on `isTrusted`, on transient activation (file pickers,
 * clipboard, `window.open`, fullscreen, payment), or on real character-by-character typing,
 * the caller must escalate to the `chrome.debugger` + CDP `Input` tier instead of asking
 * this module to try harder. Nothing here fakes trust.
 *
 * Stealth rules that hold for every function below (R-02):
 *   - no DOM writes beyond the value/selection changes the action itself is *for*
 *     (no marker attributes, no injected styles, no `id`s, no overlays);
 *   - no globals added to the page — this module lives in the ISOLATED world;
 *   - no listener and no timer survives a call: every action is synchronous and leaves
 *     nothing attached.
 *
 * Event cortège and pointer-field realism follow
 * docs/research/trusted-input-and-stealth.md §hygiene rules 4, 5, 7 and 12.
 */
import { resolveRef } from './snapshot';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface BoxResult extends ActionResult {
  /** Viewport ("client") coordinates, the same frame `chrome.debugger` Input and OS-level
   *  tiers need to click at real coordinates. */
  box?: { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
  /** Page-level metrics so the caller can convert to device pixels for a screenshot overlay. */
  devicePixelRatio?: number;
}

export interface TypeOptions {
  /** Replace the field's existing content instead of appending. Default true. */
  clear?: boolean;
}

export interface ScrollOptions {
  ref?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Pixels. Defaults to ~80% of the viewport along the scroll axis. */
  amount?: number;
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

function element(ref: string): { el: HTMLElement } | { error: string } {
  const found = resolveRef(ref);
  if (!found) return { error: `unknown or stale ref: ${ref}` };
  return { el: found as HTMLElement };
}

function view(el: Element): (Window & typeof globalThis) | null {
  return (el.ownerDocument?.defaultView ?? null) as (Window & typeof globalThis) | null;
}

function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function isInViewport(el: Element): boolean {
  const w = view(el);
  if (!w) return true;
  const r = rectOf(el);
  return r.top >= 0 && r.left >= 0 && r.bottom <= w.innerHeight && r.right <= w.innerWidth;
}

/**
 * Scroll the element into view only when it is not already there. `behavior: 'instant'` is
 * required, not cosmetic: smooth scrolling makes the coordinates we are about to dispatch at
 * stale mid-flight (hygiene rule 12).
 */
function scrollElementIntoView(el: HTMLElement): void {
  if (typeof el.scrollIntoView !== 'function') return;
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      // Nothing more to try; the dispatch below still uses whatever rect we can read.
    }
  }
}

function ensureVisible(el: HTMLElement): void {
  if (isInViewport(el)) return;
  scrollElementIntoView(el);
}

interface Point {
  clientX: number;
  clientY: number;
}

function centerOf(el: Element): Point {
  const r = rectOf(el);
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

/**
 * A single, stable, non-zero pointer id per module load. Real pointer streams never use
 * `pointerId: 0` and detectors check for it (ranked-leak row 8).
 */
const POINTER_ID = 1;

function pointerInit(point: Point, buttons: number, pressure: number): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: null,
    detail: 0,
    button: 0,
    buttons,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: point.clientX,
    screenY: point.clientY,
    pointerId: POINTER_ID,
    pointerType: 'mouse',
    isPrimary: true,
    pressure,
    width: 1,
    height: 1,
  };
}

function mouseInit(point: Point, buttons: number, detail: number): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail,
    button: 0,
    buttons,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: point.clientX,
    screenY: point.clientY,
  };
}

/**
 * `PointerEvent` is absent in some non-browser DOM implementations used by tests. Fall back
 * to a `MouseEvent` carrying the same fields rather than skipping the event.
 */
function pointerEvent(type: string, init: PointerEventInit): Event {
  const Ctor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (typeof Ctor === 'function') return new Ctor(type, init);
  return new MouseEvent(type, init as MouseEventInit);
}

function dispatch(el: Element, event: Event): void {
  el.dispatchEvent(event);
}

/** The pointer-enter half of a hover, shared by `hover()` and `click()`. */
function dispatchHover(el: HTMLElement, point: Point): void {
  dispatch(el, pointerEvent('pointerover', pointerInit(point, 0, 0)));
  dispatch(el, pointerEvent('pointerenter', { ...pointerInit(point, 0, 0), bubbles: false }));
  dispatch(el, new MouseEvent('mouseover', mouseInit(point, 0, 0)));
  dispatch(el, new MouseEvent('mouseenter', { ...mouseInit(point, 0, 0), bubbles: false }));
  dispatch(el, pointerEvent('pointermove', pointerInit(point, 0, 0)));
  dispatch(el, new MouseEvent('mousemove', mouseInit(point, 0, 0)));
}

/**
 * Full click cortège in spec order, at the element's box centre in viewport coordinates.
 *
 * `pointerover → pointerenter → mouseover → mouseenter → pointermove → mousemove →
 *  pointerdown → mousedown → focus → pointerup → mouseup → click`
 *
 * `pressure` is 0.5 while the button is down and 0 while it is up (ranked-leak row 6);
 * `buttons` is consistent across the sequence.
 */
export function click(ref: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  ensureVisible(el);
  const point = centerOf(el);

  dispatchHover(el, point);
  dispatch(el, pointerEvent('pointerdown', pointerInit(point, 1, 0.5)));
  dispatch(el, new MouseEvent('mousedown', mouseInit(point, 1, 1)));
  try {
    el.focus({ preventScroll: true });
  } catch {
    // Non-focusable elements throw or no-op; the click still stands.
  }
  dispatch(el, pointerEvent('pointerup', pointerInit(point, 0, 0)));
  dispatch(el, new MouseEvent('mouseup', mouseInit(point, 0, 1)));
  dispatch(el, new MouseEvent('click', mouseInit(point, 0, 1)));
  return { ok: true };
}

/** Pointer/mouse enter sequence without a press. Useful for hover-revealed menus. */
export function hover(ref: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  ensureVisible(found.el);
  dispatchHover(found.el, centerOf(found.el));
  return { ok: true };
}

/**
 * Assign through the prototype's native `value` setter.
 *
 * A plain `el.value = x` is swallowed by React's instance-level value tracker, so the
 * framework never sees the change (facebook/react#10135; this is `dom-testing-library`'s
 * `setNativeValue`). Going through the prototype descriptor defeats the tracker without
 * patching anything on the page.
 */
function setNativeValue(el: HTMLElement, value: string): boolean {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, value);
    return true;
  }
  const own = Object.getOwnPropertyDescriptor(el, 'value');
  if (own?.set) {
    own.set.call(el, value);
    return true;
  }
  return false;
}

function fireInputAndChange(el: HTMLElement): void {
  dispatch(el, new Event('input', { bubbles: true, composed: true }));
  dispatch(el, new Event('change', { bubbles: true }));
}

/**
 * Set the text of an input, textarea, or contenteditable.
 *
 * This is NOT keystroke emulation: untrusted `KeyboardEvent`s fire listeners but insert no
 * characters, so per-character typing is an R-13 escalation case, not something to fake.
 * Sites that key off `keydown`/`keyup` per character (some autocompletes) need the debugger
 * tier.
 */
export function type(ref: string, text: string, options: TypeOptions = {}): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  const clear = options.clear ?? true;
  ensureVisible(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    return fail('element is not focusable');
  }

  const tag = el.localName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const current = (el as HTMLInputElement).value ?? '';
    const next = clear ? text : current + text;
    if (!setNativeValue(el, next)) return fail('no native value setter on this element');
    fireInputAndChange(el);
    return { ok: true };
  }

  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
    const doc = el.ownerDocument;
    // execCommand is deprecated but is still the only way to mutate a contenteditable with
    // a correct `inputType` and a working undo stack without OS-level keys. A bare
    // dispatched InputEvent changes nothing in the DOM at all.
    try {
      if (clear) {
        doc.execCommand('selectAll', false);
        doc.execCommand('delete', false);
      }
      const inserted = doc.execCommand('insertText', false, text);
      if (!inserted) return fail('execCommand("insertText") was rejected');
    } catch {
      return fail('execCommand("insertText") is unavailable');
    }
    return { ok: true };
  }

  return fail(`element <${tag}> is not a text field`);
}

/** `key` -> `code`, for the keys an agent actually presses. Unlisted keys get a best guess. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
};

function codeFor(key: string): string {
  const known = KEY_CODES[key];
  if (known) return known;
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/**
 * Dispatch a keydown/keypress/keyup triple at the focused element.
 *
 * Handlers run; **no character is inserted and no default action fires** (untrusted events
 * have not run default actions since Chrome 53, `click` being the grandfathered exception).
 * Use this for `Enter`/`Escape`/arrow-key handlers, not for entering text — that is `type()`,
 * and real typing is an R-13 escalation.
 */
export function press(key: string): ActionResult {
  const doc = (globalThis as unknown as { document: Document }).document;
  const target: Element = (doc.activeElement as Element | null) ?? doc.body ?? doc.documentElement;
  if (!target) return fail('no focused element to receive the key');
  const code = codeFor(key);
  const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, composed: true };
  dispatch(target, new KeyboardEvent('keydown', init));
  // keypress only ever fired for character-producing keys; Enter is the historical exception.
  if (key.length === 1 || key === 'Enter') {
    dispatch(target, new KeyboardEvent('keypress', init));
  }
  dispatch(target, new KeyboardEvent('keyup', init));
  return { ok: true };
}

/**
 * Choose a `<select>` option by value, falling back to matching the option's visible label.
 * Plain assignment is correct here — `<select>` has no React value tracker to defeat.
 */
export function select(ref: string, value: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  if (el.localName.toLowerCase() !== 'select') return fail(`element <${el.localName}> is not a <select>`);
  const sel = el as unknown as HTMLSelectElement;
  const options = Array.from(sel.options ?? []);
  const match =
    options.find((o) => o.value === value) ??
    options.find((o) => (o.textContent ?? '').trim() === value.trim());
  if (!match) return fail(`no option with value or label ${JSON.stringify(value)}`);
  ensureVisible(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    // A select can be unfocusable in exotic layouts; the value change still stands.
  }
  sel.value = match.value;
  match.selected = true;
  fireInputAndChange(el);
  return { ok: true };
}

/** Scroll a specific element's box into view, or scroll the window along an axis. */
export function scroll(options: ScrollOptions = {}): ActionResult {
  const doc = (globalThis as unknown as { document: Document }).document;
  const win = doc.defaultView;
  if (options.ref) {
    const found = element(options.ref);
    if ('error' in found) return fail(found.error);
    scrollElementIntoView(found.el);
    return { ok: true };
  }
  if (!win) return fail('no window to scroll');
  const direction = options.direction ?? 'down';
  const vertical = direction === 'up' || direction === 'down';
  const span = vertical ? win.innerHeight : win.innerWidth;
  const amount = options.amount ?? Math.round(span * 0.8);
  const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
  if (typeof win.scrollBy === 'function') {
    win.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  } else {
    return fail('window.scrollBy is unavailable');
  }
  return { ok: true };
}

/**
 * Viewport-relative geometry for a ref.
 *
 * This is the handoff point between the DOM tier and the pixel tiers (R-08 `pixels`/`both`,
 * R-13 escalation): the debugger and OS-level tiers click at coordinates, and these are the
 * coordinates they use. `devicePixelRatio` comes along so a captured screenshot's device
 * pixels can be mapped back onto these CSS pixels.
 */
export function getBox(ref: string): BoxResult {
  const found = element(ref);
  if ('error' in found) return { ok: false, error: found.error };
  const r = rectOf(found.el);
  const win = view(found.el);
  return {
    ok: true,
    box: {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
    },
    devicePixelRatio: win?.devicePixelRatio ?? 1,
  };
}
