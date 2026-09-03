import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRunLog, assertRunId, RunLogError, runLogPath } from '../src/runlog.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-runs-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runId validation', () => {
  it.each(['a', 'run-1', 'A_b-C9', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(() => assertRunId(id)).not.toThrow();
  });

  it.each(['', 'x'.repeat(65), '../escape', 'a/b', 'a.b', 'a b', 'run\n1', 'run '])('rejects %j', (id) => {
    expect(() => assertRunId(id)).toThrow(RunLogError);
  });

  it('rejects non-strings', () => {
    expect(() => assertRunId(undefined)).toThrow(RunLogError);
    expect(() => assertRunId(7)).toThrow(RunLogError);
  });

  it('never escapes the runs directory', () => {
    expect(() => runLogPath('../../etc/passwd', dir)).toThrow(RunLogError);
  });
});

describe('appendRunLog', () => {
  it('appends one JSON line per event and creates the directory', async () => {
    const nested = path.join(dir, 'deep', 'runs');
    await appendRunLog('run-1', { type: 'run.start', step: 0 }, nested);
    await appendRunLog('run-1', { type: 'tool.call', step: 1 }, nested);
    const text = await fs.readFile(path.join(nested, 'run-1.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'run.start', step: 0 });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'tool.call', step: 1 });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps separate runs in separate files', async () => {
    await appendRunLog('run-a', { a: 1 }, dir);
    await appendRunLog('run-b', { b: 2 }, dir);
    expect((await fs.readdir(dir)).sort()).toEqual(['run-a.jsonl', 'run-b.jsonl']);
  });

  it('writes an event containing a newline as a single line', async () => {
    await appendRunLog('run-1', { text: 'a\nb' }, dir);
    const text = await fs.readFile(path.join(dir, 'run-1.jsonl'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({ text: 'a\nb' });
  });
});
