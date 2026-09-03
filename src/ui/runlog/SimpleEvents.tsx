import type { RunEvent } from '@/src/messaging';
import { Badge, type BadgeTone } from '../components/Badge';
import { EventShell } from './EventShell';
import { roleLabel } from './format';

type Of<K extends RunEvent['kind']> = Extract<RunEvent, { kind: K }>;

export function StepEvent({ event }: { event: Of<'step'> }) {
  return (
    <EventShell at={event.at}>
      <p className="py-0.5 text-[11px] text-muted">
        Step <span className="font-medium text-ink tabular-nums">{event.n}</span> ·{' '}
        {roleLabel(event.role)}
      </p>
    </EventShell>
  );
}

export function ModelTextEvent({ event }: { event: Of<'model.text'> }) {
  return (
    <EventShell at={event.at} rail={event.role === 'leader' ? 'border-violet-400' : 'border-sky-400'}>
      <div className="py-0.5">
        <Badge tone={event.role}>{roleLabel(event.role)}</Badge>
        <p className="mt-1 text-xs whitespace-pre-wrap text-ink">{event.text}</p>
      </div>
    </EventShell>
  );
}

const SIGNAL_TONE: Record<Of<'follower.signal'>['signal'], BadgeTone> = {
  CONTINUE: 'neutral',
  SUBGOAL_COMPLETE: 'good',
  RETURN_TO_LEADER: 'accent',
  BLOCKED: 'bad',
};

export function FollowerSignalEvent({ event }: { event: Of<'follower.signal'> }) {
  return (
    <EventShell at={event.at} rail="border-sky-500">
      <div className="py-0.5">
        <span className="flex items-center gap-1.5">
          <Badge tone="follower">Follower</Badge>
          <Badge tone={SIGNAL_TONE[event.signal]}>{event.signal}</Badge>
        </span>
        {event.note ? <p className="mt-1 text-xs text-ink">{event.note}</p> : null}
      </div>
    </EventShell>
  );
}

export function ObservationEvent({ event }: { event: Of<'observation'> }) {
  return (
    <EventShell at={event.at}>
      <p className="flex flex-wrap items-center gap-1.5 py-0.5 text-[11px] text-muted">
        <Badge tone="neutral">observe: {event.mode}</Badge>
        {event.hasScreenshot ? <Badge tone="accent">screenshot</Badge> : null}
        {event.tokens !== undefined ? (
          <span className="tabular-nums">{event.tokens} tokens</span>
        ) : null}
      </p>
    </EventShell>
  );
}

export function InputFidelityEvent({ event }: { event: Of<'input.fidelity'> }) {
  const escalated = event.fidelity === 'escalated';
  return (
    <EventShell at={event.at} rail={escalated ? 'border-amber-500' : 'border-line'}>
      <p className="flex flex-wrap items-center gap-1.5 py-0.5 text-[11px] text-muted">
        <Badge tone={escalated ? 'warn' : 'neutral'}>input: {event.fidelity}</Badge>
        <span>
          {escalated
            ? event.attached
              ? 'debugger attached — Chrome is showing its banner'
              : 'debugger detached'
            : 'in-page events'}
        </span>
      </p>
    </EventShell>
  );
}

const CONSOLE_TONE: Record<Of<'userscript.output'>['level'], string> = {
  log: 'text-ink',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'text-rose-700 dark:text-rose-300',
};

export function UserscriptOutputEvent({ event }: { event: Of<'userscript.output'> }) {
  return (
    <EventShell at={event.at} rail="border-teal-500">
      <p className="py-0.5 font-mono text-[11px] break-words">
        <span className="text-muted">{event.scriptId}</span>{' '}
        <span className={CONSOLE_TONE[event.level]}>{event.text}</span>
      </p>
    </EventShell>
  );
}

export function RunStartedEvent({ event }: { event: Of<'run.started'> }) {
  return (
    <EventShell at={event.at} rail="border-accent">
      <div className="py-0.5">
        <p className="text-[10px] font-semibold tracking-wide text-muted uppercase">Run started</p>
        <p className="mt-0.5 text-xs text-ink">{event.prompt}</p>
        <p className="mt-1 flex flex-wrap gap-1">
          <Badge tone="leader">{event.config.leaderModel || 'no leader model'}</Badge>
          <Badge tone="follower">{event.config.followerModel || 'no follower model'}</Badge>
          <Badge tone="neutral">observe: {event.config.observe}</Badge>
          <Badge tone="neutral">every {event.config.planningInterval}</Badge>
          <Badge tone="neutral">max {event.config.maxSteps}</Badge>
        </p>
        <p className="mt-1 truncate text-[10px] text-muted">
          tab {event.tabId} · {event.url}
        </p>
      </div>
    </EventShell>
  );
}

export function RunPausedEvent({ event }: { event: Of<'run.paused'> }) {
  return (
    <EventShell at={event.at} rail="border-amber-500">
      <p className="py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">Paused</p>
    </EventShell>
  );
}

export function RunResumedEvent({ event }: { event: Of<'run.resumed'> }) {
  return (
    <EventShell at={event.at} rail="border-emerald-500">
      <p className="py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Resumed</p>
    </EventShell>
  );
}

const STATUS_TONE: Record<Of<'run.ended'>['status'], BadgeTone> = {
  done: 'good',
  aborted: 'warn',
  blocked: 'bad',
  'max-steps': 'warn',
  error: 'bad',
};

export function RunEndedEvent({ event }: { event: Of<'run.ended'> }) {
  const tone = STATUS_TONE[event.status];
  return (
    <EventShell
      at={event.at}
      rail={tone === 'good' ? 'border-emerald-500' : tone === 'warn' ? 'border-amber-500' : 'border-rose-500'}
    >
      <div data-testid="run-ended" className="py-0.5">
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">Run ended</span>
          <Badge tone={tone}>{event.status}</Badge>
          <span className="text-[10px] text-muted tabular-nums">{event.steps} steps</span>
        </span>
        {event.message ? <p className="mt-1 text-xs text-ink">{event.message}</p> : null}
      </div>
    </EventShell>
  );
}
