import type { ReactNode } from 'react';

export function Field({
  label,
  hint,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[var(--color-fg-muted)]">{hint}</span>}
    </label>
  );
}
