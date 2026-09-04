/**
 * Shared message contract between the side panel, the service worker, and the
 * agent loop. Every builder conforms to this file; extend it, do not fork it.
 *
 * Wire: `Envelope<T>` from ./port carries `{ type, id, payload }`. The `type`
 * values used are the string keys of `PanelToWorker` / `WorkerToPanel`.
 */
import type { Config, ObserveMode, InputFidelity } from '@/src/storage';

export type RunId = string;

/** Follower -> Leader control signal (R-03, verbatim vocabulary). */
export type FollowerSignal = 'CONTINUE' | 'SUBGOAL_COMPLETE' | 'RETURN_TO_LEADER' | 'BLOCKED';

export type Role = 'leader' | 'follower';

/** One tool invocation as the UI shows it (R-06). */
export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Short, UI-safe summary. Full payloads (snapshots, screenshots) are never echoed back here. */
  summary: string;
  durationMs: number;
}

/**
 * The run log (R-07). Every entry is appended in order and streamed to the panel
 * and to the host run-log sink unchanged. Add variants; never repurpose one.
 */
export type RunEvent =
  | { kind: 'run.started'; runId: RunId; prompt: string; config: Config; tabId: number; url: string; at: number }
  | { kind: 'step'; n: number; role: Role; at: number }
  | { kind: 'leader.plan'; plan: string; subgoals: string[]; replan: boolean; at: number }
  | { kind: 'handoff'; from: Role; to: Role; reason: string; signal?: FollowerSignal; at: number }
  | { kind: 'follower.signal'; signal: FollowerSignal; note: string; at: number }
  | { kind: 'tool.call'; role: Role; call: ToolCall; at: number }
  | { kind: 'tool.result'; role: Role; result: ToolResult; at: number }
  | { kind: 'model.text'; role: Role; text: string; at: number }
  | { kind: 'observation'; mode: ObserveMode; tokens?: number; hasScreenshot: boolean; at: number }
  | { kind: 'input.fidelity'; fidelity: InputFidelity; attached: boolean; at: number }
  | { kind: 'userscript.output'; scriptId: string; level: 'log' | 'warn' | 'error'; text: string; at: number }
  | { kind: 'file.saved'; runId: RunId; filename: string; bytes: number; path: string; at: number }
  | { kind: 'run.paused'; at: number }
  | { kind: 'run.resumed'; at: number }
  | { kind: 'run.ended'; status: 'done' | 'aborted' | 'blocked' | 'max-steps' | 'error'; message: string; steps: number; at: number };

/** Model entry as shown in the panel selectors (R-11). */
export interface ModelInfo {
  id: string;
  name: string;
  free: boolean;
  vision: boolean;
  tools: boolean;
  contextLength: number;
}

export interface Readiness {
  hostConnected: boolean;
  keyReady: boolean;
  reason?: string;
}

/** A stored userscript (R-09/R-10). */
export interface Userscript {
  id: string;
  name: string;
  /** Host globs the script is allowed to run on, e.g. "*://hyperagent.com/*". */
  matches: string[];
  code: string;
  updatedAt: number;
}

export interface UserscriptRunResult {
  scriptId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  console: Array<{ level: 'log' | 'warn' | 'error'; text: string; at: number }>;
  durationMs: number;
}

/** Side panel -> service worker. `type` on the wire is the key. */
export interface PanelToWorker {
  'run.start': { prompt: string; config: Config };
  'run.pause': { runId: RunId };
  'run.resume': { runId: RunId };
  'run.abort': { runId: RunId };
  'models.list': Record<string, never>;
  'readiness.get': Record<string, never>;
  'userscript.run': { scriptId: string; code?: string };
  'userscript.list': Record<string, never>;
  'userscript.save': Userscript;
  'userscript.delete': { id: string };
  'runlog.replay': { runId: RunId };
  /**
   * A panel-side diagnostic, relayed by the worker to the native host's ext.log
   * (docs/host-protocol.md). The panel has no native port of its own, and its errors
   * are otherwise only visible in a DevTools window nobody has open.
   */
  'log.append': { level: 'error' | 'warn' | 'info'; source: 'worker' | 'panel'; message: string; stack?: string; at: number };
}

/** Service worker -> side panel. `type` on the wire is the key. */
export interface WorkerToPanel {
  'run.event': { runId: RunId; event: RunEvent };
  'models.list': { models: ModelInfo[] } | { error: string };
  'readiness': Readiness;
  'userscript.result': UserscriptRunResult;
  'userscript.list': { scripts: Userscript[] };
  'runlog.replay': { runId: RunId; events: RunEvent[] };
  'error': { message: string; inReplyTo?: string };
}

export type PanelToWorkerMessage = { [K in keyof PanelToWorker]: { type: K; payload: PanelToWorker[K] } }[keyof PanelToWorker];
export type WorkerToPanelMessage = { [K in keyof WorkerToPanel]: { type: K; payload: WorkerToPanel[K] } }[keyof WorkerToPanel];
