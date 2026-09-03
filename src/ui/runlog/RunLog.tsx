import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { cn } from '../lib/cn';
import { entryKind, toEntries } from '../state/runlog';
import { LogEntryView } from './LogEntryView';

/** Filter chips, in the order the log tends to produce them. */
const FILTERS: ReadonlyArray<{ kind: RunEvent['kind']; label: string }> = [
  { kind: 'leader.plan', label: 'plans' },
  { kind: 'handoff', label: 'handoffs' },
  { kind: 'tool.call', label: 'tools' },
  { kind: 'follower.signal', label: 'signals' },
  { kind: 'model.text', label: 'text' },
  { kind: 'observation', label: 'observations' },
  { kind: 'input.fidelity', label: 'input' },
  { kind: 'userscript.output', label: 'userscripts' },
  { kind: 'step', label: 'steps' },
];

const LIFECYCLE: ReadonlyArray<RunEvent['kind']> = [
  'run.started',
  'run.paused',
  'run.resumed',
  'run.ended',
];

export function RunLog({ events, emptyMessage }: { events: RunEvent[]; emptyMessage: string }) {
  const [hidden, setHidden] = useState<ReadonlyArray<RunEvent['kind']>>([]);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => toEntries(events), [events]);
  const visible = useMemo(
    () =>
      entries.filter((entry) => {
        const kind = entryKind(entry);
        return LIFECYCLE.includes(kind) || !hidden.includes(kind);
      }),
    [entries, hidden],
  );

  useEffect(() => {
    if (!pinned) return;
    // `scrollIntoView` is missing in jsdom and in some embedded surfaces; pinning is a
    // convenience and must never take the log down.
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [pinned, visible.length]);

  const toggleFilter = (kind: RunEvent['kind']) =>
    setHidden((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );

  const copy = () => {
    const json = JSON.stringify(events, null, 2);
    void navigator.clipboard?.writeText(json).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-1.5">
        {FILTERS.map((filter) => {
          const on = !hidden.includes(filter.kind);
          return (
            <button
              key={filter.kind}
              type="button"
              aria-pressed={on}
              onClick={() => toggleFilter(filter.kind)}
              className={cn(
                'rounded border px-1.5 py-px text-[10px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
                on ? 'border-accent/40 bg-accent/12 text-accent' : 'border-line text-muted',
              )}
            >
              {filter.label}
            </button>
          );
        })}
        <span className="ml-auto flex items-center gap-1.5">
          <label htmlFor="runlog-pin" className="text-[10px] text-muted">
            pinned
          </label>
          <Toggle id="runlog-pin" label="Pin the log to the bottom" checked={pinned} onChange={setPinned} />
          <Button variant="ghost" onClick={copy} disabled={events.length === 0}>
            {copied ? 'copied' : 'copy JSON'}
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        {visible.length === 0 ? (
          <p className="px-1 text-[11px] text-muted">{emptyMessage}</p>
        ) : (
          <ol data-testid="run-log" className="space-y-1.5">
            {visible.map((entry) => (
              <LogEntryView key={entry.key} entry={entry} />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <p className="border-t border-line pt-1 text-[10px] text-muted">
        <Badge tone="neutral">{events.length} events</Badge>
        {hidden.length > 0 ? <span className="ml-1.5">{hidden.length} kind(s) hidden</span> : null}
      </p>
    </div>
  );
}
