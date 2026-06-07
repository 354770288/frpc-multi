import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, FileCode2, MoreHorizontal, Trash2 } from 'lucide-react';
import type { InstanceTone } from '../../lib/format';

const TONE_STYLES: Record<InstanceTone, string> = {
  success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
  warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  muted: 'bg-slate-100 text-[var(--color-fg-muted)]'
};

const TONE_DOT: Record<InstanceTone, string> = {
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  muted: 'bg-[var(--color-fg-subtle)]'
};

export function Metric({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: 'blue' | 'green' | 'orange' | 'red';
}) {
  const toneClass =
    tone === 'green'
      ? 'before:bg-[var(--color-success)] bg-[var(--color-success-soft)]'
      : tone === 'orange'
        ? 'before:bg-[var(--color-warning)] bg-orange-50'
        : tone === 'red'
          ? 'before:bg-[var(--color-danger)] bg-[var(--color-danger-soft)]'
          : 'before:bg-[var(--color-accent)] bg-white';
  return (
    <div className={`relative overflow-hidden rounded-lg border border-[var(--color-border)] p-3 shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-1 ${toneClass}`}>
      <div className="text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 font-mono text-[18px] font-semibold text-[var(--color-fg)] tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function PanelHead({
  label,
  labelClass,
  title,
  description,
  badge,
  tone
}: {
  label: string;
  labelClass: string;
  title: string;
  description: string;
  badge: string;
  tone: 'blue' | 'violet';
}) {
  const bg =
    tone === 'violet'
      ? 'bg-gradient-to-r from-violet-50 to-white'
      : 'bg-gradient-to-r from-blue-50 to-white';
  return (
    <div className={`min-h-[70px] border-b border-[var(--color-border)] px-3.5 py-3 flex items-start justify-between gap-3 ${bg}`}>
      <div>
        <div className={`mb-1.5 inline-flex h-5 items-center rounded-full px-2 text-[11px] font-bold ${labelClass}`}>
          {label}
        </div>
        <h2 className="text-[14px] font-semibold text-[var(--color-fg)]">{title}</h2>
        <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{description}</p>
      </div>
      <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-[var(--color-border)] bg-white px-2.5 text-[11px] text-[var(--color-fg-muted)]">
        {badge}
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
  statusLabel: string;
  statusTone: 'green' | 'red' | 'gray';
  total: number;
  running: number;
  error: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'border-violet-300 bg-violet-50 shadow-[inset_4px_0_0_#6d5bd0]'
          : offline
            ? 'border-red-100 bg-red-50/40 shadow-[inset_4px_0_0_var(--color-danger)]'
            : 'border-[var(--color-border)] bg-white hover:bg-[var(--color-surface-muted)]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
            {uuid}
          </div>
        </div>
        <NodeStatus tone={statusTone}>{statusLabel}</NodeStatus>
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
      ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
      : tone === 'red'
        ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
        : 'bg-slate-100 text-[var(--color-fg-muted)]';
  const dotClass =
    tone === 'green'
      ? 'bg-[var(--color-success)]'
      : tone === 'red'
        ? 'bg-[var(--color-danger)]'
        : 'bg-[var(--color-fg-subtle)]';
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-bold ${toneClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {children}
    </span>
  );
}

function NodeStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[var(--color-surface-muted)] p-2">
      <div className="text-[10px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] font-semibold text-[var(--color-fg)] tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function ContextCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-white p-2">
      <div className="text-[10px] text-[var(--color-fg-muted)]">{label}</div>
      <div className={`mt-1 truncate text-[12px] font-semibold text-[var(--color-fg)] ${mono ? 'font-mono tabular-nums' : ''}`}>
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
  text: string;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] p-6 text-center">
      <div className="text-[13px] font-semibold text-[var(--color-fg)]">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[360px] text-[12px] leading-5 text-[var(--color-fg-muted)]">
        {text}
      </p>
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
      className="h-8 rounded-lg border border-[var(--color-border)] bg-white px-2.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
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
      className={`h-8 rounded-t-lg border border-b-0 px-3 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'border-blue-200 bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone: InstanceTone }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] font-bold ${TONE_STYLES[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
      {children}
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
      className={`px-3 py-2 text-[11px] font-bold text-[var(--color-fg-muted)] ${
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
      className={`px-3 py-2 text-[13px] text-[var(--color-fg)] ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${mono ? 'font-mono tabular-nums text-[12px] text-[var(--color-fg-muted)]' : ''}`}
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
      className={`grid h-7 w-7 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        primary
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-blue-100'
          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
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
      className={`relative inline-flex h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
        checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-strong)]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
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
        className="grid h-7 w-7 place-items-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="更多操作菜单"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-50 min-w-[142px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-white py-1 shadow-lg"
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
          <div className="my-1 border-t border-[var(--color-border)]" />
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
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-muted)] focus-visible:bg-[var(--color-surface-muted)] focus-visible:outline-none ${
        danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
  );
}
