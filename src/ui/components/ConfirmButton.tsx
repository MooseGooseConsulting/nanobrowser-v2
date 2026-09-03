import { useState } from 'react';
import { Button } from './Button';

/**
 * Inline two-step confirm. `window.confirm` is blocking and unstyled and does not exist
 * in every extension surface, so destructive actions arm in place instead.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Sure?',
  onConfirm,
  className,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <Button variant="ghost" className={className} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span className={className}>
      <Button
        variant="danger"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}
