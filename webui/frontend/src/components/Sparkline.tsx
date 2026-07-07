import { cn } from '../lib/utils';

// ponytail: 纯 inline SVG 12 点趋势线，不引图表库；历史是内存态 ring buffer，
// 刷新页面清零——要持久趋势需后端历史接口，本轮不做
export function Sparkline({
  points,
  formatValue = (v) => `${v.toFixed(1)}%`,
  width = 64,
  height = 20,
  className,
}: {
  points: number[];
  formatValue?: (value: number) => string;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) return null;
  const pad = 3;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((v, i) => [
    pad + i * stepX,
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <svg
      width={width}
      height={height}
      className={cn('shrink-0 text-muted-foreground/50', className)}
      aria-hidden="true"
    >
      <polyline
        points={coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2.5} className="fill-primary" />
      {/* hover 命中列：原生 title tooltip，enhance 不 gate（当前值始终有文字在场） */}
      {coords.map(([x], i) => (
        <rect key={i} x={x - stepX / 2} y={0} width={stepX} height={height} fill="transparent">
          <title>{formatValue(points[i])}</title>
        </rect>
      ))}
    </svg>
  );
}
