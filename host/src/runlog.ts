import fs from 'node:fs/promises';
import path from 'node:path';
import { runsDir } from './paths.ts';
import { RUN_ID_RE } from './protocol.ts';

export class RunLogError extends Error {}

export function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new RunLogError('runId must match [A-Za-z0-9_-]{1,64}');
  }
}

export function runLogPath(runId: string, dir: string = runsDir()): string {
  assertRunId(runId);
  return path.join(dir, `${runId}.jsonl`);
}

/** Append one JSON line. The runId is validated before it ever touches a path. */
export async function appendRunLog(runId: string, event: unknown, dir: string = runsDir()): Promise<string> {
  const file = runLogPath(runId, dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
  return file;
}
