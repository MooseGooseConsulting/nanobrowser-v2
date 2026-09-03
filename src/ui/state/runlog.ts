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
