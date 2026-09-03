import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import { appendExtLog, ExtLogError, filterExtLog, readExtLog, toEntry } from '../src/extlog.ts';
import { resetLogForTests } from '../src/log.ts';
import type { OutboundMsg } from '../src/protocol.ts';
import { makeHarness, type Harness } from './harness.ts';

let dir: string;
let file: string;
let prevHome: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-extlog-'));
  file = path.join(dir, 'ext.log');
  // Keep the host.log mirror (and every other log() call) out of the real profile.
  prevHome = process.env.NB_HOME;
  process.env.NB_HOME = dir;
  process.env.NANOBROWSER_LOG_STDERR = '0';
  resetLogForTests();
});
afterEach(async () => {
  resetLogForTests();
  if (prevHome === undefined) delete process.env.NB_HOME;
  else process.env.NB_HOME = prevHome;
  await fs.rm(dir, { recursive: true, force: true });
});

async function lines(): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(file, 'utf8');
  return text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A dispatcher pointed at the temp ext.log; the harness one writes to the default path. */
async function dispatcherFor(h: Harness, sent: OutboundMsg[]): Promise<Dispatcher> {
  return new Dispatcher({ send: (m) => sent.push(m), llm: h.llm, runsDir: h.runsDir, extLogPath: file });
}

describe('log.append', () => {
  it('writes one JSON line per entry and acks, creating the directory', async () => {
    const h = await makeHarness();
    const sent: OutboundMsg[] = [];
    // A nested path the host has never created: appendExtLog must mkdir -p its parent.
    file = path.join(dir, 'deep', 'ext.log');
    const d = await dispatcherFor(h, sent);

    await d.handle({ type: 'log.append', id: 'L1', level: 'error', source: 'worker', message: 'boom', at: 5 });
    await d.handle({ type: 'log.append', level: 'warn', source: 'panel', message: 'careful', at: 6 });

    expect(await lines()).toEqual([
      { level: 'error', source: 'worker', message: 'boom', at: 5 },
      { level: 'warn', source: 'panel', message: 'careful', at: 6 },
    ]);
    // `id` is optional and only echoed when the caller sent one.
    expect(sent).toEqual([
      { type: 'log.ack', id: 'L1', ok: true },
      { type: 'log.ack', ok: true },
    ]);
    await h.cleanup();
  });

  it('keeps a stack when present and drops an empty one', async () => {
    const h = await makeHarness();
    const sent: OutboundMsg[] = [];
    const d = await dispatcherFor(h, sent);
    await d.handle({
      type: 'log.append',
      level: 'error',
      source: 'worker',
      message: 'boom',
      stack: 'at foo (bar.js:1)',
      at: 1,
    });
    await d.handle({ type: 'log.append', level: 'info', source: 'worker', message: 'hi', stack: '', at: 2 });
    const [a, b] = await lines();
    expect(a!.stack).toBe('at foo (bar.js:1)');
    expect(b).not.toHaveProperty('stack');
    await h.cleanup();
  });

  it('redacts an OpenRouter key in the message and in the stack, and writes nothing else', async () => {
    const h = await makeHarness();
    const sent: OutboundMsg[] = [];
    const d = await dispatcherFor(h, sent);
    await d.handle({
      type: 'log.append',
      level: 'error',
      source: 'panel',
      message: 'fetch failed with sk-or-v1-abcdef0123456789 in the header',
      stack: 'Authorization: Bearer sk-or-v1-abcdef0123456789',
      at: 3,
    });

    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('sk-or-');
    expect(text).not.toContain('abcdef0123456789');
    expect(text).toContain('[redacted]');
    await h.cleanup();
  });

  it('mirrors errors into host.log but leaves warn and info out of it', async () => {
    const h = await makeHarness();
    const sent: OutboundMsg[] = [];
    const d = await dispatcherFor(h, sent);
    await d.handle({ type: 'log.append', level: 'error', source: 'panel', message: 'panel blew up', at: 1 });
    await d.handle({ type: 'log.append', level: 'warn', source: 'worker', message: 'merely odd', at: 2 });
    // The stream is async; end it so everything is flushed before we read.
    resetLogForTests();

    const hostLog = await fs.readFile(path.join(dir, '.local', 'share', 'nanobrowser', 'host.log'), 'utf8');
    expect(hostLog).toContain('[ext:panel] panel blew up');
    expect(hostLog).not.toContain('merely odd');
    await h.cleanup();
  });

  it('rejects a bad level, source, or message without writing', async () => {
    const h = await makeHarness();
    const sent: OutboundMsg[] = [];
    const d = await dispatcherFor(h, sent);
    await d.handle({ type: 'log.append', id: 'x', level: 'fatal', source: 'worker', message: 'm', at: 1 });
    await d.handle({ type: 'log.append', id: 'y', level: 'error', source: 'content', message: 'm', at: 1 });
    await d.handle({ type: 'log.append', id: 'z', level: 'error', source: 'worker', message: 7, at: 1 });

    expect(sent.map((m) => m.type)).toEqual(['error', 'error', 'error']);
    expect(sent.every((m) => (m as { code: string }).code === 'bad_request')).toBe(true);
    await expect(fs.stat(file)).rejects.toThrow();
    await h.cleanup();
  });

  it('defaults a missing `at` to now rather than writing NaN', () => {
    const entry = toEntry({ type: 'log.append', level: 'info', source: 'worker', message: 'm' } as never);
    expect(Number.isFinite(entry.at)).toBe(true);
  });
});

