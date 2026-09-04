import { Collapsible } from '../components/Collapsible';
import type { LogSection } from '../state/runlog';
import { roleLabel } from './format';
import { LogEntryView } from './LogEntryView';

/**
 * One `LogSection` (Requirement 4). Defaults open — grouping is scaffolding around
 * the turn-by-turn log, not a way to hide it, so nothing the user relied on to follow
 * a run disappears the first time they open the panel.
 */
export function StepSection({ section }: { section: LogSection }) {
  const body = (
    <ol className="space-y-1.5">
      {section.entries.map((entry) => (
        <LogEntryView key={entry.key} entry={entry} />
      ))}
    </ol>
  );

  // Section 0 is everything before the first step (the opening plan, an early
  // handoff) — too little to warrant its own disclosure chrome.
  if (section.n === 0) {
    return (
      <div data-testid="log-section" data-section={0}>
        {body}
      </div>
    );
  }

  return (
    <div data-testid="log-section" data-section={section.n} className="rounded-md border border-line/70">
      <Collapsible
        defaultOpen
        toggleTestId="step-toggle"
        summary={() => (
          <span className="flex flex-1 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
            <span>Step {section.n}</span>
            {section.role ? <span className="font-normal normal-case text-muted/80">· {roleLabel(section.role)}</span> : null}
            <span className="ml-auto font-normal normal-case text-muted/70">
              {section.entries.length} event{section.entries.length === 1 ? '' : 's'}
            </span>
          </span>
        )}
      >
        <div className="pt-1">{body}</div>
      </Collapsible>
    </div>
  );
}
