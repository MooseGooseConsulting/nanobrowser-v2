import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { cn } from '../lib/cn';
import { entryKind, startedEvent, toEntries, toSections } from '../state/runlog';
import { LogEntryView } from './LogEntryView';
import { RunStartContext } from './runStart';
import { StepSection } from './StepSection';

/** Filter kinds, in the order the log tends to produce them. Requirement 4: kept, in
 * a compact "Show" menu rather than nine always-visible chips. */
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

function ShowMenu({
  hidden,
  onToggle,
}: {
  hidden: ReadonlyArray<RunEvent['kind']>;
  onToggle: (kind: RunEvent['kind']) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = FILTERS.length - hidden.length;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted',
          'outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        Show
        {shown < FILTERS.length ? <span className="tabular-nums">({shown}/{FILTERS.length})</span> : null}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Which event kinds to show"
          className="absolute z-20 mt-1 w-44 space-y-0.5 rounded-md border border-line bg-paper p-1 shadow-lg"
        >
          {FILTERS.map((filter) => (
            <label
              key={filter.kind}
              className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs text-ink hover:bg-raised"
            >
              <input
                type="checkbox"
                checked={!hidden.includes(filter.kind)}
                onChange={() => onToggle(filter.kind)}
                className="accent-accent"
              />
              {filter.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RunLog({ events, emptyMessage }: { events: RunEvent[]; emptyMessage: string }) {
  const [hidden, setHidden] = useState<ReadonlyArray<RunEvent['kind']>>([]);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const runStart = startedEvent(events)?.at;
  const stepsHidden = hidden.includes('step');

  const visibleFlat = useMemo(() => {
    const entries = toEntries(events);
    return entries.filter((entry) => {
      const kind = entryKind(entry);
      return LIFECYCLE.includes(kind) || !hidden.includes(kind);
    });
  }, [events, hidden]);

  const visibleSections = useMemo(() => {
    if (stepsHidden) return [];
    return toSections(events)
      .map((section) => ({
        ...section,
        entries: section.entries.filter((entry) => {
          const kind = entryKind(entry);
          return LIFECYCLE.includes(kind) || !hidden.includes(kind);
        }),
      }))
      .filter((section) => section.entries.length > 0);
  }, [events, hidden, stepsHidden]);

  const totalVisible = visibleFlat.length;

  useEffect(() => {
    if (!pinned) return;
    // `scrollIntoView` is missing in jsdom and in some embedded surfaces; pinning is a
    // convenience and must never take the log down.
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [pinned, totalVisible]);

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
    <RunStartContext.Provider value={runStart}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-1.5">
          <ShowMenu hidden={hidden} onToggle={toggleFilter} />
          <span className="ml-auto flex items-center gap-1.5">
            <label htmlFor="runlog-pin" className="text-[11px] text-muted">
              pinned
            </label>
            <Toggle id="runlog-pin" label="Pin the log to the bottom" checked={pinned} onChange={setPinned} />
            <Button variant="ghost" onClick={copy} disabled={events.length === 0}>
              {copied ? 'copied' : 'copy JSON'}
            </Button>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pt-2">
          {totalVisible === 0 ? (
            <p className="px-1 text-xs text-muted">{emptyMessage}</p>
          ) : stepsHidden ? (
            <ol data-testid="run-log" className="space-y-1.5">
              {visibleFlat.map((entry) => (
                <LogEntryView key={entry.key} entry={entry} />
              ))}
            </ol>
          ) : (
            <div data-testid="run-log" className="space-y-2">
              {visibleSections.map((section) => (
                <StepSection key={section.key} section={section} />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <p className="border-t border-line pt-1 text-[11px] text-muted">
          <Badge tone="neutral">{events.length} events</Badge>
          {hidden.length > 0 ? <span className="ml-1.5">{hidden.length} kind(s) hidden</span> : null}
        </p>
      </div>
    </RunStartContext.Provider>
  );
}
