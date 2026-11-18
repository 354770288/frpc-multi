import { useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { GroupColor, LabelCount, ProbeServer } from '../../lib/types';

export function labelVariant(label: string): 'destructive' | 'success' | 'muted' {
  switch (label) {
    case '非CN2': return 'destructive';
    case 'CN2': return 'success';
    case '未路由测试': return 'muted';
    default: return 'muted';
  }
}

export function isRouteLabel(label: string): boolean {
  return label === 'CN2' || label === '非CN2' || label === '未路由测试';
}

export function latestServerObservationTime(item: ProbeServer): string | null {
  const times = [item.latestRoute?.test_time, item.latestConnectivity?.testTime, item.latestSpeed?.testTime]
    .filter((value): value is string => !!value);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

export type GroupBadgeVariant = 'destructive' | 'warning' | 'info' | 'success' | 'muted';

export function groupVariant(color: GroupColor | undefined): GroupBadgeVariant {
  switch (color) {
    case 'red': return 'destructive';
    case 'yellow': return 'warning';
    case 'blue': return 'info';
    case 'green': return 'success';
    default: return 'muted';
  }
}

export const COLOR_LABELS: Record<string, string> = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };

export function GroupDotClass(color: GroupColor | undefined): string {
  const dot: Record<string, string> = {
    red: 'bg-destructive',
    yellow: 'bg-warning',
    blue: 'bg-blue-500',
    green: 'bg-primary',
  };
  return color ? dot[color] : 'bg-muted-foreground/40';
}

export function GroupDot({ color, className }: { color: GroupColor | undefined; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', GroupDotClass(color), className)} aria-hidden="true" />;
}

export function IndeterminateCheckbox({
  indeterminate,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate, props.checked]);
  return <input ref={ref} type="checkbox" {...props} />;
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return <th className={`whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}

export function ThSort({ label, sortKey, activeKey, asc, onSort }: {
  label: string;
  sortKey: string;
  activeKey: string;
  asc: boolean;
  onSort: (key: string) => void;
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ArrowUpDown : asc ? ArrowUp : ArrowDown;
  return (
    <th className="whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {label}
        <Icon size={11} className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  );
}

export function Td({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>;
}

export function LabelCloud({ labels, active, onToggle }: {
  labels: LabelCount[];
  active: string | null;
  onToggle: (label: string | null) => void;
}) {
  if (!labels.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
      {labels.map(({ label, count }) => (
        <button
          key={label}
          type="button"
          onClick={() => onToggle(active === label ? null : label)}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active === label
              ? 'bg-primary text-primary-foreground'
              : isRouteLabel(label)
                ? (label === 'CN2'
                    ? 'bg-primary/15 text-primary'
                    : label === '非CN2' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground')
                : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={active === label}
        >
          {label}<span className="ml-1 opacity-70">{count}</span>
        </button>
      ))}
      {active && (
        <button type="button" onClick={() => onToggle(null)}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
          清除标签筛选
        </button>
      )}
    </div>
  );
}
