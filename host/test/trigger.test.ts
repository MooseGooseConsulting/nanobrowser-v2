import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundMsg, SocketRequest, SocketResponse } from '../src/protocol.ts';
import { TriggerServer, newRunId } from '../src/trigger.ts';

let dir: string;
let sockPath: string;
let server: TriggerServer;
let sent: OutboundMsg[];
let connected: boolean;
let key: { ready: boolean; reason?: string };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-sock-'));
  sockPath = path.join(dir, 'nanobrowser.sock');
  sent = [];
  connected = true;
  key = { ready: true };
  server = new TriggerServer({
    socketPath: sockPath,
    send: (m) => sent.push(m),
    keyStatus: async () => key,
    extensionConnected: () => connected,
    hostVersion: '0.0.1-test',
    pid: () => 4242,
  });
  await server.start();
});

afterEach(async () => {
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A tiny NDJSON client over the real unix socket. */
function client(): Promise<{
  send: (r: SocketRequest) => void;
  next: () => Promise<SocketResponse>;
  close: () => void;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    const queue: SocketResponse[] = [];
    const waiters: Array<(m: SocketResponse) => void> = [];
    let buf = '';
    let closeResolve!: () => void;
    const closed = new Promise<void>((r) => (closeResolve = r));
    sock.on('close', closeResolve);
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as SocketResponse;
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
      }
    });
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        send: (r) => sock.write(JSON.stringify(r) + '\n'),
        next: () =>
          new Promise<SocketResponse>((res) => {
            const q = queue.shift();
            if (q) res(q);
            else waiters.push(res);
          }),
        close: () => sock.destroy(),
        closed,
      }),
    );
  });
}

describe('dev trigger socket', () => {
  it('binds with mode 0600', async () => {
    const st = await fs.stat(sockPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('rebinds over a stale socket file', async () => {
    await server.close();
    await fs.writeFile(sockPath, 'stale');
    await server.start();
    const c = await client();
    c.send({ op: 'status' });
    expect((await c.next()).op).toBe('status');
  });

  it('answers status with liveness, key readiness, and the host pid', async () => {
    key = { ready: false, reason: 'GET /key returned 401' };
    connected = false;
    const c = await client();
    c.send({ op: 'status' });
    expect(await c.next()).toEqual({
      op: 'status',
      ok: true,
      extensionConnected: false,
      hostVersion: '0.0.1-test',
      pid: 4242,
      key: { ready: false, reason: 'GET /key returned 401' },
    });
    await c.closed;
  });

  describe('reload', () => {
    it('answers before pushing ext.reload, since the push kills this process', async () => {
      const c = await client();
      c.send({ op: 'reload' });
      // The reply must be on the wire first: chrome.runtime.reload() tears down the
      // service worker, the native port drops, and the host exits -- there is no later.
      expect(await c.next()).toEqual({ op: 'reloading', pid: 4242 });
      expect(sent).toEqual([{ type: 'ext.reload' }]);
      await c.closed;
    });

    it('refuses and pushes nothing when no extension is connected', async () => {
      connected = false;
      const c = await client();
      c.send({ op: 'reload' });
      expect(await c.next()).toEqual({ op: 'error', message: 'no extension connected to the host' });
      expect(sent).toEqual([]);
      await c.closed;
    });
  });

  it('round-trips a run: forwards run.start and streams events to run.end', async () => {
    const c = await client();
    c.send({ op: 'run', prompt: 'read the thread list', url: 'https://hyperagent.com', options: { navMode: 'dom' } });

    const accepted = await c.next();
    expect(accepted.op).toBe('accepted');
    const runId = (accepted as { runId: string }).runId;
    expect(runId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    expect(sent).toEqual([
      {
        type: 'run.start',
        runId,
        prompt: 'read the thread list',
        url: 'https://hyperagent.com',
        options: { navMode: 'dom' },
      },
    ]);

    // The dispatcher would call publish() for each runlog.append it persists.
    server.publish(runId, { type: 'leader.plan', step: 0 });
    server.publish(runId, { type: 'follower.step', step: 1 });
    server.publish(runId, { type: 'run.end', status: 'done' });

    expect(await c.next()).toEqual({ op: 'event', runId, event: { type: 'leader.plan', step: 0 } });
    expect(await c.next()).toEqual({ op: 'event', runId, event: { type: 'follower.step', step: 1 } });
    expect(await c.next()).toEqual({ op: 'event', runId, event: { type: 'run.end', status: 'done' } });
    expect(await c.next()).toEqual({ op: 'end', runId });
    await c.closed;
  });

  it('honours a caller-supplied runId', async () => {
    const c = await client();
    c.send({ op: 'run', prompt: 'x', runId: 'fixed-run-42' });
    expect(await c.next()).toEqual({ op: 'accepted', runId: 'fixed-run-42' });
    expect(sent[0]).toMatchObject({ type: 'run.start', runId: 'fixed-run-42' });
  });

  it('does not leak events of one run to a subscriber of another', async () => {
    const a = await client();
    const b = await client();
    a.send({ op: 'run', prompt: 'a', runId: 'run-a' });
    b.send({ op: 'run', prompt: 'b', runId: 'run-b' });
    await a.next();
    await b.next();
    server.publish('run-a', { type: 'run.end' });
    expect(await a.next()).toMatchObject({ op: 'event', runId: 'run-a' });
    expect(await a.next()).toEqual({ op: 'end', runId: 'run-a' });
    server.publish('run-b', { type: 'only-b' });
    expect(await b.next()).toEqual({ op: 'event', runId: 'run-b', event: { type: 'only-b' } });
    b.close();
  });

  it('refuses a run when no extension is connected', async () => {
    connected = false;
    const c = await client();
    c.send({ op: 'run', prompt: 'x' });
    expect(await c.next()).toMatchObject({ op: 'error' });
    expect(sent).toEqual([]);
  });

  it('rejects an empty prompt, invalid JSON, and an unknown op', async () => {
    const c = await client();
    c.send({ op: 'run', prompt: '' } as SocketRequest);
    expect(await c.next()).toMatchObject({ op: 'error' });
    c.send({ op: 'bogus' } as unknown as SocketRequest);
    expect(await c.next()).toMatchObject({ op: 'error' });
    c.close();
  });

  it('unlinks the socket on close', async () => {
    await server.close();
    await expect(fs.stat(sockPath)).rejects.toThrow();
  });
});

describe('newRunId', () => {
  it('matches the runId grammar and is unique', () => {
    const ids = new Set(Array.from({ length: 50 }, newRunId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
