/**
 * Accessibility-style text snapshot of the live page, built entirely from read-only DOM APIs.
 *
 * Runs inside the on-demand injected script, ISOLATED world only (R-01, R-02, R-08 `dom` mode).
 *
 * Stealth invariants this file must never break (docs/research/bot-detection-research.md,
 * ranked-leak rows 4 and 11-12):
 *   - zero DOM writes: no attribute stamping, no `id` assignment, no injected style or overlay,
 *     not even a transient one ("do not clean up — not mutating is the only win");
 *   - no page globals: element handles live in a module-level `Map`/`WeakMap` in the isolated
 *     world, which the page cannot reach;
 *   - no listeners and no timers: a snapshot is a synchronous read that leaves nothing behind.
 *
 * Set-of-marks (C-05) is deliberately NOT built. See `SET_OF_MARKS_EXTENSION_POINT` below.
 */
import {
  INTERACTIVE_ROLES,
  LANDMARK_ROLES,
  TEXT_INPUT_TYPES,
  computeAccessibleName,
  computeRole,
  headingLevel,
} from './accname';

export interface SnapshotOptions {
  /** Hard cap on emitted nodes. Sets `truncated` when hit. Default 400. */
  maxNodes?: number;
  /** Emit only actionable elements (plus iframes); drop landmarks and free text. Default false. */
  interactiveOnly?: boolean;
  /** Drop zero-size elements and elements fully outside the viewport. Default false. */
  skipOffscreen?: boolean;
  /** Per-name / per-text character cap before ellipsis. Default 120. */
  maxTextLength?: number;
  /** Root to walk. Defaults to the injected script's own `document`. */
  root?: Document;
}

export interface SnapshotResult {
  /** One node per line, two spaces of indent per level of emitted depth. */
  text: string;
  /** Number of lines emitted. */
  nodes: number;
  /** True when `maxNodes` cut the walk short. */
  truncated: boolean;
  /** Rough token count (chars/4). Budget target is 500-2000 on a typical page. */
  approxTokens: number;
  url: string;
  title: string;
}

/**
 * Live ref table for the CURRENT snapshot only. Rebuilt from scratch on every call, so
 * `eNN` numbering restarts at `e1` each time and a ref from an older snapshot resolves to
 * nothing. This is the no-CDP replacement for `backendNodeId`: identity lives here in the
 * isolated world, never as an attribute on the page (R-02).
 */
let refToElement = new Map<string, Element>();
let elementToRef = new WeakMap<Element, string>();
let refCounter = 0;

/** Resolve a `[ref=eNN]` handle from the most recent snapshot. Stale refs resolve to null. */
export function resolveRef(ref: string): Element | null {
  const el = refToElement.get(ref);
  if (!el) return null;
  return el.isConnected ? el : null;
}

/** Number of refs currently held. Exposed for tests and diagnostics. */
export function refCount(): number {
  return refToElement.size;
}

function newSnapshotRefs(): void {
  refToElement = new Map();
  elementToRef = new WeakMap();
  refCounter = 0;
}

function refFor(el: Element): string {
  const existing = elementToRef.get(el);
  if (existing) return existing;
  refCounter += 1;
  const ref = `e${refCounter}`;
  elementToRef.set(el, ref);
  refToElement.set(ref, el);
  return ref;
}

/**
 * Open OR closed shadow root.
 *
 * `chrome.dom.openOrClosedShadowRoot` is a genuine extension API (Chrome 88+, no permission)
 * and is the only way to see inside a closed root without CDP. Its availability in an
 * isolated-world content script is documented nowhere, so it is feature-detected and the
 * call is wrapped: any absence or throw degrades to `element.shadowRoot`, i.e. open roots
 * only, and closed roots simply stay opaque.
 */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const api = (
    globalThis as unknown as {
      chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } };
    }
  ).chrome?.dom?.openOrClosedShadowRoot;
  if (typeof api === 'function') {
    try {
      const root = api(el);
      if (root) return root;
    } catch {
      // fall through to the open-root path
    }
  }
  return el.shadowRoot ?? null;
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  try {
    return view.getComputedStyle(el as HTMLElement);
  } catch {
    return null;
  }
}

function isHidden(el: Element, opts: Required<Pick<SnapshotOptions, 'skipOffscreen'>>): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  const name = el.localName.toLowerCase();
  if (name === 'script' || name === 'style' || name === 'noscript' || name === 'template' || name === 'head') {
    return true;
  }
  if (name === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return true;

  const style = styleOf(el);
  if (style) {
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  }

  if (opts.skipOffscreen) {
    const rect = boxOf(el);
    if (!rect) return false;
    if (rect.width === 0 || rect.height === 0) return true;
    const view = el.ownerDocument?.defaultView;
    const vw = view?.innerWidth ?? 0;
    const vh = view?.innerHeight ?? 0;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw) return true;
  }
  return false;
}

