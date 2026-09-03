#!/usr/bin/env node
/**
 * nb-run "<prompt>" [--url <url>] [--run-id <id>] [--option k=v]...
 *
 * Sends a run to the extension through the host's dev unix socket and streams the
 * run-log events back until run.end.
 */
import { connect, onResponses, send } from './socket-client.ts';

const argv = process.argv.slice(2);
const prompt = argv.find((a) => !a.startsWith('--'));
if (!prompt) {
  process.stderr.write('usage: nb-run "<prompt>" [--url <url>] [--run-id <id>] [--option k=v]...\n');
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const options: Record<string, unknown> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--option') {
    const kv = argv[i + 1] ?? '';
    const eq = kv.indexOf('=');
    if (eq > 0) options[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
}

const sock = await connect();
onResponses(sock, (msg) => {
  if (msg.op === 'accepted') {
    process.stderr.write(`runId=${msg.runId}\n`);
    return;
  }
  if (msg.op === 'event') {
    process.stdout.write(JSON.stringify(msg.event) + '\n');
    return;
  }
  if (msg.op === 'end') {
    sock.end();
    process.exit(0);
  }
  if (msg.op === 'error') {
    process.stderr.write(`error: ${msg.message}\n`);
    sock.end();
    process.exit(1);
  }
});
sock.on('close', () => process.exit(1));

send(sock, {
  op: 'run',
  prompt,
  ...(flag('url') ? { url: flag('url')! } : {}),
  ...(flag('run-id') ? { runId: flag('run-id')! } : {}),
  ...(Object.keys(options).length ? { options } : {}),
});
