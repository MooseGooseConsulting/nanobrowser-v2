/**
 * Live userscript debugging (R-10), scoped to what O-03 actually asks for:
 * *edit and re-run in place, with captured console and errors*. No breakpoints.
 *
 * Breakpoints would mean `chrome.debugger`/CDP, which raises Chrome's permanent
 * "started debugging this browser" infobar — a hard failure of R-02. See
 * `docs/research/userscripts-api.md` §3-D. So the debug loop is: edit the code,
 * re-run it in the same tab, read the console lines and the error (with the line
 * and column mapped back onto the user's own source), edit again.
 */
import type { RunEvent, Userscript, UserscriptRunResult } from '@/src/messaging';
import {
  runUserscript,
  type RunUserscriptOptions,
  type TabsApi,
  type UserScriptsApi,
  type AvailabilityEnv,
} from './runner';

export type RunUserscript = (options: RunUserscriptOptions) => Promise<UserscriptRunResult>;

export interface DebugSessionOptions {
  script: Userscript;
  tabId: number;
  url?: string;
  api?: UserScriptsApi;
  tabs?: TabsApi;
  env?: AvailabilityEnv;
  now?: () => number;
  /** Injected in tests; defaults to the real {@link runUserscript}. */
  run?: RunUserscript;
}

/**
 * Turns one run's captured output into run-log events (R-07). Console lines keep
 * their own timestamps; a failure becomes one final `error` line so the log shows
 * why the run stopped without the panel having to special-case it.
 */
export function toRunEvents(result: UserscriptRunResult, now: () => number = Date.now): RunEvent[] {
  const events: RunEvent[] = result.console.map((line) => ({
    kind: 'userscript.output',
    scriptId: result.scriptId,
    level: line.level,
    text: line.text,
    at: line.at,
  }));

  if (!result.ok && result.error) {
    events.push({
      kind: 'userscript.output',
      scriptId: result.scriptId,
      level: 'error',
      text: result.error,
      at: now(),
    });
  }

  return events;
}

/**
 * One live debug session over a tab. Holds the last result per script id, so the
 * panel can re-open a script and still see what it did last time, and `rerun()`
 * replaces that result rather than accumulating history.
 */
export class DebugSession {
  private readonly results = new Map<string, UserscriptRunResult>();
  private readonly run: RunUserscript;
  private readonly now: () => number;
  private current: Userscript;
  private draft: string;

  constructor(private readonly options: DebugSessionOptions) {
    this.current = options.script;
    this.draft = options.script.code;
    this.run = options.run ?? runUserscript;
    this.now = options.now ?? Date.now;
  }

  get script(): Userscript {
    return this.current;
  }

  /** The code the next `rerun()` will use — the last edit, or the stored code. */
  get code(): string {
    return this.draft;
  }

  /** Points the session at a different (or updated) script, clearing the draft edit. */
  select(script: Userscript): void {
    this.current = script;
    this.draft = script.code;
  }

  /** The last result for a script, or `undefined` if it has not been run here. */
  last(scriptId: string = this.current.id): UserscriptRunResult | undefined {
    return this.results.get(scriptId);
  }

  /** Run-log events for the last run of a script. Empty when there is no result yet. */
  events(scriptId: string = this.current.id): RunEvent[] {
    const result = this.results.get(scriptId);
    return result ? toRunEvents(result, this.now) : [];
  }

  /**
   * Re-runs the script, optionally with edited code. The edit is *not* persisted to
   * the catalog — the panel saves explicitly — so a bad edit never becomes the
   * stored script. The new result replaces the previous one for this script id.
   */
  async rerun(code?: string): Promise<UserscriptRunResult> {
    if (code !== undefined) this.draft = code;

    const result = await this.run({
      tabId: this.options.tabId,
      script: this.current,
      code: this.draft,
      url: this.options.url,
      api: this.options.api,
      tabs: this.options.tabs,
      env: this.options.env,
      now: this.options.now,
    });

    this.results.set(this.current.id, result);
    return result;
  }
}
