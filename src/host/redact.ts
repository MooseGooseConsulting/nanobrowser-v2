/**
 * Redaction applied to every `RunEvent` before it is handed to `HostClient.appendRunLog`.
 * The host also redacts (docs/host-protocol.md), but R-12 makes this the extension's
 * job on the way out: a secret must never reach disk even if a run misbehaves.
 */
import type { RunEvent } from '@/src/messaging';

const REDACTED = '[redacted]';
const SCREENSHOT_OMITTED = '[screenshot omitted]';

/** OpenRouter provisioned-key shape. */
const OPENROUTER_KEY_RE = /sk-or-[A-Za-z0-9-]+/g;
/** Any bearer token, provider-agnostic. */
const BEARER_RE = /Bearer\s+\S+/g;
/** A base64 image data URL, as a screenshot would appear inline in an event. */
const SCREENSHOT_DATA_URL_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/**
 * The one string scrubber. `redactEvent` walks a run event with it; the error
 * forwarder (src/runtime/errorLog.ts) runs it over a message and a stack, so a key
 * that lands in an exception is stripped by exactly the same rules as one in a tool
 * argument -- there is no second, weaker definition of "redacted" anywhere.
 */
export function redactText(value: string): string {
  return value
    .replace(SCREENSHOT_DATA_URL_RE, SCREENSHOT_OMITTED)
    .replace(OPENROUTER_KEY_RE, REDACTED)
    .replace(BEARER_RE, REDACTED);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = redactValue(v);
    return out;
  }
  return value;
}

/**
 * Deep-scans a `RunEvent` and strips anything matching an OpenRouter key or a
 * `Bearer <token>` header value, and replaces screenshot data URLs with a fixed
 * placeholder. Everything else is left intact. Never mutates its input.
 */
export function redactEvent(event: RunEvent): RunEvent {
  return redactValue(event) as RunEvent;
}