function boxOf(el: Element): DOMRect | null {
  const fn = (el as HTMLElement).getBoundingClientRect;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(el);
  } catch {
    return null;
  }
}

/** Tags a follower can act on regardless of what role they compute to. */
const INTERACTIVE_TAGS = new Set([
  'a',
  'area',
  'button',
  'details',
  'input',
  'option',
  'select',
  'summary',
  'textarea',
]);

function isDisabled(el: Element): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function isInteractive(el: Element, role: string): boolean {
  const name = el.localName.toLowerCase();
  if (name === 'a' && !el.hasAttribute('href')) return false;
  if (INTERACTIVE_TAGS.has(name)) return true;
  if (INTERACTIVE_ROLES.has(role)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  if (el.hasAttribute('onclick')) return true;
  // Last-resort heuristic from nanobrowser/browser-use: a pointer cursor on a non-anchor.
  // The CDP-only `getEventListeners()` signal has no content-script equivalent, so
  // framework-attached handlers on bare divs are knowingly under-detected.
  const style = styleOf(el);
  if (style && style.cursor === 'pointer') return true;
  return false;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Extra `{k=v}` fields worth spending tokens on. Order is stable so golden tests can rely on it. */
function attrsOf(el: Element, role: string, maxTextLength: number): string[] {
  const out: string[] = [];
  const name = el.localName.toLowerCase();

  if (name === 'a') {
    const href = el.getAttribute('href');
    if (href) out.push(`href=${truncate(href, 80)}`);
  }
  if (name === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    out.push(`type=${type}`);
    if (TEXT_INPUT_TYPES.has(type)) {
      const value = (el as HTMLInputElement).value ?? '';
      if (value) out.push(`value=${quote(truncate(value, maxTextLength))}`);
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) out.push(`placeholder=${quote(truncate(placeholder, maxTextLength))}`);
  }
  if (name === 'textarea') {
    const value = (el as HTMLTextAreaElement).value ?? '';
    if (value) out.push(`value=${quote(truncate(value, maxTextLength))}`);
  }
  if (name === 'select') {
    const value = (el as HTMLSelectElement).value ?? '';
    if (value) out.push(`value=${quote(truncate(value, maxTextLength))}`);
    const count = (el as HTMLSelectElement).options?.length ?? 0;
    if (count) out.push(`options=${count}`);
  }
  if (role === 'heading') {
    const level = headingLevel(el);
    if (level) out.push(`level=${level}`);
  }
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    const checked = el.getAttribute('aria-checked') ?? String((el as HTMLInputElement).checked ?? false);
    out.push(`checked=${checked}`);
  }
  if (role === 'option') {
    const selected = el.getAttribute('aria-selected') ?? String((el as HTMLOptionElement).selected ?? false);
    if (selected === 'true') out.push('selected=true');
  }
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) out.push(`expanded=${expanded}`);
  if (isDisabled(el)) out.push('disabled=true');
  return out;
}

interface WalkState {
  lines: string[];
  maxNodes: number;
  maxTextLength: number;
  interactiveOnly: boolean;
  skipOffscreen: boolean;
  truncated: boolean;
  seen: WeakSet<Node>;
}

function emit(state: WalkState, depth: number, line: string): boolean {
  if (state.lines.length >= state.maxNodes) {
    state.truncated = true;
    return false;
  }
  state.lines.push(`${'  '.repeat(depth)}- ${line}`);
  return true;
}

/**
 * Roles whose accessible name already carries everything their subtree says, so the walk
 * stops there. Keeps a `<select>` with 200 options from eating the whole token budget.
 */
const LEAF_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'heading',
  'img',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/**
 * Names for structural (non-interactive) nodes come only from an explicit author label —
 * computing name-from-content for every `listitem` both costs tokens and duplicates the
 * lines emitted for its children.
 */
function structuralName(el: Element): string {
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title')) {
    return computeAccessibleName(el);
  }
  return '';
}

/** Roles that carry a real name even though nothing about them is actionable. */
const NAMED_STRUCTURAL_ROLES = new Set(['heading', 'img']);

