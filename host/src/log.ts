import fs from 'node:fs';
import { dataDir, hostLogPath } from './paths.ts';

/**
 * Diagnostics only. Chrome owns stdout, so everything human-readable goes to
 * ~/.local/share/nanobrowser/host.log and to stderr.
 *
 * Nothing that could carry the API key is ever passed in, and as a second line of
 * defence every line is run through redact() before it is written.
 */

const secrets = new Set<string>();

/** Register a literal value that must never appear in the log. */
export function protectSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

const KEY_SHAPES = [/sk-or-v1-[A-Za-z0-9]{8,}/g, /\bsk-[A-Za-z0-9]{20,}\b/g, /\bdp\.(?:ct|st)\.[A-Za-z0-9._-]{8,}/g];

export function redact(line: string): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  for (const re of KEY_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

let stream: fs.WriteStream | null = null;

function sink(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    stream = fs.createWriteStream(hostLogPath(), { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
    return stream;
  } catch {
    return null;
  }
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
  const line = redact(
    JSON.stringify({ ts: new Date().toISOString(), level, message, ...(fields ?? {}) }),
  );
  sink()?.write(line + '\n');
  if (process.env.NANOBROWSER_LOG_STDERR !== '0') process.stderr.write(line + '\n');
}

/** Test seam: forget the cached stream and registered secrets. */
export function resetLogForTests(): void {
  stream?.end();
  stream = null;
  secrets.clear();
}
