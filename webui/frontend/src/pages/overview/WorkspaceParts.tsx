import type { ReactNode } from 'react';
import { ArrowRight, FileCode2, MoreHorizontal, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import {
  Select as UiSelect,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Switch as UiSwitch } from '../../components/ui/switch';
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
        <div className="grid grid-cols-1 gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
  // ponytail: 整卡可点的复合布局，shadcn 无对应原语（Button 强制单行居中），保留原生 button
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
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <UiSelect value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </UiSelect>
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
    <Button
      variant={primary ? 'secondary' : 'ghost'}
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
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
    <UiSwitch
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      title={label}
    />
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="更多操作" aria-label="更多操作">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onOpen}>
            <ArrowRight />
            进入
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onConfig}>
            <FileCode2 />
            编辑配置
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 />
            {deleting ? '删除中...' : '删除实例'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
