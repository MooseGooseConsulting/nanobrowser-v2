import type { LogEntry } from '../state/runlog';
import { FileSavedCard } from './FileSavedCard';
import { HandoffCard } from './HandoffCard';
import { PlanCard } from './PlanCard';
import { ToolCallCard } from './ToolCallCard';
import {
  FollowerSignalEvent,
  InputFidelityEvent,
  ModelTextEvent,
  ObservationEvent,
  RunEndedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunStartedEvent,
  StepEvent,
  UserscriptOutputEvent,
} from './SimpleEvents';

/** One renderer per `RunEvent.kind` (R-07). Exhaustive by construction. */
export function LogEntryView({ entry }: { entry: LogEntry }) {
  if (entry.kind === 'tool') return <ToolCallCard entry={entry} />;

  const event = entry.event;
  switch (event.kind) {
    case 'run.started':
      return <RunStartedEvent event={event} />;
    case 'step':
      return <StepEvent event={event} />;
    case 'leader.plan':
      return <PlanCard event={event} />;
    case 'handoff':
      return <HandoffCard event={event} />;
    case 'follower.signal':
      return <FollowerSignalEvent event={event} />;
    case 'model.text':
      return <ModelTextEvent event={event} />;
    case 'observation':
      return <ObservationEvent event={event} />;
    case 'input.fidelity':
      return <InputFidelityEvent event={event} />;
    case 'userscript.output':
      return <UserscriptOutputEvent event={event} />;
    case 'file.saved':
      return <FileSavedCard event={event} />;
    case 'run.paused':
      return <RunPausedEvent event={event} />;
    case 'run.resumed':
      return <RunResumedEvent event={event} />;
    case 'run.ended':
      return <RunEndedEvent event={event} />;
  }
}
