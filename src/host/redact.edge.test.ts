/**
 * Regression coverage for gaps the review found in `redactText`/`redactEvent`:
 * a dotted OpenRouter key shape was only partially redacted (the extension's
 * `OPENROUTER_KEY_RE` had drifted from the host's own `KEY_SHAPES` in
 * `host/src/log.ts`, which already handles the dot), and both patterns were
 * case-sensitive. `redact.ts`'s own doc comment claims "there is no second,
 * weaker definition of 'redacted' anywhere" -- this file is what makes that
 * true rather than aspirational.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import { redactEvent, redactText } from './redact';

describe('redactText: dotted OpenRouter key shape (sk-or-v1.<hex>.<hex>)', () => {
  it('strips a dotted key whole, not just up to the first dot', () => {
    const text = redactText('key: sk-or-v1.abc123.def456 end');
    expect(text).not.toContain('sk-or-v1');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('def456');
    expect(text).toBe('key: [redacted] end');
  });

  it('matches the host-side KEY_SHAPES definition (host/src/log.ts) for the same input', () => {
    // Mirrors host/src/log.ts's `/sk-or-[A-Za-z0-9._-]+/g` exactly so the two
    // redactors cannot silently drift apart again.
    const hostShape = /sk-or-[A-Za-z0-9._-]+/g;
    const input = 'Authorization: sk-or-v1.deadBEEF-01.9f8e7d_6c5b';
    const hostRedacted = input.replace(hostShape, '[redacted]');
    expect(redactText(input)).toBe(hostRedacted);
  });
});

describe('redactText: case-insensitivity', () => {
  it('redacts an upper-cased key prefix', () => {
    expect(redactText('token SK-OR-ABC123')).toBe('token [redacted]');
  });

  it('redacts a lower-cased "bearer" header value', () => {
    expect(redactText('sending bearer abcDEF123.token')).toBe('sending [redacted]');
  });

  it('redacts a mixed-case "BeArEr" header value', () => {
    expect(redactText('sending BeArEr abcDEF123.token')).toBe('sending [redacted]');
  });
});

describe('redactEvent: the fixed patterns apply through the deep-scan too', () => {
  it('strips a dotted key nested in unknown tool args', () => {
    const event: RunEvent = {
      kind: 'tool.call',
      role: 'follower',
      call: { callId: 'c1', name: 'fetchKey', args: { header: 'Authorization: sk-or-v1.nested.key' } },
      at: 1,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'tool.call') throw new Error('expected tool.call');
    const serialized = JSON.stringify(redacted.call.args);
    expect(serialized).not.toContain('sk-or-v1');
    expect(serialized).not.toContain('nested');
    expect(serialized).toContain('[redacted]');
  });
});
