// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { DebugSession, toRunEvents } from './debug';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

function script(code: string, id = 'script-1'): Userscript {
  return { id, name: 'probe', matches: ['*://hyperagent.com/*'], code, updatedAt: 0 };
}

describe('toRunEvents', () => {
  it('turns each captured console line into a userscript.output run event', () => {
    const result: UserscriptRunResult = {
      scriptId: 's1',
      ok: true,
      value: 1,
      console: [
        { level: 'log', text: 'a', at: 10 },
        { level: 'warn', text: 'b', at: 11 },
      ],
      durationMs: 3,
    };

    expect(toRunEvents(result)).toEqual([
      { kind: 'userscript.output', scriptId: 's1', level: 'log', text: 'a', at: 10 },
      { kind: 'userscript.output', scriptId: 's1', level: 'warn', text: 'b', at: 11 },
    ]);
  });

  it('appends the failure as a final error line', () => {
    const events = toRunEvents(
      {
        scriptId: 's1',
        ok: false,
        error: 'Error: boom (line 2, column 7)',
        console: [],
        durationMs: 1,
      },
      () => 500,
    );

    expect(events).toEqual([
      { kind: 'userscript.output', scriptId: 's1', level: 'error', text: 'Error: boom (line 2, column 7)', at: 500 },
    ]);
  });
});

describe('DebugSession', () => {
  beforeEach(() => {
    resetWorldConfiguration();
  });

  it('re-runs edited code in place and replaces the previous result', async () => {
    const api = vmUserScriptsApi();
    const session = new DebugSession({
      script: script("console.log('v1');\nreturn 1;"),
      tabId: 3,
      url: URL_IN_SCOPE,
      api,
    });

    const first = await session.rerun();
    expect(first.value).toBe(1);
    expect(session.last()).toBe(first);

    const second = await session.rerun("console.log('v2');\nreturn 2;");
    expect(second.value).toBe(2);
    expect(session.last()).toBe(second);
    expect(session.last()).not.toBe(first);
    expect(session.code).toBe("console.log('v2');\nreturn 2;");
    // The edit is not written back to the stored script.
    expect(session.script.code).toBe("console.log('v1');\nreturn 1;");
    expect(api.injections).toHaveLength(2);
  });

  it('exposes the last run as run-log events, with the error line mapped back', async () => {
    const session = new DebugSession({
      script: script(["console.log('before');", "throw new TypeError('nope');"].join('\n')),
      tabId: 3,
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
      now: () => 7,
    });

    await session.rerun();
    const events = session.events();

    expect(events[0]).toMatchObject({ kind: 'userscript.output', level: 'log', text: 'before' });
    expect(events[1]).toMatchObject({ kind: 'userscript.output', level: 'error', at: 7 });
    expect(events[1]).toHaveProperty('text', expect.stringMatching(/^TypeError: nope \(line 2, column \d+\)$/));
  });

  it('keeps the last result per script id when the selection changes', async () => {
    const runs: UserscriptRunResult[] = [];
    const session = new DebugSession({
      script: script('return 1;', 'a'),
      tabId: 1,
      run: async ({ script: target }) => {
        const result: UserscriptRunResult = {
          scriptId: target.id,
          ok: true,
          value: target.id,
          console: [],
          durationMs: 0,
        };
        runs.push(result);
        return result;
      },
    });

    await session.rerun();
    session.select(script('return 2;', 'b'));
    await session.rerun();

    expect(session.last('a')?.value).toBe('a');
    expect(session.last('b')?.value).toBe('b');
    expect(session.last()).toBe(session.last('b'));
    expect(session.code).toBe('return 2;');
    expect(runs).toHaveLength(2);
  });

  it('has no result before the first run', () => {
    const session = new DebugSession({ script: script('return 1;'), tabId: 1 });
    expect(session.last()).toBeUndefined();
    expect(session.events()).toEqual([]);
  });
});
