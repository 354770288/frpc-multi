import { cn } from '../../lib/utils';

// dataviz meter 规范：填充色带严重度（primary→warning→destructive），
// 轨道用填充同色浅一档，让状态贯穿整条
const SEVERITY = [
  { min: 90, fill: 'bg-destructive', track: 'bg-destructive/15' },
  { min: 75, fill: 'bg-warning', track: 'bg-warning/20' },
  { min: 0, fill: 'bg-primary', track: 'bg-primary/15' },
] as const;

export function Meter({
  value,
  className,
  'aria-label': ariaLabel,
}: {
  /** 0–100 百分比；null 表示无数据，只渲染空轨道 */
  value: number | null;
  className?: string;
  'aria-label'?: string;
}) {
  const pct = value === null ? null : Math.min(100, Math.max(0, value));
  const severity = SEVERITY.find((s) => (pct ?? 0) >= s.min) ?? SEVERITY[2];
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-label={ariaLabel}
      className={cn(
        'h-1.5 overflow-hidden rounded-full',
        pct === null ? 'bg-muted' : severity.track,
        className
      )}
    >
      {pct !== null && (
        <div
          className={cn('h-full rounded-full', severity.fill)}
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      )}
    </div>
  );
}
