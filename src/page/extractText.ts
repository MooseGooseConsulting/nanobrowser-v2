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
  /**
   * Character offset to start from, for reading a page longer than one cap.
   * A live eBay scrape stopped at 38 of 60 listings because the text ran past
   * `maxChars` and there was no way to ask for the rest.
   */
  startChar?: number;
  /** Root to walk. Defaults to the injected script's own `document`. */
  root?: Document;
}

export interface ExtractTextResult {
  text: string;
  /** True when `maxChars` cut the text short. */
  truncated: boolean;
  /** Length of the whole extraction, so the caller knows how much it has not seen. */
  totalChars: number;
  /** Offset to pass as `startChar` next time; absent once the end is reached. */
  nextStart?: number;
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
  const totalChars = text.length;

  const start = Math.min(Math.max(opts.startChar ?? 0, 0), totalChars);
  const end = start + maxChars;
  if (end >= totalChars) return { text: text.slice(start), truncated: false, totalChars };
  // The marker stays exactly " [truncated]": callers and tests match on it. Where to
  // resume is carried in `nextStart` instead, and the model is told about it by the
  // tool adapter rather than by changing this string.
  return { text: `${text.slice(start, end)} [truncated]`, truncated: true, totalChars, nextStart: end };
}