describe('appendExtLog', () => {
  it('appends rather than truncating', async () => {
    await appendExtLog({ level: 'info', source: 'worker', message: 'one', at: 1 }, file);
    await appendExtLog({ level: 'info', source: 'worker', message: 'two', at: 2 }, file);
    expect((await lines()).map((e) => e.message)).toEqual(['one', 'two']);
  });
});

describe('nb-logs filtering', () => {
  const entries = [
    { level: 'info', source: 'worker', message: 'a', at: Date.parse('2026-01-01T00:00:00.000Z') },
    { level: 'warn', source: 'panel', message: 'b', at: Date.parse('2026-01-02T00:00:00.000Z') },
    { level: 'error', source: 'worker', message: 'c', at: Date.parse('2026-01-03T00:00:00.000Z') },
    { level: 'error', source: 'panel', message: 'd', at: Date.parse('2026-01-04T00:00:00.000Z') },
  ] as const;
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

  it('returns everything with no filter', () => {
    expect(filterExtLog(text.split('\n')).map((e) => e.message)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by level', () => {
    expect(filterExtLog(text.split('\n'), { level: 'error' }).map((e) => e.message)).toEqual(['c', 'd']);
  });

  it('filters by --since, inclusive of the boundary', () => {
    expect(filterExtLog(text.split('\n'), { since: '2026-01-03T00:00:00.000Z' }).map((e) => e.message)).toEqual([
      'c',
      'd',
    ]);
  });

  it('combines --since and --level', () => {
    const got = filterExtLog(text.split('\n'), { since: '2026-01-02T00:00:00.000Z', level: 'error' });
    expect(got.map((e) => e.message)).toEqual(['c', 'd']);
  });

  it('skips a truncated final line instead of throwing', () => {
    const partial = text + '{"level":"error","mess';
    expect(filterExtLog(partial.split('\n')).map((e) => e.message)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects a --since that is not a timestamp', () => {
    expect(() => filterExtLog([], { since: 'yesterday' })).toThrow(ExtLogError);
  });

  it('reads the file, and treats a missing one as empty', async () => {
    await fs.writeFile(file, text, 'utf8');
    expect((await readExtLog({ level: 'error' }, file)).map((e) => e.message)).toEqual(['c', 'd']);
    expect(await readExtLog({}, path.join(dir, 'nope.log'))).toEqual([]);
  });
});
