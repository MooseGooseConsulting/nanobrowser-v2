import { describe, expect, it, vi } from 'vitest';
import { installErrorForwarding, MAX_CHARS, type ConsoleLike, type ExtLogEntry } from './errorLog';

/** A minimal `self`/`window` stand-in: records listeners so a test can fire one. */
function fakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    target: {
      addEventListener(type: string, fn: (event: unknown) => void) {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    },
    fire(type: string, event: unknown) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function setup(options: { send?: (entry: ExtLogEntry) => void } = {}) {
  const sent: ExtLogEntry[] = [];
  const originalError = vi.fn();
  const originalWarn = vi.fn();
  const con: ConsoleLike = { error: originalError, warn: originalWarn };
  const t = fakeTarget();
  const uninstall = installErrorForwarding({
    source: 'worker',
    target: t.target,
    console: con,
    send: options.send ?? ((entry) => sent.push(entry)),
    now: () => 111,
  });
  return { sent, con, originalError, originalWarn, t, uninstall };
}

describe('console wrapping', () => {
  it('forwards console.error and still makes the original call', () => {
    const h = setup();
    h.con.error('[nanobrowser] boom', 42);
    expect(h.originalError).toHaveBeenCalledWith('[nanobrowser] boom', 42);
    expect(h.sent).toEqual([{ level: 'error', source: 'worker', message: '[nanobrowser] boom 42', at: 111 }]);
  });

  it('forwards console.warn at warn level', () => {
    const h = setup();
    h.con.warn('careful');
    expect(h.originalWarn).toHaveBeenCalledWith('careful');
    expect(h.sent).toEqual([{ level: 'warn', source: 'worker', message: 'careful', at: 111 }]);
  });

  it('keeps an Error argument’s stack rather than rendering "[object Object]"', () => {
    const h = setup();
    const err = new Error('kaboom');
    err.stack = 'Error: kaboom\n    at frame (worker.js:1:1)';
    h.con.error('failed:', err);
    expect(h.sent[0]).toEqual({
      level: 'error',
      source: 'worker',
      message: 'failed: Error: kaboom',
      stack: 'Error: kaboom\n    at frame (worker.js:1:1)',
      at: 111,
    });
  });

  it('renders a plain object as JSON', () => {
    const h = setup();
    h.con.error({ code: 7 });
    expect(h.sent[0]!.message).toBe('{"code":7}');
  });

  it('survives an argument that cannot be stringified', () => {
    const h = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => h.con.error(cyclic)).not.toThrow();
    expect(h.sent).toHaveLength(1);
  });

  it('restores the original console methods on uninstall', () => {
    const h = setup();
    h.uninstall();
    h.con.error('after');
    expect(h.originalError).toHaveBeenCalledWith('after');
    expect(h.sent).toEqual([]);
  });
});

describe('global handlers', () => {
  it('forwards an uncaught error with its location and stack', () => {
    const h = setup();
    const err = new Error('nope');
    err.stack = 'Error: nope\n    at f';
    h.t.fire('error', { message: 'nope', error: err, filename: 'chunk.js', lineno: 12 });
    expect(h.sent[0]).toEqual({
      level: 'error',
      source: 'worker',
      message: 'uncaught: nope (chunk.js:12)',
      stack: 'Error: nope\n    at f',
      at: 111,
    });
  });

  it('forwards an unhandled rejection', () => {
    const h = setup();
    h.t.fire('unhandledrejection', { reason: new Error('async boom') });
    expect(h.sent[0]).toMatchObject({
      level: 'error',
      message: 'unhandled rejection: Error: async boom',
    });
  });

  it('forwards a non-Error rejection reason', () => {
    const h = setup();
    h.t.fire('unhandledrejection', { reason: 'just a string' });
    expect(h.sent[0]!.message).toBe('unhandled rejection: just a string');
  });

  it('removes both listeners on uninstall', () => {
    const h = setup();
    h.uninstall();
    expect(h.t.count('error')).toBe(0);
    expect(h.t.count('unhandledrejection')).toBe(0);
  });
});

describe('redaction (R-12)', () => {
  it('strips an OpenRouter key from the message and from the stack', () => {
    const h = setup();
    h.t.fire('error', {
      message: 'request failed with sk-or-v1-deadbeefdeadbeef',
      error: Object.assign(new Error('x'), { stack: 'at fetch (Authorization: Bearer sk-or-v1-deadbeefdeadbeef)' }),
    });
    expect(JSON.stringify(h.sent)).not.toContain('sk-or-');
    expect(JSON.stringify(h.sent)).not.toContain('deadbeef');
    expect(h.sent[0]!.message).toContain('[redacted]');
    expect(h.sent[0]!.stack).toContain('[redacted]');
  });

  it('strips a key that arrives through console.error', () => {
    const h = setup();
    h.con.error('key was', 'sk-or-v1-abcdefabcdef');
    expect(h.sent[0]!.message).toBe('key was [redacted]');
    // The original console call is untouched: DevTools still shows what really happened.
    expect(h.originalError).toHaveBeenCalledWith('key was', 'sk-or-v1-abcdefabcdef');
  });

  it('replaces an inlined screenshot rather than shipping megabytes to ext.log', () => {
    const h = setup();
    h.con.error(`snapshot data:image/png;base64,${'A'.repeat(200)} failed`);
    expect(h.sent[0]!.message).toContain('[screenshot omitted]');
    expect(h.sent[0]!.message).not.toContain('AAAA');
  });

  it('caps message and stack length', () => {
    const h = setup();
    h.con.error('x'.repeat(MAX_CHARS * 2));
    expect(h.sent[0]!.message.length).toBe(MAX_CHARS);
  });
});

describe('re-entrancy', () => {
  it('does not loop when the sink itself calls console.error', () => {
    let calls = 0;
    const h = setup({
      send: () => {
        calls += 1;
        h.con.error('the sink failed');
      },
    });
    h.con.error('original');
    // One forward, and the sink's own console.error is not forwarded again.
    expect(calls).toBe(1);
  });

  it('swallows a throwing sink so one error never becomes two', () => {
    const h = setup({
      send: () => {
        throw new Error('port closed');
      },
    });
    expect(() => h.con.error('original')).not.toThrow();
    expect(h.originalError).toHaveBeenCalledWith('original');
  });
});
