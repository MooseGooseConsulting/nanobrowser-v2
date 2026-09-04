import type { Readiness } from '@/src/messaging';
import { Button } from '../components/Button';
import { readinessGate } from '../state/gate';
import { isWaiting, type AreaStatus } from '../state/status';

interface StatusItem {
  key: 'host' | 'key';
  label: string;
  ok: boolean;
  /** Shown only when `ok` is false — what the user does about it, not just that it's red. */
  fix: string;
}

/**
 * Validated readiness, not assumed readiness (R-11). A status list rather than one
 * dot: host and key are checked separately, and a red row always names the fix, not
 * just the failure, so the user is never left staring at a red light with no lever.
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

  const items: StatusItem[] = [
    {
      key: 'host',
      label: 'Native host',
      ok: readiness?.hostConnected ?? false,
      fix: readiness?.reason && !readiness.hostConnected
        ? readiness.reason
        : 'Start the native host, then Recheck.',
    },
    {
      key: 'key',
      label: 'Provider key',
      ok: readiness?.keyReady ?? false,
      fix: readiness?.reason && readiness.hostConnected && !readiness.keyReady
        ? readiness.reason
        : 'Add a provider key to the desktop secret store the host reads from, then Recheck.',
    },
  ];

  return (
    <div
      data-testid="readiness-row"
      data-ready={gate.ok ? 'true' : 'false'}
      className="rounded-md border border-line bg-surface px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          {gate.ok ? 'Ready to run' : pending ? 'Waiting for worker' : 'Not ready'}
        </p>
        <Button variant="ghost" onClick={onRefresh}>
          recheck
        </Button>
      </div>

      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-1.5 text-xs">
            <span
              aria-hidden
              className={`mt-1 size-2 shrink-0 rounded-full ${
                pending ? 'bg-amber-400' : item.ok ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            <span className="min-w-0">
              <span className="font-medium text-ink">{item.label}</span>
              <span className="text-muted"> — {pending ? 'waiting for the worker' : item.ok ? 'ready' : item.fix}</span>
            </span>
          </li>
        ))}
      </ul>

      {gate.reason ? (
        <p data-testid="readiness-reason" className="mt-1.5 text-xs text-muted">
          {gate.reason}
        </p>
      ) : null}
    </div>
  );
}
