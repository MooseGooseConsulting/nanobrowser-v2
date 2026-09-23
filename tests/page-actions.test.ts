// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, getBox, hover, press, resetPointerForTests, scroll, select, type } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';

/**
 * Take a snapshot (the only thing that mints refs) and hand back the ref for `selector`.
 * Every action test goes through this, which also proves refs are the only handle actions
 * accept — there is no selector back door.
 */
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

/** `refOf` for an element no selector reaches (e.g. inside a shadow root). */
function refOfElement(target: Element): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error('no ref for element');
}

/** Record every event type a set of elements sees, in dispatch order. */
function recorder(target: EventTarget, types: string[]): string[] {
  const seen: string[] = [];
  for (const t of types) target.addEventListener(t, () => seen.push(t));
  return seen;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // The pointer is module state (where the last click landed); without this,
  // arrival-path moves from one test leak into the next test's cortège.
  resetPointerForTests();
});

const CLICK_TYPES = [
  'pointerover',
  'pointerenter',
  'mouseover',
  'mouseenter',
  'pointermove',
  'mousemove',
  'pointerdown',
  'mousedown',
  'focus',
  'pointerup',
  'mouseup',
  'click',
];

describe('click', () => {
  it('dispatches the full cortège in spec order, with focus between down and up', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const seen = recorder(button, CLICK_TYPES);
    expect(click(refOf('button'))).toEqual({ ok: true });
    expect(seen).toEqual(CLICK_TYPES);
  });

  it('lands inside the box but never dead-center (center is a bot tell)', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = () =>
      ({ x: 100, y: 200, width: 80, height: 40, top: 200, left: 100, right: 180, bottom: 240, toJSON: () => ({}) }) as DOMRect;
    const points: { clientX: number; clientY: number }[] = [];
    button.addEventListener('click', (e) => {
      points.push({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY });
    });
    const ref = refOf('button');
    for (let i = 0; i < 50; i++) click(ref);
    expect(points).toHaveLength(50);
    for (const point of points) {
      expect(point.clientX).toBeGreaterThanOrEqual(100);
      expect(point.clientX).toBeLessThanOrEqual(180);
      expect(point.clientY).toBeGreaterThanOrEqual(200);
      expect(point.clientY).toBeLessThanOrEqual(240);
    }
    // The jitter is uniform over a non-degenerate range, so 50 draws never all
    // land on the exact centre the old code always aimed at.
    expect(points.some((p) => p.clientX !== 140 || p.clientY !== 220)).toBe(true);
  });

  it('arrives along a path on a moved pointer instead of teleporting', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    button.getBoundingClientRect = () => rectAt(500, 500);
    const ref = refOf('button');
    click(ref);
    // The box jumps across the viewport; the next click must walk there.
    button.getBoundingClientRect = () => rectAt(100, 100);
    const seen: string[] = [];
    for (const t of ['pointermove', 'mousemove', 'pointerdown']) {
      button.addEventListener(t, () => seen.push(t));
    }
    click(ref);
    const downAt = seen.indexOf('pointerdown');
    expect(downAt).toBeGreaterThan(0);
    const movesBefore = seen.slice(0, downAt).filter((t) => t === 'pointermove' || t === 'mousemove');
    // Arrival path samples plus the hover pair — strictly more than a teleport's one pair.
    expect(movesBefore.length).toBeGreaterThan(2);
  });

  it('stamps movementX/Y as the delta from the previous dispatched position', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    button.getBoundingClientRect = () => rectAt(500, 500);
    const ref = refOf('button');
    click(ref);
    button.getBoundingClientRect = () => rectAt(100, 100);

    const moves: { x: number; y: number; dx: number; dy: number }[] = [];
    button.addEventListener('mousemove', (e) => {
      const m = e as MouseEvent;
      moves.push({ x: m.clientX, y: m.clientY, dx: m.movementX ?? 0, dy: m.movementY ?? 0 });
    });
    click(ref);

    // The arrival path moved, so some sample carries a nonzero delta...
    expect(moves.length).toBeGreaterThan(2);
    expect(moves.some((m) => m.dx !== 0 || m.dy !== 0)).toBe(true);
    // ...and every delta matches the coordinate stream (first event: no previous).
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i]!.dx).toBeCloseTo(moves[i]!.x - moves[i - 1]!.x, 9);
      expect(moves[i]!.dy).toBeCloseTo(moves[i]!.y - moves[i - 1]!.y, 9);
    }
  });

  it('offsets screenX/screenY by the window origin instead of echoing clientX', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const origX = (window as unknown as { screenX: number }).screenX;
    const origY = (window as unknown as { screenY: number }).screenY;
    Object.defineProperty(window, 'screenX', { value: 100, configurable: true });
    Object.defineProperty(window, 'screenY', { value: 50, configurable: true });
    try {
      let observed: { clientX: number; clientY: number; screenX: number; screenY: number } | null = null;
      button.addEventListener('click', (e) => {
        const me = e as MouseEvent;
        observed = { clientX: me.clientX, clientY: me.clientY, screenX: me.screenX, screenY: me.screenY };
      });
      click(refOf('button'));
      expect(observed).not.toBeNull();
      expect(observed!.screenX - observed!.clientX).toBe(100);
      expect(observed!.screenY - observed!.clientY).toBe(50);
    } finally {
      Object.defineProperty(window, 'screenX', { value: origX, configurable: true });
      Object.defineProperty(window, 'screenY', { value: origY, configurable: true });
    }
  });

  it('refuses the click when another element covers both the jittered point and the center', () => {
    document.body.innerHTML = '<button>Go</button><div>cover</div>';
    const cover = document.querySelector('div') as HTMLElement;
    const ref = refOf('button');
    const had = 'elementFromPoint' in document;
    const orig = (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => cover;
    try {
      // `cover` is a sibling the button does not contain, so neither aim point verifies.
      expect(click(ref)).toEqual({
        ok: false,
        error: 'element is occluded at its click point by another element',
      });
    } finally {
      if (had) (document as unknown as { elementFromPoint: unknown }).elementFromPoint = orig;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('clicks into an open shadow root instead of mistaking the host for an occluder', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.querySelector('#host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Go</button>';
    const inner = shadow.querySelector('button') as HTMLElement;
    const ref = refOfElement(inner);

    // Document hit testing retargets to the host; the shadow root resolves inward.
    const docTarget = document as unknown as { elementFromPoint: unknown };
    const hadDoc = 'elementFromPoint' in document;
    const origDoc = docTarget.elementFromPoint;
    docTarget.elementFromPoint = () => host;
    const shadowTarget = shadow as unknown as { elementFromPoint: unknown };
    const hadShadow = 'elementFromPoint' in shadow;
    const origShadow = shadowTarget.elementFromPoint;
    shadowTarget.elementFromPoint = () => inner;
    try {
      expect(click(ref)).toEqual({ ok: true });
    } finally {
      if (hadDoc) docTarget.elementFromPoint = origDoc;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
      if (hadShadow) shadowTarget.elementFromPoint = origShadow;
      else delete (shadow as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('accepts a host hit for a shadow-rooted target (the closed-root shape) rather than vetoing it', () => {
    // A closed root is unreachable in jsdom (no chrome.dom.openOrClosedShadowRoot),
    // so simulate exactly what the verifier sees there: the target's root is a
    // ShadowRoot and the hit lands on its host.
    document.body.innerHTML = '<button>Go</button><div id="h2"></div>';
    const other = document.querySelector('#h2') as HTMLElement;
    const root = other.attachShadow({ mode: 'open' });
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refOf('button');
    const docTarget = document as unknown as { elementFromPoint: unknown };
    const hadDoc = 'elementFromPoint' in document;
    const origDoc = docTarget.elementFromPoint;
    docTarget.elementFromPoint = () => other;
    const rootStub = vi.spyOn(button, 'getRootNode').mockReturnValue(root);
    try {
      expect(click(ref)).toEqual({ ok: true });
    } finally {
      rootStub.mockRestore();
      if (hadDoc) docTarget.elementFromPoint = origDoc;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('sets realistic pointer fields: non-zero id, mouse type, primary, pressure while down', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const captured: Record<string, PointerEvent> = {};
    for (const t of ['pointerdown', 'pointerup']) {
      button.addEventListener(t, (e) => {
        captured[t] = e as PointerEvent;
      });
    }
    click(refOf('button'));
    const down = captured.pointerdown as PointerEvent;
    const up = captured.pointerup as PointerEvent;
    expect(down.pointerId).not.toBe(0);
    expect(down.pointerType).toBe('mouse');
    expect(down.isPrimary).toBe(true);
    expect(down.pressure).toBe(0.5);
    expect(down.buttons).toBe(1);
    expect(up.pressure).toBe(0);
    expect(up.buttons).toBe(0);
  });

  it('every event it emits is isTrusted:false — the R-13 tier-1 tell', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const trust: boolean[] = [];
    // `focus` is excluded: that one comes from calling the real `HTMLElement.focus()` API,
    // so it is genuinely trusted. Every event this module *synthesises* is not, and no
    // amount of care changes that — it is why R-13's escalation tier exists.
    const dispatched = CLICK_TYPES.filter((t) => t !== 'focus');
    for (const t of dispatched) button.addEventListener(t, (e) => trust.push(e.isTrusted));
    click(refOf('button'));
    expect(trust.length).toBe(dispatched.length);
    expect(trust.every((v) => v === false)).toBe(true);
  });

  it('scrolls the element into view only when it is outside the viewport', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const inView = document.getElementById('a') as HTMLElement;
    const outOfView = document.getElementById('b') as HTMLElement;
    inView.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) }) as DOMRect;
    outOfView.getBoundingClientRect = () =>
      ({ x: 0, y: 9000, width: 10, height: 10, top: 9000, left: 0, right: 10, bottom: 9010, toJSON: () => ({}) }) as DOMRect;
    inView.scrollIntoView = vi.fn();
    outOfView.scrollIntoView = vi.fn();
    click(refOf('#a'));
    click(refOf('#b'));
    expect(inView.scrollIntoView).not.toHaveBeenCalled();
    expect(outOfView.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('reports an error for an unknown or stale ref instead of throwing', () => {
    document.body.innerHTML = '<button>Go</button>';
    snapshot();
    expect(click('e999')).toEqual({ ok: false, error: 'unknown or stale ref: e999' });
  });

  it('attaches nothing to the document or window', () => {
    document.body.innerHTML = '<button>Go</button>';
    const ref = refOf('button');
    const onDocument = vi.spyOn(document, 'addEventListener');
    const onWindow = vi.spyOn(window, 'addEventListener');
    click(ref);
    hover(ref);
    scroll({ ref });
    expect(onDocument).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('leaves no listener, timer or observer in the source at all', () => {
    // A grep, not a spy: the invariant is that this tier is synchronous and stateless, and
    // a spy only proves it for the paths one test happens to walk (R-02).
    for (const file of ['src/page/actions.ts', 'src/page/snapshot.ts', 'src/page/accname.ts']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
      expect(source).not.toMatch(/addEventListener/);
      expect(source).not.toMatch(/MutationObserver|IntersectionObserver/);
      // And no page mutation: no attribute/style writes, no node insertion.
      expect(source).not.toMatch(/setAttribute|\.style\.|appendChild|insertBefore|innerHTML\s*=/);
    }
  });
});

describe('hover', () => {
  it('emits the enter cortège without any press', () => {
    document.body.innerHTML = '<div tabindex="0">Menu</div>';
    const el = document.querySelector('div') as HTMLElement;
    const seen = recorder(el, [...CLICK_TYPES]);
    expect(hover(refOf('div'))).toEqual({ ok: true });
    expect(seen).toEqual(['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']);
  });
});

describe('type', () => {
  it('goes through the prototype value setter so a React-style tracker sees the change', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;

    // Stand in for React's instance-level value tracker: an own `value` property that
    // swallows plain assignment. Only the prototype setter gets past it.
    let tracked = '';
    const protoSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const protoGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return protoGetter?.call(this) ?? '';
      },
      set() {
        tracked = 'swallowed';
      },
    });

    const events: string[] = [];
    for (const t of ['input', 'change']) input.addEventListener(t, () => events.push(t));

    expect(type(refOf('input'), 'hello@example.com')).toEqual({ ok: true });
    expect(tracked).toBe('');
    expect(protoGetter?.call(input)).toBe('hello@example.com');
    expect(protoSetter).toBeTypeOf('function');
    expect(events).toEqual(['input', 'change']);
  });

  it('fires input then change, both bubbling', () => {
    document.body.innerHTML = '<form><input type="text"></form>';
    const seen: string[] = [];
    const form = document.querySelector('form') as HTMLFormElement;
    for (const t of ['input', 'change']) form.addEventListener(t, () => seen.push(t));
    type(refOf('input'), 'abc');
    expect(seen).toEqual(['input', 'change']);
  });

  it('replaces by default and appends when clear is false', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'seed ';
    type(refOf('input'), 'more');
    expect(input.value).toBe('more');
    type(refOf('input'), '!', { clear: false });
    expect(input.value).toBe('more!');
  });

  it('focuses the field before writing', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    type(refOf('input'), 'x');
    expect(document.activeElement).toBe(input);
  });

  it('works on a textarea', () => {
    document.body.innerHTML = '<textarea></textarea>';
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(type(refOf('textarea'), 'note')).toEqual({ ok: true });
    expect(area.value).toBe('note');
  });

  it('uses execCommand("insertText") for contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true" tabindex="0"></div>';
    const calls: Array<[string, unknown]> = [];
    (document as unknown as { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
      calls.push([cmd, value]);
      return true;
    };
    expect(type(refOf('div'), 'rich text')).toEqual({ ok: true });
    expect(calls).toEqual([
      ['selectAll', undefined],
      ['delete', undefined],
      ['insertText', 'rich text'],
    ]);
  });

  it('refuses a non-text element rather than pretending', () => {
    document.body.innerHTML = '<button>Go</button>';
    expect(type(refOf('button'), 'x')).toEqual({ ok: false, error: 'element <button> is not a text field' });
  });
});

describe('press', () => {
  it('sends keydown, keypress and keyup with matching key and code', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    const seen: Array<{ type: string; key: string; code: string }> = [];
    for (const t of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(t, (e) => {
        const ke = e as KeyboardEvent;
        seen.push({ type: t, key: ke.key, code: ke.code });
      });
    }
    expect(press('Enter')).toEqual({ ok: true });
    expect(seen).toEqual([
      { type: 'keydown', key: 'Enter', code: 'Enter' },
      { type: 'keypress', key: 'Enter', code: 'Enter' },
      { type: 'keyup', key: 'Enter', code: 'Enter' },
    ]);
  });

  it('omits keypress for non-character keys and maps letters and digits to codes', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    const seen: string[] = [];
    const codes: string[] = [];
    for (const t of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(t, (e) => {
        seen.push(t);
        codes.push((e as KeyboardEvent).code);
      });
    }
    press('Escape');
    expect(seen).toEqual(['keydown', 'keyup']);
    seen.length = 0;
    codes.length = 0;
    press('a');
    expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
    expect(codes.every((c) => c === 'KeyA')).toBe(true);
    codes.length = 0;
    press('7');
    expect(codes.every((c) => c === 'Digit7')).toBe(true);
  });

  it('inserts no character — real typing is the R-13 escalation, not this', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    press('a');
    expect(input.value).toBe('');
  });
});

