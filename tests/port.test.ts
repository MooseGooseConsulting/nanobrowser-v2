import { describe, expect, it, vi } from 'vitest';
import { createChannel, createFakePortPair } from '@/src/messaging/port';
import type { Envelope } from '@/src/messaging/port';

interface Ask {
  kind: 'ask';
}
interface Tell {
  kind: 'tell';
}

function pair() {
  const [a, b] = createFakePortPair();
  return {
    left: createChannel<Tell, Ask>(a),
    right: createChannel<Ask, Tell>(b),
  };
}

describe('createChannel', () => {
  it('delivers messages in both directions', () => {
    const { left, right } = pair();
    const toRight: Envelope<Ask>[] = [];
    const toLeft: Envelope<Tell>[] = [];
    right.onMessage((m) => toRight.push(m));
    left.onMessage((m) => toLeft.push(m));

    const askId = left.send('cmd', { kind: 'ask' });
    right.send('evt', { kind: 'tell' });

    expect(toRight).toEqual([{ type: 'cmd', id: askId, payload: { kind: 'ask' } }]);
    expect(toLeft).toHaveLength(1);
    expect(toLeft[0]?.type).toBe('evt');
    expect(toLeft[0]?.payload).toEqual({ kind: 'tell' });
  });

  it('gives every envelope a distinct id', () => {
    const { left } = pair();
    const ids = new Set([
      left.send('cmd', { kind: 'ask' }),
      left.send('cmd', { kind: 'ask' }),
      left.send('cmd', { kind: 'ask' }),
    ]);
    expect(ids.size).toBe(3);
  });

  it('supports unsubscribing a handler', () => {
    const { left, right } = pair();
    const seen = vi.fn();
    const off = right.onMessage(seen);
    left.send('cmd', { kind: 'ask' });
    off();
    left.send('cmd', { kind: 'ask' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('propagates close to the other end', () => {
    const { left, right } = pair();
    const closed = vi.fn();
    right.onClose(closed);

    expect(left.closed).toBe(false);
    left.close();

    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('runs onClose immediately when registered after close', () => {
    const { left } = pair();
    left.close();
    const late = vi.fn();
    left.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing after close', () => {
    const { left, right } = pair();
    const seenRight = vi.fn();
    const seenLeft = vi.fn();
    right.onMessage(seenRight);
    left.onMessage(seenLeft);

    right.close();

    left.send('cmd', { kind: 'ask' });
    right.send('evt', { kind: 'tell' });

    expect(seenRight).not.toHaveBeenCalled();
    expect(seenLeft).not.toHaveBeenCalled();
  });

  it('closes idempotently', () => {
    const { left } = pair();
    const closed = vi.fn();
    left.onClose(closed);
    left.close();
    left.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
