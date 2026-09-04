import type { ToolEntry } from '../state/runlog';
import { Badge } from '../components/Badge';
import { Collapsible } from '../components/Collapsible';
import { EventShell } from './EventShell';
import { formatDuration, prettyJson, roleLabel, summarizeArgs } from './format';

/**
 * A `tool.call` and its `tool.result` as one card (R-06). Collapsed it reads
 * name + ok/fail + duration; expanded it shows pretty-printed arguments and the
 * worker's summary.
 */
export function ToolCallCard({ entry }: { entry: ToolEntry }) {
  const call = entry.call;
  const result = entry.result;
  const at = call?.at ?? result?.at ?? 0;
  const role = call?.role ?? result?.role;
  const name = call?.call.name ?? result?.result.name ?? entry.callId;
  const pending = !result;
  const ok = result?.result.ok ?? false;
  const argsPreview = call ? summarizeArgs(call.call.args) : undefined;

  return (
    <EventShell at={at} rail={pending ? 'border-line' : ok ? 'border-emerald-500' : 'border-rose-500'}>
      <Collapsible
        className="rounded-md border border-line bg-paper"
        summary={() => (
          <span data-testid="tool-call-summary" className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm font-medium text-ink">{name}</span>
            {argsPreview ? (
              <span className="truncate font-mono text-[11px] text-muted">{argsPreview}</span>
            ) : null}
            {role ? <Badge tone={role}>{roleLabel(role)}</Badge> : null}
            {pending ? (
              <Badge tone="warn">running…</Badge>
            ) : (
              <Badge tone={ok ? 'good' : 'bad'}>{ok ? 'ok' : 'fail'}</Badge>
            )}
            {result ? (
              <span className="text-[11px] text-muted tabular-nums">
                {formatDuration(result.result.durationMs)}
              </span>
            ) : null}
          </span>
        )}
      >
        <div className="space-y-2 pt-1">
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Arguments</p>
            <pre
              data-testid="tool-call-args"
              className="mt-1 rounded bg-raised p-2 font-mono text-xs leading-snug text-ink"
            >
              {call ? prettyJson(call.call.args) : 'call not received'}
            </pre>
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Result</p>
            <p data-testid="tool-call-result" className="mt-1 text-sm break-words text-ink">
              {result ? result.result.summary : 'waiting for the tool to return…'}
            </p>
          </div>
          <p className="font-mono text-[11px] text-muted">callId {entry.callId}</p>
        </div>
      </Collapsible>
    </EventShell>
  );
}
