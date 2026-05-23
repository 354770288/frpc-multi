export function MetricCard({
  icon,
  title,
  value,
  hint
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between text-[var(--color-fg-muted)]">
        <span className="text-[12px]">{title}</span>
        <span className="text-[var(--color-fg-subtle)]">{icon}</span>
      </div>
      <div className="text-[24px] font-semibold tracking-tight text-[var(--color-fg)] tabular-nums leading-none">
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--color-fg-subtle)]">{hint}</div>}
    </div>
  );
}
