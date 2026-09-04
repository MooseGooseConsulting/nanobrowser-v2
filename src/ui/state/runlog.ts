/**
 * Pure run-log state (R-07). The panel is a dumb renderer over this reducer:
 * every `run.event` and every `runlog.replay` batch goes through here, so the
 * ordering / de-duplication rules live in one tested place.
 */
import type { RunEvent, RunId } from '@/src/messaging';

/** A `tool.call` and its matching `tool.result`, paired by `callId` (R-06). */
export interface ToolEntry {
  kind: 'tool';
  key: string;
  callId: string;
  call?: Extract<RunEvent, { kind: 'tool.call' }>;
  result?: Extract<RunEvent, { kind: 'tool.result' }>;
}

export interface PlainEntry {
  kind: 'plain';
  key: string;
  event: Exclude<RunEvent, { kind: 'tool.call' } | { kind: 'tool.result' }>;
}

export type LogEntry = ToolEntry | PlainEntry;

export interface RunLogState {
  runId?: RunId;
  /** Arrival order, de-duplicated by {@link eventKey}. The single source of truth. */
  events: RunEvent[];
  /** Keys of everything in `events`, so a replay never double-appends. */
  keys: string[];
}

export const initialRunLogState: RunLogState = { events: [], keys: [] };

export type RunLogAction =
  | { type: 'event'; runId: RunId; event: RunEvent }
  | { type: 'replay'; runId: RunId; events: RunEvent[] }
  | { type: 'run'; runId: RunId }
  | { type: 'clear' };

/**
 * Identity of an event for de-duplication. Tool events key off `callId` because the
 * same call may arrive both live and in a replay with a re-stamped `at`; everything
 * else keys off its own content, which is stable across a replay.
 */
export function eventKey(event: RunEvent): string {
  if (event.kind === 'tool.call') return `tool.call:${event.call.callId}`;
  if (event.kind === 'tool.result') return `tool.result:${event.result.callId}`;
  return `${event.kind}:${event.at}:${JSON.stringify(event)}`;
}

function append(state: RunLogState, event: RunEvent): RunLogState {
  const key = eventKey(event);
  if (state.keys.includes(key)) return state;
  return { ...state, events: [...state.events, event], keys: [...state.keys, key] };
}

export function runLogReducer(state: RunLogState, action: RunLogAction): RunLogState {
  switch (action.type) {
    case 'clear':
      return initialRunLogState;

    case 'run':
      if (state.runId === action.runId) return state;
      return { runId: action.runId, events: [], keys: [] };

    case 'event': {
      if (state.runId !== undefined && state.runId !== action.runId) {
        // A different run took over: start clean rather than interleave two logs.
        return append({ runId: action.runId, events: [], keys: [] }, action.event);
      }
      return append(state.runId === action.runId ? state : { ...state, runId: action.runId }, action.event);
    }

    case 'replay': {
      if (state.runId !== undefined && state.runId !== action.runId) {
        return replayInto({ runId: action.runId, events: [], keys: [] }, action.events);
      }
      return replayInto({ ...state, runId: action.runId }, action.events);
    }
  }
}

/**
 * Merges a worker-side history under whatever the panel already holds. History wins
 * on ordering — it is the authoritative prefix — and anything the panel saw live but
 * the history does not contain (events newer than the replay snapshot) is kept after
 * it, in the order it arrived.
 */
function replayInto(state: RunLogState, history: RunEvent[]): RunLogState {
  const historyKeys = new Set<string>();
  const events: RunEvent[] = [];
  for (const event of history) {
    const key = eventKey(event);
    if (historyKeys.has(key)) continue;
    historyKeys.add(key);
    events.push(event);
  }
  state.events.forEach((event, index) => {
    const key = state.keys[index] ?? eventKey(event);
    if (historyKeys.has(key)) return;
    historyKeys.add(key);
    events.push(event);
  });
  return { runId: state.runId, events, keys: events.map(eventKey) };
}

/**
 * Folds the ordered event list into renderable entries, pairing `tool.call` with its
 * `tool.result`. A result whose call was never seen still gets its own entry so a
 * dropped call can never swallow the result.
 */
export function toEntries(events: RunEvent[]): LogEntry[] {
  const entries: LogEntry[] = [];
  const byCallId = new Map<string, ToolEntry>();

  for (const event of events) {
    if (event.kind === 'tool.call') {
      const existing = byCallId.get(event.call.callId);
      if (existing) {
        existing.call ??= event;
        continue;
      }
      const entry: ToolEntry = {
        kind: 'tool',
        key: `tool:${event.call.callId}`,
        callId: event.call.callId,
        call: event,
      };
      byCallId.set(event.call.callId, entry);
      entries.push(entry);
      continue;
    }

    if (event.kind === 'tool.result') {
      const existing = byCallId.get(event.result.callId);
      if (existing) {
        existing.result ??= event;
        continue;
      }
      const entry: ToolEntry = {
        kind: 'tool',
        key: `tool:${event.result.callId}`,
        callId: event.result.callId,
        result: event,
      };
      byCallId.set(event.result.callId, entry);
      entries.push(entry);
      continue;
    }

    entries.push({ kind: 'plain', key: eventKey(event), event });
  }

  return entries;
}

/** The kinds an entry answers to in the filter row. */
export function entryKind(entry: LogEntry): RunEvent['kind'] {
  if (entry.kind === 'tool') return 'tool.call';
  return entry.event.kind;
}

