/**
 * Readable text of the page's main content, for the Follower's `extract_text` tool.
 *
 * Runs inside the on-demand injected script, ISOLATED world only (R-01, R-02): zero DOM
 * writes, same invariant as `snapshot.ts` — this only ever reads `textContent`,
 * attributes and computed style. Unlike `snapshot()`, this is not meant to be acted on
 * (no refs): it exists for long lists and articles where the accessibility-tree
 * snapshot's per-node budget runs out before the useful text does.
 */
import { isHidden } from './snapshot';

export interface ExtractTextOptions {
  /** Character cap on the returned text. Default 20000, hard max 60000. */
  maxChars?: number;
  /** Root to walk. Defaults to the injected script's own `document`. */
  root?: Document;
}

export interface ExtractTextResult {
  text: string;
  /** True when `maxChars` cut the text short. */
  truncated: boolean;
}

export const DEFAULT_MAX_CHARS = 20_000;
export const HARD_MAX_CHARS = 60_000;

/** `main`, else `[role=main]`, else `article`, else the whole body — first match wins. */
function pickContainer(doc: Document): Element {
  const container = doc.querySelector('main') ?? doc.querySelector('[role="main"]') ?? doc.querySelector('article');
  return container ?? doc.body ?? doc.documentElement;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Flattens readable text: an anchor with an href and non-empty text becomes one
 * `"text (href)"` entry and is not walked into further; everything else is
 * flattened depth-first. Hidden subtrees (script/style/display:none/etc, same test
 * as `snapshot.ts`) are skipped entirely.
 */
function collect(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? '';
    if (text.trim()) out.push(text);
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  if (isHidden(el, { skipOffscreen: false })) return;

  if (el.localName.toLowerCase() === 'a') {
    const href = el.getAttribute('href');
    const text = collapse(el.textContent ?? '');
    if (href && text) {
      out.push(`${text} (${href})`);
      return;
    }
  }

  for (const child of Array.from(el.childNodes)) collect(child, out);
}

/** Builds the readable-text extraction of `opts.root` (default: the current document). */
export function extractText(opts: ExtractTextOptions = {}): ExtractTextResult {
  const doc = opts.root ?? (globalThis as unknown as { document: Document }).document;
  const requested = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxChars = Math.min(Math.max(requested, 0), HARD_MAX_CHARS);

  const container = pickContainer(doc);
  const parts: string[] = [];
  collect(container, parts);
  const text = collapse(parts.join(' '));

  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)} [truncated]`, truncated: true };
}
