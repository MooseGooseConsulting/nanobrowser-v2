import type { RunEvent } from '@/src/messaging';
import { Badge } from '../components/Badge';
import { EventShell } from './EventShell';

/** `save_file` landed (R-07): shows the filename, byte count and where it went. */
export function FileSavedCard({ event }: { event: Extract<RunEvent, { kind: 'file.saved' }> }) {
  return (
    <EventShell at={event.at} rail="border-teal-500">
      <div className="py-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="good">Saved</Badge>
          <span className="font-mono text-xs text-ink">{event.filename}</span>
          <span className="text-[11px] text-muted tabular-nums">{event.bytes} bytes</span>
        </span>
        <p className="mt-1 truncate text-[10px] text-muted">{event.path}</p>
      </div>
    </EventShell>
  );
}
