/**
 * Request dispatch for the injected script: one `chrome.runtime.onMessage` listener, one
 * switch, one reply. Kept out of `entrypoints/injected-content.ts` so it is unit-testable
 * without the WXT entrypoint wrapper.
 *
 * Stealth (R-02): exactly one listener is ever registered, on `chrome.runtime` — never
 * `window.postMessage`, never a custom DOM event, never a global on the page. Nothing else
 * happens at injection time: no observers, no timers, no DOM reads until asked.
 */
import { click, getBox, hover, press, scroll, select, type } from './actions';
import type { ActionResult, BoxResult, ScrollOptions, TypeOptions } from './actions';
import { snapshot } from './snapshot';
import type { SnapshotOptions, SnapshotResult } from './snapshot';

export type PageRequest =
  | ({ op: 'snapshot' } & SnapshotOptions)
  | { op: 'click'; ref: string }
  | ({ op: 'type'; ref: string; text: string } & TypeOptions)
  | { op: 'press'; key: string }
  | { op: 'select'; ref: string; value: string }
  | ({ op: 'scroll' } & ScrollOptions)
  | { op: 'getBox'; ref: string }
  | { op: 'hover'; ref: string }
  | { op: 'ping' };

/** Injected-side page metrics, returned with `ping` so the driver never needs its own op. */
export interface PingResult extends ActionResult {
  pong: true;
  url: string;
  title: string;
  devicePixelRatio: number;
  /** CSS-pixel viewport. */
  width: number;
  height: number;
}

export type PageResponse = ActionResult | BoxResult | PingResult | (ActionResult & SnapshotResult);

function isRequest(value: unknown): value is PageRequest {
  return typeof value === 'object' && value !== null && typeof (value as { op?: unknown }).op === 'string';
}

function ping(): PingResult {
  const win = (globalThis as unknown as { window?: Window }).window;
  const doc = (globalThis as unknown as { document: Document }).document;
  return {
    ok: true,
    pong: true,
    url: doc?.location?.href ?? '',
    title: doc?.title ?? '',
    devicePixelRatio: win?.devicePixelRatio ?? 1,
    width: win?.innerWidth ?? 0,
    height: win?.innerHeight ?? 0,
  };
}

/** Run one page operation. Never throws: every failure comes back as `{ ok:false, error }`. */
export function handle(request: unknown): PageResponse {
  if (!isRequest(request)) return { ok: false, error: 'malformed page request' };
  try {
    switch (request.op) {
      case 'ping':
        return ping();
      case 'snapshot': {
        const { op: _op, ...opts } = request;
        return { ok: true, ...snapshot(opts) };
      }
      case 'click':
        return click(request.ref);
      case 'type':
        return type(request.ref, request.text, { clear: request.clear });
      case 'press':
        return press(request.key);
      case 'select':
        return select(request.ref, request.value);
      case 'scroll': {
        const { op: _op, ...opts } = request;
        return scroll(opts);
      }
      case 'getBox':
        return getBox(request.ref);
      case 'hover':
        return hover(request.ref);
      default: {
        const unknown = request as { op: string };
        return { ok: false, error: `unknown op: ${unknown.op}` };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Guard against double registration.
 *
 * The module-level flag covers a re-`import` inside one script instance. The symbol on the
 * ISOLATED world's `globalThis` covers a genuine re-injection, which evaluates a fresh module
 * instance in the same isolated context. That global is on the isolated world's own global
 * object, which the page cannot see or enumerate — it is not a page global, and R-02's
 * "no globals on the page" rule is intact.
 */
const INSTALLED = '__nanobrowserPageListener' as const;
let installedInThisModule = false;

interface MessageApi {
  runtime: {
    onMessage: {
      addListener(
        fn: (message: unknown, sender: unknown, sendResponse: (response: PageResponse) => void) => boolean | undefined,
      ): void;
    };
  };
}

/**
 * Register the single message listener. Idempotent: calling it again from a re-injected copy
 * of the script is a no-op and leaves exactly one listener attached.
 *
 * Returns true when this call was the one that registered.
 */
export function installPageListener(api?: MessageApi): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (installedInThisModule || scope[INSTALLED] === true) return false;
  const chromeApi = (api ?? (scope.chrome as MessageApi | undefined));
  if (!chromeApi?.runtime?.onMessage?.addListener) return false;

  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRequest(message)) return false;
    sendResponse(handle(message));
    // Replied synchronously; returning false keeps the channel from being held open.
    return false;
  });

  installedInThisModule = true;
  scope[INSTALLED] = true;
  return true;
}

/** Test-only: forget that the listener was installed. Never called by the extension. */
export function resetPageListenerForTests(): void {
  installedInThisModule = false;
  delete (globalThis as unknown as Record<string, unknown>)[INSTALLED];
}
