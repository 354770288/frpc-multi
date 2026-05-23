import type { ReactNode } from 'react';
import type { InstanceTone } from '../../lib/format';

const TONE_BADGE: Record<InstanceTone, string> = {
  success:
    'bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-inset ring-[var(--color-success)]/20',
  warning:
    'bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-inset ring-[var(--color-warning)]/20',
  danger:
    'bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-1 ring-inset ring-[var(--color-danger)]/20',
  muted:
    'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]'
};

const TONE_DOT: Record<InstanceTone, string> = {
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  muted: 'bg-[var(--color-fg-subtle)]'
};

export function Badge({
  tone,
  children,
  dot = false
}: {
  tone: InstanceTone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-[11px] font-medium ${TONE_BADGE[tone]}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]}`} />}
      {children}
    </span>
  );
}