function describe(el: Element, role: string, interactive: boolean, state: WalkState): string {
  const named = interactive || NAMED_STRUCTURAL_ROLES.has(role);
  const raw = named ? computeAccessibleName(el) : structuralName(el);
  const name = truncate(raw, state.maxTextLength);
  const ref = refFor(el);
  const attrs = attrsOf(el, role, state.maxTextLength);
  const label = role === 'generic' || role === 'none' ? el.localName.toLowerCase() : role;
  // The `"name"` segment is omitted rather than emitted empty: pure token economy.
  const head = name ? `${label} ${quote(name)} [ref=${ref}]` : `${label} [ref=${ref}]`;
  return attrs.length ? `${head} {${attrs.join(' ')}}` : head;
}

function isSameOriginFrame(frame: Element): Document | null {
  try {
    const doc = (frame as HTMLIFrameElement).contentDocument;
    return doc ?? null;
  } catch {
    // SecurityError on a cross-origin frame.
    return null;
  }
}

function walk(node: Node, depth: number, state: WalkState): void {
  if (state.truncated) return;
  if (state.seen.has(node)) return;
  state.seen.add(node);

  if (node.nodeType === 3) {
    if (state.interactiveOnly) return;
    const text = truncate(node.nodeValue ?? '', state.maxTextLength);
    if (text) emit(state, depth, `text ${quote(text)}`);
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  const tagName = el.localName.toLowerCase();

  if (isHidden(el, { skipOffscreen: state.skipOffscreen })) return;

  if (tagName === 'iframe' || tagName === 'frame') {
    const ref = refFor(el);
    const doc = isSameOriginFrame(el);
    if (!doc) {
      emit(state, depth, `iframe [ref=${ref}] (cross-origin)`);
      return;
    }
    if (!emit(state, depth, `iframe [ref=${ref}] (same-origin)`)) return;
    const body = doc.body ?? doc.documentElement;
    if (body) {
      for (const child of Array.from(body.childNodes)) walk(child, depth + 1, state);
    }
    return;
  }

  const role = computeRole(el);
  const interactive = isInteractive(el, role);
  const structural =
    LANDMARK_ROLES.has(role) || role === 'heading' || role === 'list' || role === 'listitem' || role === 'img';
  const emitted = interactive || (!state.interactiveOnly && structural);

  let childDepth = depth;
  if (emitted) {
    if (!emit(state, depth, describe(el, role, interactive, state))) return;
    // A leaf role's name already says everything its subtree does.
    if (LEAF_ROLES.has(role)) return;
    childDepth = depth + 1;
  }

  const shadow = shadowRootOf(el);
  if (shadow) {
    for (const child of Array.from(shadow.childNodes)) walk(child, childDepth, state);
  }
  for (const child of Array.from(el.childNodes)) walk(child, childDepth, state);
}

/**
 * Build a snapshot of `opts.root` (default: the injected script's `document`).
 *
 * Refs are rebuilt from scratch; every previously handed-out `eNN` becomes stale.
 */
export function snapshot(opts: SnapshotOptions = {}): SnapshotResult {
  const doc = opts.root ?? (globalThis as unknown as { document: Document }).document;
  const maxNodes = opts.maxNodes ?? 400;
  const state: WalkState = {
    lines: [],
    maxNodes,
    maxTextLength: opts.maxTextLength ?? 120,
    interactiveOnly: opts.interactiveOnly ?? false,
    skipOffscreen: opts.skipOffscreen ?? false,
    truncated: false,
    seen: new WeakSet(),
  };

  newSnapshotRefs();

  const root = doc.body ?? doc.documentElement;
  if (root) {
    for (const child of Array.from(root.childNodes)) walk(child, 0, state);
  }

  const text = state.lines.join('\n');
  return {
    text,
    nodes: state.lines.length,
    truncated: state.truncated,
    approxTokens: Math.ceil(text.length / 4),
    url: doc.location?.href ?? '',
    title: doc.title ?? '',
  };
}

/**
 * SET_OF_MARKS_EXTENSION_POINT (C-05 — optional, and NOT the interaction model).
 *
 * If marks are ever wanted, they must NOT be drawn into the page: any injected node,
 * attribute, or stylesheet is ranked-leak row 4/11 and is detectable even transiently.
 * The only acceptable shapes are (a) draw boxes over the captured screenshot in the service
 * worker / side panel using the viewport rects `getBox` already returns, or (b) CDP
 * `Overlay.*` while the R-13 debugger tier is already attached. Adding a DOM overlay here
 * would break `scripts/check-invariants.sh`'s intent and R-02.
 */
export const SET_OF_MARKS_SUPPORTED = false;
