/**
 * Sink for extension-side diagnostics (`log.append`).
 *
 * Extension errors are otherwise only visible on chrome://extensions, which defeats an
 * unattended loop. The worker and the panel forward them here; the host writes one JSON
 * object per line to ~/.local/share/nanobrowser/ext.log and mirrors errors into host.log
 * so a single tail shows both sides of a failure.
 *
 * The extension redacts on the way out; `redact()` runs again here. Neither side trusts
 * the other with a secret (R-12).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log, redact } from './log.ts';
import { extLogPath } from './paths.ts';
import type { LogAppendMsg, LogLevel, LogSource } from './protocol.ts';

export class ExtLogError extends Error {}

const LEVELS: ReadonlySet<string> = new Set<LogLevel>(['error', 'warn', 'info']);
const SOURCES: ReadonlySet<string> = new Set<LogSource>(['worker', 'panel']);

export interface ExtLogEntry {
  level: LogLevel;
  source: LogSource;
  message: string;
  stack?: string;
  at: number;
}

/** Validates and normalises a `log.append` message into the entry that gets written. */
export function toEntry(msg: LogAppendMsg): ExtLogEntry {
  if (typeof msg.level !== 'string' || !LEVELS.has(msg.level)) {
    throw new ExtLogError('log.append requires level "error" | "warn" | "info"');
  }
  if (typeof msg.source !== 'string' || !SOURCES.has(msg.source)) {
    throw new ExtLogError('log.append requires source "worker" | "panel"');
  }
  if (typeof msg.message !== 'string') {
    throw new ExtLogError('log.append requires a string "message"');
  }
  return {
    level: msg.level,
    source: msg.source,
    message: msg.message,
    ...(typeof msg.stack === 'string' && msg.stack.length > 0 ? { stack: msg.stack } : {}),
    at: Number.isFinite(msg.at) ? Number(msg.at) : Date.now(),
  };
}

/**
 * Appends one redacted JSON line. Redaction happens on the serialized line, so a key
 * hiding in a stack frame or a message is caught the same way it is in host.log.
 */
export async function appendExtLog(entry: ExtLogEntry, file: string = extLogPath()): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, redact(JSON.stringify(entry)) + '\n', 'utf8');
  return file;
}

export interface ExtLogFilter {
  /** ISO timestamp; entries at or after it are kept. */
  since?: string;
  level?: LogLevel;
}

/**
 * Filters ext.log lines. Unparseable lines are dropped rather than thrown on: a truncated
 * final line (the host was killed mid-write) must not take the whole CLI down.
 */
export function filterExtLog(lines: Iterable<string>, filter: ExtLogFilter = {}): ExtLogEntry[] {
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
  if (filter.since && Number.isNaN(sinceMs)) throw new ExtLogError(`--since is not an ISO timestamp: ${filter.since}`);

  const out: ExtLogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry: ExtLogEntry;
    try {
      entry = JSON.parse(line) as ExtLogEntry;
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    if (filter.level && entry.level !== filter.level) continue;
    if (!Number.isNaN(sinceMs) && !(Number(entry.at) >= sinceMs)) continue;
    out.push(entry);
  }
  return out;
}

/** Reads and filters ext.log. A missing file is empty, not an error. */
export async function readExtLog(filter: ExtLogFilter = {}, file: string = extLogPath()): Promise<ExtLogEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return filterExtLog(text.split('\n'), filter);
}

/** Mirrors an error-level entry into host.log so one tail shows both sides of a failure. */
export function mirrorToHostLog(entry: ExtLogEntry): void {
  if (entry.level !== 'error') return;
  log('error', `[ext:${entry.source}] ${entry.message}`, entry.stack ? { stack: entry.stack } : undefined);
}
