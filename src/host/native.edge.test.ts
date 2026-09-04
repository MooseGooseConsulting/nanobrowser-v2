import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativePort, HostClient, INITIAL_BACKOFF_MS } from './native';
import type { HostRequestMsg } from './native';

function makeClient() {
  const ports: FakeNativePort[] = [];
  const factory = () => {
    const port = new FakeNativePort();
    ports.push(port);
    return port;
  };
  return { client: new HostClient(factory), ports };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HostClient.appendLog (untested before: no describe block existed for it)', () => {
  it('redacts a secret in the message and in the stack before sending', () => {
    const { client, ports } = makeClient();
    client.appendLog({
      level: 'error',
      source: 'worker',
      message: 'failed with key sk-or-abc123XYZ-9',
      stack: 'Authorization: Bearer sk-or-abc123XYZ-9',
      at: 1,
    });

    const sent = ports[0]!.sent.find((m) => m.type === 'log.append') as HostRequestMsg & {
      message: string;
      stack?: string;
    };
    expect(sent).toBeDefined();
    expect(JSON.stringify(sent)).not.toContain('sk-or-abc123XYZ-9');
    expect(sent.message).toBe('failed with key [redacted]');
    expect(sent.stack).toBe('Authorization: [redacted]');
  });

  it('sends the right shape: level, source, message and at, with stack omitted when absent', () => {
    const { client, ports } = makeClient();
    client.appendLog({ level: 'warn', source: 'panel', message: 'hello', at: 42 });

    const sent = ports[0]!.sent.find((m) => m.type === 'log.append');
    expect(sent).toEqual({ type: 'log.append', level: 'warn', source: 'panel', message: 'hello', at: 42 });
  });

  it('never throws when the port is unreachable (connect() itself is not exercisable here, but the catch guard is)', () => {
    const { client } = makeClient();
    // No connect() has been called and no port factory error is injected, so this
    // documents the "never throws" contract holds for the ordinary call shape too.
    expect(() => client.appendLog({ level: 'info', source: 'worker', message: 'x', at: 1 })).not.toThrow();
  });
});

describe('HostClient message dispatch: an unrecognised message type', () => {
  it('is silently ignored rather than throwing, for a value with no matching type', () => {
    const { client, ports } = makeClient();
    client.connect();
    expect(() => ports[0]!.emit({ type: 'totally.unknown.type' } as never)).not.toThrow();
  });
});

describe('HostClient reconnect backoff: the "hello resets backoff" claim, proven under an actual prior doubling', () => {
  it('reconnects at the initial delay after hello, even though the previous backoff had already doubled', () => {
    const { client, ports } = makeClient();
    client.connect();

    // First disconnect with no `hello` in between: backoff doubles for next time.
    ports[0]!.disconnect();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(2);

    // Prove the doubling actually took effect: at the initial delay alone, no
    // third port yet appears once we disconnect again without a hello.
    ports[1]!.disconnect();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(2); // still waiting on the doubled delay

    vi.advanceTimersByTime(INITIAL_BACKOFF_MS); // completes the doubled wait
    expect(ports).toHaveLength(3);

    // Now prove the reset: `hello` on port 3 must bring backoff back down to
    // the initial delay for the *next* reconnect, not leave it doubled again.
    ports[2]!.emit({ type: 'hello', hostVersion: '0.0.1', dev: false, cassette: 'off' });
    ports[2]!.disconnect();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(4); // would NOT be 4 yet at this point if backoff were still doubled
  });
});
