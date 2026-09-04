import type { RunEvent } from '@/src/messaging';
import { Badge, type BadgeTone } from '../components/Badge';
import { ExpandableText } from '../components/ExpandableText';
import { endedEvent, savedFilesFrom, startedEvent } from '../state/runlog';
import { formatDuration } from './format';

const STATUS_TONE: Record<Extract<RunEvent, { kind: 'run.ended' }>['status'], BadgeTone> = {
  done: 'good',
  aborted: 'warn',
  blocked: 'bad',
  'max-steps': 'warn',
  error: 'bad',
};

const STATUS_LABEL: Record<Extract<RunEvent, { kind: 'run.ended' }>['status'], string> = {
  done: 'Done',
  aborted: 'Aborted',
  blocked: 'Blocked',
  'max-steps': 'Max steps reached',
  error: 'Error',
};

/**
 * Requirement 3: a prominent card at the top of the log once a run ends — outcome,
 * the agent's summary, steps and elapsed time, and any files it saved. Nothing here
 * replaces the run's own `run.ended` line further down the log; this is the thing a
 * user glances at first.
 */
export function RunResultCard({ events }: { events: RunEvent[] }) {
  const ended = endedEvent(events);
  if (!ended) return null;

  const started = startedEvent(events);
  const elapsedMs = started ? ended.at - started.at : undefined;
  const files = savedFilesFrom(events);
  const tone = STATUS_TONE[ended.status];

  return (
    <div
      data-testid="run-result-card"
      className={`rounded-lg border px-3 py-2 ${
        tone === 'good'
          ? 'border-emerald-500/40 bg-emerald-500/8'
          : tone === 'warn'
            ? 'border-amber-500/40 bg-amber-500/8'
            : 'border-rose-500/40 bg-rose-500/8'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone}>{STATUS_LABEL[ended.status]}</Badge>
        <span className="text-xs text-muted tabular-nums">{ended.steps} steps</span>
        {elapsedMs !== undefined ? (
          <span className="text-xs text-muted tabular-nums">· {formatDuration(elapsedMs)}</span>
        ) : null}
      </div>

      {ended.message ? (
        <ExpandableText text={ended.message} className="mt-1.5 text-sm text-ink" testId="run-result-message" />
      ) : null}

      {files.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Saved files</p>
          <ul data-testid="run-result-files" className="mt-1 space-y-0.5">
            {files.map((file, index) => (
              <li key={`${index}-${file.name}`} className="font-mono text-xs text-ink">
                {file.url ? (
                  <a href={file.url} className="underline decoration-dotted underline-offset-2 hover:text-accent">
                    {file.name}
                  </a>
                ) : (
                  <span>{file.name}</span>
                )}
                {file.path ? <span className="ml-1 text-muted">{file.path}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
