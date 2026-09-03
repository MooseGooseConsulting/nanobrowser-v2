import type { Readiness } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { readinessGate } from '../state/gate';
import { isWaiting, type AreaStatus } from '../state/status';

/**
 * Validated readiness, not assumed readiness (R-11). Green only when the worker says
 * both the host and the key are good; otherwise the specific reason is on screen.
 */
export function ReadinessRow({
  readiness,
  status,
  onRefresh,
}: {
  readiness?: Readiness;
  status: AreaStatus;
  onRefresh: () => void;
}) {
  const gate = readinessGate(readiness, status);
  const pending = isWaiting(status) && !readiness;

  return (
    <div
      data-testid="readiness-row"
      data-ready={gate.ok ? 'true' : 'false'}
      className="rounded-md border border-line bg-surface px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`size-2 rounded-full ${
            gate.ok ? 'bg-emerald-500' : pending ? 'bg-amber-400' : 'bg-rose-500'
          }`}
        />
        <span className="text-xs font-medium text-ink">
          {gate.ok ? 'Ready' : pending ? 'Waiting for worker' : 'Not ready'}
        </span>
        <Badge tone={readiness?.hostConnected ? 'good' : 'neutral'}>
          host {readiness?.hostConnected ? 'connected' : 'unknown'}
        </Badge>
        <Badge tone={readiness?.keyReady ? 'good' : 'neutral'}>
          key {readiness?.keyReady ? 'ready' : 'unknown'}
        </Badge>
        <Button variant="ghost" className="ml-auto" onClick={onRefresh}>
          recheck
        </Button>
      </div>
      {gate.reason ? (
        <p data-testid="readiness-reason" className="mt-1 text-[11px] text-muted">
          {gate.reason}
        </p>
      ) : null}
    </div>
  );
}
