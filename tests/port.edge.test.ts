/**
 * Two reviewers independently flagged the same gap: `src/messaging/contract.ts`
 * is compile-time-only (no runtime schema), and `createChannel`'s dispatch does
 * `handler(message as Envelope<TIn>)` with no shape check at all -- so nothing
 * in `port.test.ts` ever tries a malformed envelope. This file proves what the
 * port layer itself actually does with one (crash or pass-through), which is
 * the honest, testable half of the gap; the other half -- that nothing above
 * this layer validates a payload's *shape* once its `type` is recognised -- is
 * an architectural gap recorded in docs/test-review.md as a suggested diff,
 * not fixed here (it would mean adding a schema per message type across the
 * whole contract, a design decision bigger than this review's scope).
 */
import { describe, expect, it } from 'vitest';
import { createChannel, createFakePortPair } from '@/src/messaging/port';
import type { Envelope } from '@/src/messaging/port';

describe('createChannel: malformed envelopes at the port layer', () => {
  it('passes an envelope with unexpected extra fields through unchanged (no shape validation exists)', () => {
    const [a, b] = createFakePortPair();
    const right = createChannel<unknown, unknown>(b);
    const received: unknown[] = [];
    right.onMessage((m) => received.push(m));

    // A well-typed sender only ever produces {type,id,payload}; this documents
    // that the channel does not reject a peer that sends more than that.
    a.postMessage({ type: 'cmd', id: 'x', payload: {}, extra: 'unexpected', __proto__: { polluted: true } } as never);

    expect(received).toHaveLength(1);
  });

  it('delivers a payload of the wrong type for its declared `type` without complaint (no per-type schema exists)', () => {
    const [a, b] = createFakePortPair();
    const right = createChannel<{ kind: string }, unknown>(b);
    const received: Envelope<{ kind: string }>[] = [];
    right.onMessage((m) => received.push(m));

    // Declares payload shape `{kind:string}` but actually sends a number --
    // TypeScript cannot catch this because it crosses a serialization
    // boundary; nothing at runtime catches it either.
    a.postMessage({ type: 'cmd', id: 'x', payload: 12345 } as never);

    expect(received[0]?.payload).toBe(12345);
  });

  it('a very large payload is delivered whole, with no size cap at this layer', () => {
    const [a, b] = createFakePortPair();
    const right = createChannel<string, unknown>(b);
    const received: string[] = [];
    right.onMessage((m) => received.push(m.payload));

    const big = 'x'.repeat(5_000_000);
    a.postMessage({ type: 'cmd', id: 'x', payload: big });

    expect(received[0]).toHaveLength(5_000_000);
  });

  it('a handler that throws on a malformed message propagates past postMessage in the fake port (a same-stack test artifact, not necessarily real-Chrome behaviour)', () => {
    // `FakeBrowserPort` dispatches synchronously, in the same call stack as
    // `postMessage` -- unlike a real `chrome.runtime.Port`, which delivers to
    // the other execution context asynchronously. So a receiver whose handler
    // assumes a well-shaped envelope (e.g. reads `envelope.type` without a
    // null check) and receives `null` will throw *back into the sender's own
    // postMessage call* here, which could never happen for real. This is
    // exactly why `createWorker`'s own message handler (see
    // src/runtime/worker.edge.test.ts) is worth guarding defensively even
    // though this specific propagation path is a test-double artifact.
    const [a, b] = createFakePortPair();
    const channel = createChannel<unknown, unknown>(b);
    channel.onMessage((m) => {
      void m.type.toUpperCase();
    });

    expect(() => a.postMessage(null as unknown as Envelope)).toThrow();
  });
});
