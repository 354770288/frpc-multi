import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, FileCode2, MoreHorizontal, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import type { InstanceTone } from '../../lib/format';

const TONE_STYLES: Record<InstanceTone, string> = {
  success: 'bg-primary/10 text-primary',
  warning: 'bg-secondary text-secondary-foreground',
  danger: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground'
};

const TONE_DOT: Record<InstanceTone, string> = {
  success: 'bg-primary',
  warning: 'bg-secondary-foreground',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground/60'
};

type MetricTone = 'online' | 'running' | 'scope' | 'issue' | 'quiet';

type SummaryMetricItem = {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: MetricTone;
  mono?: boolean;
};

const SUMMARY_STYLES: Record<MetricTone, { icon: string; value: string }> = {
  online: {
    icon: 'bg-primary/10 text-primary ring-primary/15',
    value: 'text-foreground'
  },
  running: {
    icon: 'bg-chart-1/20 text-chart-4 ring-chart-3/15',
    value: 'text-foreground'
  },
  scope: {
    icon: 'bg-secondary text-secondary-foreground ring-border',
    value: 'text-foreground'
  },
  issue: {
    icon: 'bg-destructive/10 text-destructive ring-destructive/10',
    value: 'text-destructive'
  },
  quiet: {
    icon: 'bg-muted text-muted-foreground ring-border',
    value: 'text-foreground'
  }
};

export function SummaryCard({
  scopeLabel,
  items
}: {
  scopeLabel: string;
  items: SummaryMetricItem[];
}) {
  return (
    <Card
      size="sm"
      className="mb-4 gap-0 overflow-hidden rounded-lg border border-border bg-card py-0 shadow-sm ring-0"
    >
      <CardHeader className="flex flex-col gap-1 rounded-t-none border-b border-border/70 bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold leading-5 text-foreground">
            工作台概览
          </CardTitle>
          <CardDescription className="truncate text-[11px] leading-4 text-muted-foreground">
            当前范围：{scopeLabel}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item) => (
            <SummaryMetricCell key={item.label} item={item} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryMetricCell({ item }: { item: SummaryMetricItem }) {
  const Icon = item.icon;
  const styles = SUMMARY_STYLES[item.tone];
  return (
    <div className="min-h-[76px] bg-card px-4 py-3">
      <div className="flex h-full items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium leading-4 text-muted-foreground">{item.label}</div>
          <div
            className={cn(
              'mt-1 truncate font-semibold leading-7 tracking-normal',
              item.mono === false ? 'text-[17px]' : 'font-mono text-[20px] tabular-nums',
              styles.value
            )}
          >
            {item.value}
          </div>
        </div>
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-md ring-1', styles.icon)}>
          <Icon aria-hidden="true" size={15} />
        </span>
      </div>
    </div>
  );
}

export function PanelHead({
  title,
  badge,
  description
}: {
  title: string;
  description?: string;
  badge: string;
}) {
  const bg = 'bg-muted';
  return (
    <div className={`min-h-[58px] border-b border-border px-3.5 py-3 flex items-start justify-between gap-3 ${bg}`}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-[11px] text-muted-foreground">{description}</p>}
      </div>
      <span className="inline-flex h-6 max-w-[45%] shrink-0 items-center overflow-hidden rounded-full bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground whitespace-nowrap">
        <span className="min-w-0 truncate">{badge}</span>
      </span>
    </div>
  );
}

export function NodeCard({
  active,
  offline,
  name,
  uuid,
  statusLabel,
  statusTone,
  total,
  running,
  error,
  onClick
}: {
  active: boolean;
  offline?: boolean;
  name: string;
  uuid: string;
  statusLabel?: string;
  statusTone?: 'green' | 'red' | 'gray';
  total: number;
  running: number;
  error: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-foreground/20 bg-card shadow-[inset_4px_0_0_var(--primary)]'
          : offline
            ? 'border-border bg-muted/60 hover:bg-muted'
            : 'border-border bg-card hover:bg-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-foreground">{name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {uuid}
          </div>
        </div>
        {statusLabel && statusTone && <NodeStatus tone={statusTone}>{statusLabel}</NodeStatus>}
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <NodeStat label="实例" value={total} />
        <NodeStat label="运行" value={running} />
        <NodeStat label="异常" value={error} />
      </div>
    </button>
  );
}

function NodeStatus({ children, tone }: { children: ReactNode; tone: 'green' | 'red' | 'gray' }) {
  const toneClass =
    tone === 'green'
      ? 'text-primary'
      : tone === 'red'
        ? 'text-destructive'
        : 'text-muted-foreground';
  const dotClass =
    tone === 'green'
      ? 'bg-primary'
      : tone === 'red'
        ? 'bg-destructive'
        : 'bg-muted-foreground/60';
  return (
    <span className={`inline-flex h-5 max-w-[96px] shrink-0 items-center gap-1.5 overflow-hidden text-[11px] font-bold whitespace-nowrap ${toneClass}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function NodeStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] font-semibold text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function ContextCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-[12px] font-semibold text-foreground ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  text,
  actions
}: {
  title: string;
  text?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-input bg-muted p-6 text-center">
      <div className="text-[13px] font-semibold text-foreground">{title}</div>
      {text && (
        <p className="mx-auto mt-1.5 max-w-[360px] text-[12px] leading-5 text-muted-foreground">
          {text}
        </p>
      )}
      {actions && <div className="mt-3 flex justify-center">{actions}</div>}
    </div>
  );
}

export function Select({
  children,
  label,
  value,
  onChange
}: {
  children: ReactNode;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      className="h-8 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
    >
      {children}
    </select>
  );
}

export function StatusTab({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-8 max-w-full shrink-0 overflow-hidden rounded-t-lg border border-b-0 px-3 text-[12px] whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-border bg-primary/10 font-semibold text-primary'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="block min-w-0 truncate">{children}</span>
    </button>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone: InstanceTone }) {
  return (
    <span className={`inline-flex h-6 max-w-full items-center gap-1.5 overflow-hidden rounded-full px-2 text-[11px] font-bold whitespace-nowrap ${TONE_STYLES[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function Th({
  children,
  align = 'left'
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-[11px] font-bold text-muted-foreground ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  mono = false
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 text-[13px] text-foreground ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${mono ? 'whitespace-nowrap font-mono tabular-nums text-[12px] text-muted-foreground' : ''}`}
    >
      {children}
    </td>
  );
}

export function IconAction({
  children,
  onClick,
  disabled,
  label,
  primary
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        primary
          ? 'bg-primary/10 text-primary hover:bg-muted'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function RowMenu({
  onOpen,
  onConfig,
  onDelete,
  deleting
}: {
  onOpen: () => void;
  onConfig: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    function handleScroll() {
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !menuRef.current) return;
    const first = menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right
      });
    }
    setOpen(true);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="更多操作菜单"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-50 min-w-[142px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg"
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onOpen();
            }}
          >
            <ArrowRight size={12} />
            进入
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              onConfig();
            }}
          >
            <FileCode2 size={12} />
            编辑配置
          </MenuItem>
          <div className="my-1 border-t border-border" />
          <MenuItem
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            danger
          >
            <Trash2 size={12} />
            {deleting ? '删除中...' : '删除实例'}
          </MenuItem>
        </div>
      )}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  danger
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none ${
        danger ? 'text-destructive' : 'text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
