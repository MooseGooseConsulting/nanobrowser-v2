import { useEffect, useState } from 'react';
import type { ModelInfo, Readiness } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { findModel } from '../state/models';
import { runGate } from '../state/gate';
import { currentSubgoal, latestStep, runPhase, startedEvent, type RunLogState } from '../state/runlog';
import type { AreaStatus } from '../state/status';
import { RunLog } from '../runlog/RunLog';
import { RunResultCard } from '../runlog/RunResultCard';

const STATE_LABEL: Record<'running' | 'paused' | 'aborting', string> = {
  running: 'Running',
  paused: 'Paused',
  aborting: 'Aborting…',
};

/**
 * Prompt, transport controls and the live run log (R-06/R-07). Run stays disabled until
 * readiness is green and the config is complete, and says why — with a fix action —
 * when it is not.
 */
export function RunSection({
  config,
  models = [],
  readiness,
  readinessStatus,
  log,
  starting = false,
  onStart,
  onPause,
  onResume,
  onAbort,
  onGoToSetup,
}: {
  config: Config;
  models?: ModelInfo[];
  readiness?: Readiness;
  readinessStatus: AreaStatus;
  log: RunLogState;
  /** Set while `run.start` has been sent but the worker has not answered with an event. */
  starting?: boolean;
  onStart: (prompt: string) => void;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  /** Jumps the panel to the Setup tab — the "change" link and the gate notice's fix action. */
  onGoToSetup?: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [aborting, setAborting] = useState(false);
  const gate = runGate(readiness, readinessStatus, config);
  const phase = runPhase(log);
  const active = starting || phase === 'running' || phase === 'paused';
  const canStart = gate.ok && prompt.trim().length > 0 && !active;

  // The worker has no "aborting" state of its own — abort just ends the run, eventually,
  // with run.ended{status:'aborted'} — so this is purely the panel's own transient flag
  // between the click and that event, cleared the moment a new/ended run supersedes it.
  useEffect(() => {
    if (phase !== 'running' && phase !== 'paused') setAborting(false);
  }, [phase, log.runId]);

  const submit = () => {
    if (!canStart) return;
    onStart(prompt.trim());
  };

  const leaderName = findModel(models, config.leaderModel)?.name || config.leaderModel;
  const followerName = findModel(models, config.followerModel)?.name || config.followerModel;

  const started = startedEvent(log.events);
  const step = latestStep(log.events);
  const maxSteps = started?.config.maxSteps ?? config.maxSteps;
  const subgoal = currentSubgoal(log.events);
  const stateLabel = aborting ? STATE_LABEL.aborting : phase === 'paused' ? STATE_LABEL.paused : STATE_LABEL.running;

  // Pause and Resume are never both applicable at once, so they are one control whose
  // label/handler track phase rather than two buttons toggled by visibility.
  const showTransport = active && !aborting;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="space-y-1.5">
        <label htmlFor="run-prompt" className="sr-only">
          Objective
        </label>
        <textarea
          id="run-prompt"
          rows={3}
          value={prompt}
          placeholder="What should the agent do on this tab?"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Plain Enter sends, Shift+Enter inserts a newline — the convention every
            // chat UI uses. Ctrl/Cmd+Enter still works too: it's harmless and some
            // users have the habit from before this changed.
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          className="w-full resize-y rounded-md border border-line bg-paper px-2.5 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone="leader">{leaderName || 'no leader model'}</Badge>
            <Badge tone="follower">{followerName || 'no follower model'}</Badge>
            {/* Hidden once the blocked-reason bar is showing its own "Fix in Setup" —
               same destination, so both at once would be a literal duplicate CTA. */}
            {onGoToSetup && gate.ok ? (
              <button
                type="button"
                onClick={onGoToSetup}
                className="rounded text-xs text-accent underline decoration-dotted underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-accent"
              >
                change
              </button>
            ) : null}
          </p>
          <Button
            variant="primary"
            disabled={!canStart}
            onClick={submit}
            title="Enter also submits · Shift+Enter for a new line"
          >
            {starting && !log.runId ? 'Starting…' : 'Run'}
          </Button>
        </div>
      </div>

      {!gate.ok ? (
        <div
          data-testid="run-blocked-reason"
          role="status"
          className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <span>{gate.reason}</span>
          {onGoToSetup ? (
            <button
              type="button"
              onClick={onGoToSetup}
              className="shrink-0 rounded font-medium underline decoration-dotted underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-accent"
            >
              Fix in Setup
            </button>
          ) : null}
        </div>
      ) : null}

      {active ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5"
        >
          <p className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-ink">{stateLabel}</span>
            {step ? (
              <span className="text-muted tabular-nums">
                · step {step.n} of {maxSteps}
              </span>
            ) : null}
          </p>
          {subgoal ? <p className="truncate text-[11px] text-muted">{subgoal}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {showTransport ? (
          <Button onClick={phase === 'paused' ? onResume : onPause}>
            {phase === 'paused' ? 'Resume' : 'Pause'}
          </Button>
        ) : null}
        {showTransport ? (
          <Button
            variant="danger"
            onClick={() => {
              setAborting(true);
              onAbort();
            }}
          >
            Abort
          </Button>
        ) : null}
      </div>

      <RunResultCard events={log.events} />

      <RunLog
        events={log.events}
        emptyMessage={
          log.runId
            ? 'Connected to a run; waiting for the worker to send its log.'
            : 'No run yet. The log fills in as the Leader and Follower move.'
        }
      />
    </div>
  );
}
