import { useState } from 'react';
import type { Readiness } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { Button } from '../components/Button';
import { RunLog } from '../runlog/RunLog';
import { runGate } from '../state/gate';
import { runPhase, type RunLogState } from '../state/runlog';
import type { AreaStatus } from '../state/status';

/**
 * Prompt, transport controls and the live run log (R-06/R-07). Run stays disabled until
 * readiness is green and the config is complete, and says why when it is not.
 */
export function RunSection({
  config,
  readiness,
  readinessStatus,
  log,
  onStart,
  onPause,
  onResume,
  onAbort,
}: {
  config: Config;
  readiness?: Readiness;
  readinessStatus: AreaStatus;
  log: RunLogState;
  onStart: (prompt: string) => void;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const gate = runGate(readiness, readinessStatus, config);
  const phase = runPhase(log);
  const active = phase === 'running' || phase === 'paused';
  const canStart = gate.ok && prompt.trim().length > 0 && !active;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div>
        <label htmlFor="run-prompt" className="sr-only">
          Objective
        </label>
        <textarea
          id="run-prompt"
          rows={3}
          value={prompt}
          placeholder="What should the agent do on this tab?"
          onChange={(event) => setPrompt(event.target.value)}
          className="w-full resize-y rounded-md border border-line bg-paper px-2 py-1.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" disabled={!canStart} onClick={() => onStart(prompt.trim())}>
          Run
        </Button>
        <Button disabled={phase !== 'running'} onClick={onPause}>
          Pause
        </Button>
        <Button disabled={phase !== 'paused'} onClick={onResume}>
          Resume
        </Button>
        <Button variant="danger" disabled={!active} onClick={onAbort}>
          Abort
        </Button>
      </div>

      {!gate.ok ? (
        <p data-testid="run-blocked-reason" role="status" className="text-[11px] text-amber-700 dark:text-amber-300">
          {gate.reason}
        </p>
      ) : null}

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
