#!/usr/bin/env node
/** nb-status -- host liveness plus validated key readiness (R-11). Exit 0 only if both. */
import { connect, onResponses, send } from './socket-client.ts';

const sock = await connect();
onResponses(sock, (msg) => {
  if (msg.op === 'status') {
    process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
    process.exit(msg.key.ready ? 0 : 1);
  }
  if (msg.op === 'error') {
    process.stderr.write(`error: ${msg.message}\n`);
    process.exit(1);
  }
});
sock.on('close', () => process.exit(1));
send(sock, { op: 'status' });