/** One `step` boundary's worth of entries (Requirement 4: collapsible per-step sections). */
export interface LogSection {
  key: string;
  /** 0 is everything before the first `step` event (the plan, the opening handoff). */
  n: number;
  role?: import('@/src/messaging').Role;
  entries: LogEntry[];
}

/**
 * Groups entries by the `step` events that already mark Follower turns (R-04). The
 * step entry itself stays out of the body — its number and role are what the section
 * header shows — so nothing is rendered twice. Every entry still ends up in exactly
 * one section, and the grouping never hides anything: it is scaffolding around the
 * turn-by-turn log, not a substitute for it.
 */
export function toSections(events: RunEvent[]): LogSection[] {
  const entries = toEntries(events);
  const sections: LogSection[] = [{ key: 'section-0', n: 0, entries: [] }];

  for (const entry of entries) {
    if (entry.kind === 'plain' && entry.event.kind === 'step') {
      sections.push({ key: `section-${entry.event.n}`, n: entry.event.n, role: entry.event.role, entries: [] });
      continue;
    }
    sections[sections.length - 1]!.entries.push(entry);
  }

  return sections.filter((section) => section.entries.length > 0);
}

/**
 * The subgoal the Follower is presumed to be working on right now, for the status
 * strip (Requirement 2). There is no explicit "current subgoal index" on the wire, so
 * this counts `SUBGOAL_COMPLETE` signals since the latest plan and reads that far into
 * the subgoal list — an approximation, but the Leader/Follower signal vocabulary (R-03)
 * makes subgoals complete in order, so it tracks the real run closely.
 */
export function currentSubgoal(events: RunEvent[]): string | undefined {
  let subgoals: string[] = [];
  let completed = 0;
  for (const event of events) {
    if (event.kind === 'leader.plan') {
      subgoals = event.subgoals;
      completed = 0;
    } else if (event.kind === 'follower.signal' && event.signal === 'SUBGOAL_COMPLETE') {
      completed += 1;
    }
  }
  if (subgoals.length === 0) return undefined;
  return subgoals[Math.min(completed, subgoals.length - 1)];
}

/** The most recent `step` event, for "step N of maxSteps" in the status strip. */
export function latestStep(events: RunEvent[]): Extract<RunEvent, { kind: 'step' }> | undefined {
  let found: Extract<RunEvent, { kind: 'step' }> | undefined;
  for (const event of events) if (event.kind === 'step') found = event;
  return found;
}

/** The run's own `run.started` event, so a status strip can use the run's *actual*
 * config (maxSteps included) rather than whatever the Setup tab currently shows. */
export function startedEvent(events: RunEvent[]): Extract<RunEvent, { kind: 'run.started' }> | undefined {
  return events.find((event): event is Extract<RunEvent, { kind: 'run.started' }> => event.kind === 'run.started');
}

/** The run's terminal event, if it has one yet. */
export function endedEvent(events: RunEvent[]): Extract<RunEvent, { kind: 'run.ended' }> | undefined {
  let found: Extract<RunEvent, { kind: 'run.ended' }> | undefined;
  for (const event of events) if (event.kind === 'run.ended') found = event;
  return found;
}

/** A saved file as the result card renders it, independent of who produced the event. */
export interface SavedFileInfo {
  name: string;
  path?: string;
  url?: string;
}

/**
 * TODO(file.saved): a concurrent change is expected to add a `file.saved` variant to
 * the `RunEvent` union (src/messaging/contract.ts) and a dedicated
 * src/ui/runlog/FileSavedCard.tsx. Until that lands there is no typed variant to match
 * on, so this reads the event generically (by its `kind` string and a best-effort
 * shape) rather than not showing saved files at all. Once the real variant exists,
 * replace this with a proper `Extract<RunEvent, { kind: 'file.saved' }>` match and
 * render saved files with `<FileSavedCard>` instead.
 */
export function savedFilesFrom(events: RunEvent[]): SavedFileInfo[] {
  const files: SavedFileInfo[] = [];
  for (const event of events) {
    const raw = event as unknown as Record<string, unknown>;
    if (raw.kind !== 'file.saved') continue;
    const file = raw.file as Record<string, unknown> | undefined;
    const name =
      (typeof file?.name === 'string' && file.name) ||
      (typeof raw.name === 'string' && raw.name) ||
      (typeof raw.path === 'string' && raw.path) ||
      'saved file';
    files.push({
      name,
      path: (typeof file?.path === 'string' && file.path) || (typeof raw.path === 'string' ? raw.path : undefined),
      url: (typeof file?.url === 'string' && file.url) || (typeof raw.url === 'string' ? raw.url : undefined),
    });
  }
  return files;
}

/** Status of the run as the panel understands it, used to enable Pause/Resume/Abort. */
export type RunPhase = 'idle' | 'running' | 'paused' | 'ended';

export function runPhase(state: RunLogState): RunPhase {
  if (state.runId === undefined) return 'idle';
  let phase: RunPhase = 'idle';
  for (const event of state.events) {
    if (event.kind === 'run.started') phase = 'running';
    else if (event.kind === 'run.paused') phase = 'paused';
    else if (event.kind === 'run.resumed') phase = 'running';
    else if (event.kind === 'run.ended') phase = 'ended';
  }
  // A runId with no run.started yet still means we asked for a run.
  return phase === 'idle' ? 'running' : phase;
}
