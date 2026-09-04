import { useState } from 'react';
import { cn } from '../lib/cn';

/**
 * Long free text (a model's reasoning, a run summary) collapsed behind "show more"
 * (Requirement 4). Short text renders with no control at all, so this never adds
 * chrome where it isn't needed.
 */
export function ExpandableText({
  text,
  limit = 240,
  className,
  testId,
}: {
  text: string;
  limit?: number;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const isLong = text.length > limit;
  const shown = open || !isLong ? text : `${text.slice(0, limit).trimEnd()}…`;

  return (
    <div className={className}>
      <p data-testid={testId} className="whitespace-pre-wrap">
        {shown}
      </p>
      {isLong ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'mt-0.5 rounded text-xs font-medium text-accent outline-none',
            'hover:underline focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          {open ? 'show less' : 'show more'}
        </button>
      ) : null}
    </div>
  );
}
