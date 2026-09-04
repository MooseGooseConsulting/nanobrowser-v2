/**
 * `save_file`'s host-side half (docs/host-protocol.md's `artifact.save`): writes a
 * Follower-produced file to `<artifactsDir>/<runId>/<filename>`.
 *
 * The extension already validates the filename before it ever sends this (basename
 * only, an allowed extension, no separators or "..") -- this module re-validates
 * from scratch anyway, the same way `runlog.ts` never trusts a client-supplied
 * runId: a malicious or buggy client is exactly the case host-side validation
 * exists for.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from './paths.ts';
import { assertRunId } from './runlog.ts';

export class ArtifactError extends Error {}

/** Cap on one artifact's content. Comfortably larger than any scraped-JSON result. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Rejects a path separator, ".." anywhere, or an empty/non-string name. */
export function assertFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new ArtifactError('filename must be a non-empty string');
  }
  if (filename.includes('/') || filename.includes('\\')) {
    throw new ArtifactError('filename must not contain a path separator');
  }
  if (filename.includes('..')) {
    throw new ArtifactError('filename must not contain ".."');
  }
}

/** The per-run directory an artifact lands in. Validates `runId` before it touches a path. */
export function runArtifactsDir(runId: string, dir: string = artifactsDir()): string {
  assertRunId(runId);
  return path.join(dir, runId);
}

/** Full path an artifact would be written to. Validates both `runId` and `filename`. */
export function artifactPath(runId: string, filename: string, dir: string = artifactsDir()): string {
  assertFilename(filename);
  return path.join(runArtifactsDir(runId, dir), filename);
}

/**
 * Writes one artifact, creating `<dir>/<runId>/` as needed. Mode 0600: this is the
 * only host output that holds arbitrary Follower-produced content, so it gets the
 * same "nobody else on the box can read it" treatment as everything else here.
 */
export async function saveArtifact(
  runId: string,
  filename: string,
  content: string,
  dir: string = artifactsDir(),
): Promise<{ path: string; bytes: number }> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte cap (${bytes} bytes)`);
  }
  const targetDir = runArtifactsDir(runId, dir);
  assertFilename(filename);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, filename);
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  return { path: file, bytes };
}
