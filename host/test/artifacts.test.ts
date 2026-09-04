import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactError, artifactPath, assertFilename, MAX_ARTIFACT_BYTES, saveArtifact } from '../src/artifacts.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-artifacts-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('filename validation', () => {
  it.each(['result.json', 'a.txt', 'sold-ddr5.csv', 'x'.repeat(96) + '.json'])('accepts %s', (name) => {
    expect(() => assertFilename(name)).not.toThrow();
  });

  it.each(['', '../evil.json', 'a/b.json', 'a\\b.json', '..'])('rejects %j', (name) => {
    expect(() => assertFilename(name)).toThrow(ArtifactError);
  });

  it('rejects non-strings', () => {
    expect(() => assertFilename(undefined)).toThrow(ArtifactError);
    expect(() => assertFilename(7)).toThrow(ArtifactError);
  });

  it('never escapes the artifacts directory', () => {
    expect(() => artifactPath('run-1', '../../etc/passwd', dir)).toThrow(ArtifactError);
  });

  it('rejects a bad runId even with a fine filename', () => {
    expect(() => artifactPath('../escape', 'result.json', dir)).toThrow();
  });
});

describe('saveArtifact', () => {
  it('writes the file under <dir>/<runId>/<filename> and reports its byte count', async () => {
    const result = await saveArtifact('run-1', 'result.json', '{"a":1}', dir);
    expect(result.path).toBe(path.join(dir, 'run-1', 'result.json'));
    expect(result.bytes).toBe(Buffer.byteLength('{"a":1}', 'utf8'));
    expect(await fs.readFile(result.path, 'utf8')).toBe('{"a":1}');
  });

  it('creates the run directory as needed', async () => {
    await saveArtifact('run-a', 'a.txt', 'hello', dir);
    expect((await fs.readdir(dir)).sort()).toEqual(['run-a']);
  });

  it('writes with mode 0600', async () => {
    const result = await saveArtifact('run-1', 'result.json', 'x', dir);
    const stat = await fs.stat(result.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('keeps separate runs in separate directories', async () => {
    await saveArtifact('run-a', 'a.json', '1', dir);
    await saveArtifact('run-b', 'a.json', '2', dir);
    expect(await fs.readFile(path.join(dir, 'run-a', 'a.json'), 'utf8')).toBe('1');
    expect(await fs.readFile(path.join(dir, 'run-b', 'a.json'), 'utf8')).toBe('2');
  });

  it('rejects content over the byte cap without writing anything', async () => {
    const big = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
    await expect(saveArtifact('run-1', 'big.txt', big, dir)).rejects.toThrow(ArtifactError);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects a filename with a path separator without writing anything', async () => {
    await expect(saveArtifact('run-1', '../escape.json', 'x', dir)).rejects.toThrow(ArtifactError);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
