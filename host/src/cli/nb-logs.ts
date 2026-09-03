#!/usr/bin/env node
/**
 * nb-logs [--since <iso>] [--level error|warn|info] [--json] [--file <path>]
 *
 * Prints what the extension forwarded over `log.append` -- errors that would otherwise
 * only exist on the chrome://extensions page nobody is watching during an unattended run.
 *
 * Reads the file directly rather than the dev socket: the log outlives every host process,
 * and after a `chrome.runtime.reload()` the host that saw the error is already gone.
 */
import { extLogPath } from '../paths.ts';
import { ExtLogError, readExtLog, type ExtLogFilter } from '../extlog.ts';
import type { LogLevel } from '../protocol.ts';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const level = flag('level');
if (level !== undefined && !['error', 'warn', 'info'].includes(level)) {
  process.stderr.write(`usage: nb-logs [--since <iso>] [--level error|warn|info] [--json] [--file <path>]\n`);
  process.exit(2);
}

const filter: ExtLogFilter = {
  ...(flag('since') ? { since: flag('since')! } : {}),
  ...(level ? { level: level as LogLevel } : {}),
};
const file = flag('file') ?? extLogPath();

try {
  const entries = await readExtLog(filter, file);
  for (const e of entries) {
    if (argv.includes('--json')) {
      process.stdout.write(JSON.stringify(e) + '\n');
      continue;
    }
    const ts = new Date(e.at).toISOString();
    process.stdout.write(`${ts} ${e.level.padEnd(5)} ${e.source.padEnd(6)} ${e.message}\n`);
    if (e.stack) process.stdout.write(e.stack.replace(/^/gm, '    ') + '\n');
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`error: ${(err as ExtLogError).message}\n`);
  process.exit(2);
}
