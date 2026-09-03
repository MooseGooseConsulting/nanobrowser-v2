/**
 * Forwards extension-side errors to the native host's ext.log (docs/host-protocol.md).
 *
 * Without this, an exception in the service worker or the side panel exists only in a
 * DevTools window on chrome://extensions -- which nobody has open during an unattended
 * run, so `scripts/e2e.sh` would report a green run that actually threw.
 *
 * Two sources, one shape. The worker forwards straight to its `HostClient`; the panel
 * has no native port, so it forwards over the existing panel->worker channel as
 * `log.append` and the worker relays it. Both redact with `redactText` before the
 * message leaves the process (R-12); the host redacts again on the way in.
 */
import { redactText } from '@/src/host/redact';
import type { PanelToWorker } from '@/src/messaging';

export type ExtLogEntry = PanelToWorker['log.append'];
export type ExtLogLevel = ExtLogEntry['level'];
export type ExtLogSource = ExtLogEntry['source'];

/** The slice of `console` this wraps. Injected so a test never touches the real one. */
export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * The slice of `self` / `window` this listens on. Typed structurally so the worker can
 * pass `self` and the panel `window` with no `any` at either call site.
 */
export interface ErrorEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface ErrorForwardingOptions {
  source: ExtLogSource;
  /** Where a forwarded entry goes. Must not throw and must not log. */
  send: (entry: ExtLogEntry) => void;
  target?: ErrorEventTarget;
  console?: ConsoleLike;
  now?: () => number;
  /** Longest message/stack kept; the rest is dropped so one runaway string cannot flood ext.log. */
  maxChars?: number;
}

export const MAX_CHARS = 4000;

/** Renders one console argument. An Error keeps its stack; an object is JSON, not "[object Object]". */
function describeArg(arg: unknown): { text: string; stack?: string } {
  if (arg instanceof Error) {
    return { text: `${arg.name}: ${arg.message}`, ...(arg.stack ? { stack: arg.stack } : {}) };
  }
  if (typeof arg === 'string') return { text: arg };
  try {
    return { text: JSON.stringify(arg) ?? String(arg) };
  } catch {
    return { text: String(arg) };
  }
}

function joinArgs(args: unknown[]): { message: string; stack?: string } {
  const parts: string[] = [];
  let stack: string | undefined;
  for (const arg of args) {
    const d = describeArg(arg);
    parts.push(d.text);
    if (!stack && d.stack) stack = d.stack;
  }
  return { message: parts.join(' '), ...(stack ? { stack } : {}) };
}

/**
 * Installs `error` + `unhandledrejection` listeners and wraps `console.error` /
 * `console.warn`. The original console call always still happens: this adds a sink, it
 * does not replace the one a human reads in DevTools.
 *
 * Returns an uninstall that restores the original console methods.
 */
export function installErrorForwarding(options: ErrorForwardingOptions): () => void {
  const now = options.now ?? Date.now;
  const max = options.maxChars ?? MAX_CHARS;
  const target = options.target;
  const con = options.console;

  // Re-entrancy guard. `send` failing would call console.error, which is now wrapped,
  // which would forward again -- one bad frame becoming an infinite loop.
  let forwarding = false;

  const forward = (level: ExtLogLevel, message: string, stack?: string): void => {
    if (forwarding) return;
    forwarding = true;
    try {
      options.send({
        level,
        source: options.source,
        message: redactText(message).slice(0, max),
        ...(stack ? { stack: redactText(stack).slice(0, max) } : {}),
        at: now(),
      });
    } catch {
      /* the sink is unavailable; the console call above already happened */
    } finally {
      forwarding = false;
    }
  };

  const onError = (event: unknown): void => {
    const e = event as { message?: unknown; error?: unknown; filename?: unknown; lineno?: unknown };
    const err = e.error instanceof Error ? e.error : undefined;
    const where =
      typeof e.filename === 'string' && e.filename ? ` (${e.filename}:${String(e.lineno ?? '')})` : '';
    const message = typeof e.message === 'string' && e.message ? e.message : err ? err.message : 'uncaught error';
    forward('error', `uncaught: ${message}${where}`, err?.stack);
  };

  const onRejection = (event: unknown): void => {
    const reason = (event as { reason?: unknown }).reason;
    const d = describeArg(reason);
    forward('error', `unhandled rejection: ${d.text}`, d.stack);
  };

  target?.addEventListener('error', onError);
  target?.addEventListener('unhandledrejection', onRejection);

  const originalError = con?.error.bind(con);
  const originalWarn = con?.warn.bind(con);

  if (con && originalError) {
    con.error = (...args: unknown[]): void => {
      originalError(...args);
      const { message, stack } = joinArgs(args);
      forward('error', message, stack);
    };
  }
  if (con && originalWarn) {
    con.warn = (...args: unknown[]): void => {
      originalWarn(...args);
      const { message, stack } = joinArgs(args);
      forward('warn', message, stack);
    };
  }

  return () => {
    target?.removeEventListener('error', onError);
    target?.removeEventListener('unhandledrejection', onRejection);
    if (con && originalError) con.error = originalError;
    if (con && originalWarn) con.warn = originalWarn;
  };
}
