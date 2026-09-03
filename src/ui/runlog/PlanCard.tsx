import type { RunEvent } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { EventShell } from './EventShell';

export type PlanEvent = Extract<RunEvent, { kind: 'leader.plan' }>;

/** The Leader's plan and its subgoal checklist (R-03/R-04). A replan is flagged. */
export function PlanCard({ event }: { event: PlanEvent }) {
  return (
    <EventShell at={event.at} rail="border-violet-500">
      <div data-testid="plan-card" className="rounded-md border border-violet-500/40 bg-violet-500/8 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Badge tone="leader">Leader</Badge>
          <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">
            {event.replan ? 'Replan' : 'Plan'}
          </span>
          {event.replan ? <Badge tone="warn">replan</Badge> : null}
        </div>
        <p className="mt-1 text-xs whitespace-pre-wrap text-ink">{event.plan}</p>
        {event.subgoals.length > 0 ? (
          <ol className="mt-1.5 space-y-0.5">
            {event.subgoals.map((subgoal, index) => (
              <li key={`${index}-${subgoal}`} className="flex gap-1.5 text-[11px] text-ink">
                <span aria-hidden className="text-muted">
                  &#9744;
                </span>
                <span className="min-w-0">{subgoal}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </EventShell>
  );
}
