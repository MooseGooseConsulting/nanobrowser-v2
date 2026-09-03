import net from 'node:net';
import { socketPath } from '../paths.ts';
import type { SocketRequest, SocketResponse } from '../protocol.ts';

/** Connect to the dev trigger socket and stream NDJSON responses. */
export function connect(p: string = socketPath()): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(p);
    sock.once('connect', () => resolve(sock));
    sock.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new Error(`no host listening at ${p} (is Chrome running with the dev host? NANOBROWSER_DEV=1)`)
          : err,
      );
    });
  });
}

export function send(sock: net.Socket, req: SocketRequest): void {
  sock.write(JSON.stringify(req) + '\n');
}

export function onResponses(sock: net.Socket, fn: (msg: SocketResponse) => void): void {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) fn(JSON.parse(line) as SocketResponse);
    }
  });
}
