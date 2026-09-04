#!/usr/bin/env node
/**
 * The native-messaging host IS the daemon: one process, one channel.
 * Chrome spawns it over stdio; there is no listening TCP port and no auth token,
 * because `allowed_origins` in the host manifest already restricts who can talk to it.
 *
 * stdout belongs to the native-messaging protocol. Diagnostics go to host.log/stderr.
 */
import { CassetteStore, cassetteMode } from './cassette.ts';
import { Dispatcher } from './dispatcher.ts';
import { encodeFrame, FrameParser } from './framing.ts';
import { LlmProxy } from './llm.ts';
import { log } from './log.ts';
import { artifactsDir, cassetteDir, extLogPath, runsDir, socketPath } from './paths.ts';
import type { OutboundMsg } from './protocol.ts';
import { DopplerSecretProvider, SecretStore } from './secrets.ts';
import { TriggerServer } from './trigger.ts';

export const HOST_VERSION = '0.0.1';

const dev = process.env.NANOBROWSER_DEV === '1' || process.argv.includes('--dev');

function send(msg: OutboundMsg): void {
  try {
    process.stdout.write(encodeFrame(msg));
  } catch (err) {
    log('error', 'failed to encode outbound message', { type: msg.type, error: (err as Error).message });
  }
}

async function main(): Promise<void> {
  log('info', 'host starting', { dev, cassette: cassetteMode(), pid: process.pid });

  const secrets = new SecretStore(new DopplerSecretProvider());
  await secrets.load();
  if (!secrets.openRouterKey) log('warn', 'no OpenRouter key loaded', { reason: secrets.missingReason });

  const llm = new LlmProxy({
    fetch: globalThis.fetch,
    secrets,
    send,
    cassetteMode: cassetteMode(),
    cassettes: new CassetteStore(cassetteDir()),
  });

  // Chrome spawns this process only on `connectNative`, so an open stdin IS the
  // extension's connection; it is cleared when stdin ends.
  let extensionConnected = true;
  let trigger: TriggerServer | null = null;

  const dispatcher = new Dispatcher({
    send,
    llm,
    runsDir: runsDir(),
    extLogPath: extLogPath(),
    artifactsDir: artifactsDir(),
    onRunEvent: (runId, event) => trigger?.publish(runId, event),
  });

  if (dev) {
    trigger = new TriggerServer({
      socketPath: socketPath(),
      send,
      keyStatus: () => llm.keyStatus(),
      extensionConnected: () => extensionConnected,
      hostVersion: HOST_VERSION,
    });
    try {
      await trigger.start();
    } catch (err) {
      log('error', 'dev trigger socket failed to bind', { error: (err as Error).message });
      trigger = null;
    }
  }

  const shutdown = async (code: number): Promise<void> => {
    log('info', 'host shutting down', { code });
    llm.abortAll();
    await trigger?.close();
    process.exit(code);
  };

  const parser = new FrameParser();
  process.stdin.on('data', (chunk: Buffer) => {
    extensionConnected = true;
    let messages: unknown[];
    try {
      messages = parser.push(chunk);
    } catch (err) {
      log('error', 'framing error, closing', { error: (err as Error).message });
      void shutdown(1);
      return;
    }
    for (const m of messages) {
      void dispatcher.handle(m).catch((err: unknown) => {
        log('error', 'dispatcher threw', { error: (err as Error).message });
      });
    }
  });

  process.stdin.on('end', () => {
    extensionConnected = false;
    void shutdown(0);
  });
  process.stdin.on('close', () => void shutdown(0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => void shutdown(0));
  }

  send({ type: 'hello', hostVersion: HOST_VERSION, dev, cassette: cassetteMode() });
}

main().catch((err: unknown) => {
  log('error', 'host failed to start', { error: (err as Error).message });
  process.exit(1);
});
