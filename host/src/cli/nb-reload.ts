#!/usr/bin/env node
/**
 * nb-reload [--timeout <seconds>]
 *
 * Reloads the unpacked extension without a human clicking chrome://extensions.
 *
 * The sequence is deliberately indirect: this CLI cannot talk to Chrome, so it asks the
 * host to push `ext.reload`, the worker calls `chrome.runtime.reload()` (which re-reads
 * an unpacked extension from disk), and that tears down the service worker -- which drops
 * the native port and kills the host we just spoke to. Success is therefore not "the
 * socket answered": it is "a DIFFERENT host process is listening and an extension is
 * connected to it". We poll for exactly that.
 *
 * Exit codes: 0 ready (prints the new pid), 2 no extension connected, 1 anything else.
 */
import net from 'node:net';
import { socketPath } from '../paths.ts';
import type { SocketResponse } from '../protocol.ts';
import { connect, onResponses, send } from './socket-client.ts';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const timeoutMs = Math.max(1, Number(flag('timeout') ?? process.env.NB_RELOAD_TIMEOUT ?? 30)) * 1000;
const POLL_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One request/one response over a fresh connection. Resolves null when nothing is listening. */
function ask(req: { op: 'status' } | { op: 'reload' }): Promise<SocketResponse | null> {
  return new Promise((resolve) => {
    let sock: net.Socket;
    connect().then(
      (s) => {
        sock = s;
        let settled = false;
        const done = (r: SocketResponse | null): void => {
          if (settled) return;
          settled = true;
          sock.destroy();
          resolve(r);
        };
        onResponses(sock, done);
        sock.on('close', () => done(null));
        sock.on('error', () => done(null));
        send(sock, req);
      },
      () => resolve(null),
    );
  });
}

const before = await ask({ op: 'status' });
if (!before) {
  process.stderr.write(`error: no host listening at ${socketPath()} (is Chrome running with the dev host?)\n`);
  process.exit(1);
}
if (before.op !== 'status') {
  process.stderr.write(`error: unexpected status reply: ${JSON.stringify(before)}\n`);
  process.exit(1);
}
if (!before.extensionConnected) {
  process.stderr.write('error: no extension connected to the host; load it once at chrome://extensions\n');
  process.exit(2);
}

const oldPid = before.pid;
const reply = await ask({ op: 'reload' });
if (reply?.op === 'error') {
  process.stderr.write(`error: ${reply.message}\n`);
  process.exit(/no extension connected/.test(reply.message) ? 2 : 1);
}
// A null reply here is not a failure: the host can die before its answer is flushed,
// which is exactly what a successful reload looks like from this side.
process.stderr.write(`reload requested (old host pid ${oldPid})\n`);

const deadline = Date.now() + timeoutMs;
let last = '';
while (Date.now() < deadline) {
  await delay(POLL_MS);
  const status = await ask({ op: 'status' });
  if (!status) {
    last = 'no host listening (the old one exited; waiting for Chrome to respawn it)';
    continue;
  }
  if (status.op !== 'status') {
    last = `unexpected reply ${JSON.stringify(status)}`;
    continue;
  }
  if (status.pid === oldPid) {
    last = `host pid is still ${oldPid} (the old process has not exited yet)`;
    continue;
  }
  if (!status.extensionConnected) {
    last = `host pid ${status.pid} is up but no extension is connected yet`;
    continue;
  }
  process.stdout.write(`reloaded: new host pid ${status.pid}\n`);
  process.exit(0);
}

process.stderr.write(`error: extension did not come back within ${timeoutMs / 1000}s: ${last}\n`);
process.exit(1);
