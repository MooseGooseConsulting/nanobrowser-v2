import { homedir } from 'node:os';
import path from 'node:path';

/**
 * `NB_HOME` overrides the home directory root for every path below. It exists so
 * install.sh and the tests can write into a temp tree instead of the real profile.
 */
export function home(): string {
  return process.env.NB_HOME || homedir();
}

export function dataDir(): string {
  const xdg = process.env.NB_HOME ? undefined : process.env.XDG_DATA_HOME;
  return path.join(xdg || path.join(home(), '.local', 'share'), 'nanobrowser');
}

export function runsDir(): string {
  return path.join(dataDir(), 'runs');
}

export function hostLogPath(): string {
  return path.join(dataDir(), 'host.log');
}

export function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(dataDir(), 'run');
  return process.env.NANOBROWSER_SOCK || path.join(runtime, 'nanobrowser.sock');
}

/** Repo-relative cassette directory: host/cassettes/. */
export function cassetteDir(): string {
  return process.env.NANOBROWSER_CASSETTE_DIR || path.resolve(import.meta.dirname, '..', 'cassettes');
}
