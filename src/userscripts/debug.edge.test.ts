// @vitest-environment jsdom
/**
 * Concurrency coverage for `DebugSession.rerun()`.
 *
 * The review found a real race: `rerun()` read `this.current.id` *after* its
 * `await`, so (a) two overlapping `rerun()` calls on the same script raced on
 * `this.results.set` -- whichever call's promise settled last won, regardless
 * of which was started last, contradicting the documented "replaces the
 * previous result" contract; and (b) a `select()` call made while a `rerun()`
 * was still in flight would make that in-flight call's result land under the
 * *new* current script's id once it resolved, not the script it actually ran.
 * `debug.ts` now captures the script and a per-script sequence number before
 * the `await`, and only commits a result if it is still the latest issued for
 * that script id when it resolves.
 */
import { describe, expect, it } from 'vitest';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { DebugSession } from './debug';
import type { RunUserscriptOptions } from './runner';

function script(id: string, code: string): Userscript {
  return { id, name: id, matches: ['<all_urls>'], code, updatedAt: 0 };
}

function result(scriptId: string, value: string): UserscriptRunResult {
  return { scriptId, ok: true, value, console: [], durationMs: 0 };
}

/** A `run` double whose resolution order is controlled by the test, keyed by the code string. */
function controllableRun() {
  const pending = new Map<string, { resolve: (r: UserscriptRunResult) => void }>();
  const run = (options: RunUserscriptOptions): Promise<UserscriptRunResult> =>
    new Promise((resolve) => {
      pending.set(options.code ?? options.script.code, { resolve });
    });
  const settle = (code: string, value: string): void => {
    const p = pending.get(code);
    if (!p) throw new Error(`no pending run for code ${code}`);
    pending.delete(code);
    p.resolve(result('script-1', value));
  };
  return { run, settle };
}

describe('DebugSession.rerun: overlapping calls on the same script', () => {
  it('keeps the result of the call started last, even when it resolves first', async () => {
    const { run, settle } = controllableRun();
    const session = new DebugSession({ script: script('script-1', 'first'), tabId: 1, run });

    const slower = session.rerun('slow-call');
    const faster = session.rerun('fast-call');

    // The second (later-started) call resolves first.
    settle('fast-call', 'fast-result');
    await faster;
    expect(session.last('script-1')?.value).toBe('fast-result');

    // The first (earlier-started) call resolves after it -- it must NOT clobber
    // the later call's already-stored result.
    settle('slow-call', 'slow-result');
    await slower;
    expect(session.last('script-1')?.value).toBe('fast-result');
  });

  it('each call still returns its own result to its own caller, even when not committed', async () => {
    const { run, settle } = controllableRun();
    const session = new DebugSession({ script: script('script-1', 'first'), tabId: 1, run });

    const slower = session.rerun('slow-call');
    const faster = session.rerun('fast-call');
    settle('fast-call', 'fast-result');
    settle('slow-call', 'slow-result');

    await expect(faster).resolves.toMatchObject({ value: 'fast-result' });
    await expect(slower).resolves.toMatchObject({ value: 'slow-result' });
  });
});

describe('DebugSession.rerun: select() during an in-flight rerun', () => {
  it('attributes an in-flight run to the script it was started against, not whatever select() made current', async () => {
    const { run, settle } = controllableRun();
    const session = new DebugSession({ script: script('script-a', 'code-a'), tabId: 1, run });

    const inFlight = session.rerun(); // runs against script-a with its stored code

    // The panel opens a different script while script-a's run is still pending.
    session.select(script('script-b', 'code-b'));

    settle('code-a', 'result-for-a');
    await inFlight;

    expect(session.last('script-a')?.value).toBe('result-for-a');
    expect(session.last('script-b')).toBeUndefined();
  });
});
