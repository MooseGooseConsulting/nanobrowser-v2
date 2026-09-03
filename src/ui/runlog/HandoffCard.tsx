import type { RunEvent } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { EventShell } from './EventShell';
import { roleLabel } from './format';

export type HandoffEvent = Extract<RunEvent, { kind: 'handoff' }>;

/**
 * Control moving between Leader and Follower (R-07). This is the one thing in the log
 * that must never be mistaken for an ordinary step, so it gets a filled banner, both
 * role badges and an explicit arrow rather than a line of text.
 */
export function HandoffCard({ event }: { event: HandoffEvent }) {
  return (
    <EventShell at={event.at} rail="border-amber-500">
      <div
        data-testid="handoff-card"
        className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300">
            Handoff
          </span>
          <Badge tone={event.from}>{roleLabel(event.from)}</Badge>
          <span aria-label="hands control to" className="text-amber-700 dark:text-amber-300">
            &#8594;
          </span>
          <Badge tone={event.to}>{roleLabel(event.to)}</Badge>
          {event.signal ? (
            <Badge tone={event.signal === 'BLOCKED' ? 'bad' : 'accent'}>{event.signal}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-ink">{event.reason}</p>
      </div>
    </EventShell>
  );
}