describe('select', () => {
  it('sets the value by option value and fires input then change', () => {
    document.body.innerHTML =
      '<select aria-label="Size"><option value="s">Small</option><option value="m">Medium</option></select>';
    const el = document.querySelector('select') as HTMLSelectElement;
    const seen: string[] = [];
    for (const t of ['input', 'change']) el.addEventListener(t, () => seen.push(t));
    expect(select(refOf('select'), 'm')).toEqual({ ok: true });
    expect(el.value).toBe('m');
    expect((el.options[1] as HTMLOptionElement).selected).toBe(true);
    expect(seen).toEqual(['input', 'change']);
  });

  it('falls back to matching the visible option label', () => {
    document.body.innerHTML =
      '<select aria-label="Size"><option value="s">Small</option><option value="m">Medium</option></select>';
    expect(select(refOf('select'), 'Medium')).toEqual({ ok: true });
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('m');
  });

  it('reports a missing option and a non-select target', () => {
    document.body.innerHTML = '<select aria-label="Size"><option value="s">Small</option></select><button>b</button>';
    expect(select(refOf('select'), 'xl')).toEqual({ ok: false, error: 'no option with value or label "xl"' });
    expect(select(refOf('button'), 'x')).toEqual({ ok: false, error: 'element <button> is not a <select>' });
  });
});

describe('scroll', () => {
  it('scrolls a ref into view instantly', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.scrollIntoView = vi.fn();
    expect(scroll({ ref: refOf('button') })).toEqual({ ok: true });
    expect(button.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('scrolls the window by direction, defaulting to ~80% of the viewport', () => {
    const scrollBy = vi.fn();
    (window as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    expect(scroll({ direction: 'down' })).toEqual({ ok: true });
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 800, behavior: 'instant' });
    scroll({ direction: 'up', amount: 120 });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: -120, behavior: 'instant' });
    scroll({ direction: 'right' });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 400, top: 0, behavior: 'instant' });
  });
});

describe('getBox', () => {
  it('returns viewport coordinates, the centre point, and the device pixel ratio', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 100, height: 50, top: 20, left: 10, right: 110, bottom: 70, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    expect(getBox(refOf('button'))).toEqual({
      ok: true,
      box: { x: 10, y: 20, width: 100, height: 50, centerX: 60, centerY: 45 },
      devicePixelRatio: 2,
    });
  });

  it('reports an error for a stale ref', () => {
    document.body.innerHTML = '<button>Go</button>';
    snapshot();
    expect(getBox('e42')).toEqual({ ok: false, error: 'unknown or stale ref: e42' });
  });
});
