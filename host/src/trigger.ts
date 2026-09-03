import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log } from './log.ts';
import type { OutboundMsg, SocketRequest, SocketResponse } from './protocol.ts';

/**
 * Dev-only trigger. Chrome spawns the host, so an outside runner needs a side door
 * into a process it did not start. A unix socket is filesystem-permissioned (0600),
 * outside the network namespace, and invisible to every page in the browser --
 * unlike a loopback TCP listener, which any page could reach.
 *
 * Gated on NANOBROWSER_DEV=1 (or --dev in the manifest wrapper); never bound otherwise.
 */

export interface TriggerDeps {
  socketPath: string;
  /** Push a message to the extension over the native port. */
  send: (msg: OutboundMsg) => void;
  keyStatus: () => Promise<{ ready: boolean; reason?: string }>;
  extensionConnected: () => boolean;
  hostVersion: string;
  /** Test seam over `process.pid`. nb-reload watches it change to prove a new host came up. */
  pid?: () => number;
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export class TriggerServer {
  #server: net.Server | null = null;
  /** runId -> sockets streaming that run. */
  readonly #subs = new Map<string, Set<net.Socket>>();
  readonly #deps: TriggerDeps;

  constructor(deps: TriggerDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    const p = this.#deps.socketPath;
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    // A stale socket from a crashed host would make bind fail with EADDRINUSE.
    try {
      await fs.promises.unlink(p);
    } catch {
      /* not there: fine */
    }
    const server = net.createServer((sock) => this.#onConnection(sock));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await fs.promises.chmod(p, 0o600);
    log('info', 'dev trigger socket listening', { path: p });
  }

  #onConnection(sock: net.Socket): void {
    let buf = '';
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      for (const set of this.#subs.values()) set.delete(sock);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void this.#onLine(sock, line);
      }
    });
  }

  async #onLine(sock: net.Socket, line: string): Promise<void> {
    let req: SocketRequest;
    try {
      req = JSON.parse(line) as SocketRequest;
    } catch {
      return write(sock, { op: 'error', message: 'invalid JSON' });
    }

    if (req.op === 'status') {
      const key = await this.#deps.keyStatus();
      write(sock, {
        op: 'status',
        ok: true,
        extensionConnected: this.#deps.extensionConnected(),
        hostVersion: this.#deps.hostVersion,
        pid: this.#pid(),
        key,
      });
      sock.end();
      return;
    }

    if (req.op === 'reload') {
      if (!this.#deps.extensionConnected()) {
        write(sock, { op: 'error', message: 'no extension connected to the host' });
        sock.end();
        return;
      }
      // `chrome.runtime.reload()` tears down the service worker, which drops the native
      // port, which kills THIS process. So answer first -- there is no later.
      write(sock, { op: 'reloading', pid: this.#pid() });
      this.#deps.send({ type: 'ext.reload' });
      sock.end();
      return;
    }

    if (req.op === 'run') {
      if (typeof req.prompt !== 'string' || req.prompt.length === 0) {
        return write(sock, { op: 'error', message: 'run requires a non-empty "prompt"' });
      }
      if (!this.#deps.extensionConnected()) {
        write(sock, { op: 'error', message: 'no extension connected to the host' });
        sock.end();
        return;
      }
      const runId = req.runId ?? newRunId();
      let set = this.#subs.get(runId);
      if (!set) this.#subs.set(runId, (set = new Set()));
      set.add(sock);
      write(sock, { op: 'accepted', runId });
      this.#deps.send({
        type: 'run.start',
        runId,
        prompt: req.prompt,
        ...(req.url ? { url: req.url } : {}),
        ...(req.options ? { options: req.options } : {}),
      });
      return;
    }

    write(sock, { op: 'error', message: `unknown op ${String((req as { op: string }).op)}` });
  }

  #pid(): number {
    return (this.#deps.pid ?? (() => process.pid))();
  }

  /** Mirror a run-log event to whoever is streaming that run; close them on run.end. */
  publish(runId: string, event: unknown): void {
    const set = this.#subs.get(runId);
    if (!set || set.size === 0) return;
    for (const sock of set) write(sock, { op: 'event', runId, event });
    const type = (event as { type?: unknown } | null)?.type;
    if (type === 'run.end') {
      for (const sock of set) {
        write(sock, { op: 'end', runId });
        sock.end();
      }
      this.#subs.delete(runId);
    }
  }

  async close(): Promise<void> {
    for (const set of this.#subs.values()) for (const s of set) s.destroy();
    this.#subs.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fs.promises.unlink(this.#deps.socketPath);
    } catch {
      /* already gone */
    }
  }
}

function write(sock: net.Socket, msg: SocketResponse): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}
