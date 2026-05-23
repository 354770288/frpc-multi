import { useRef, useState, useEffect } from 'react';
import {
  AlertTriangle,
  Cpu,
  HardDrive,
  MemoryStick,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
  Square,
  Trash2
} from 'lucide-react';
import { MetricCard } from '../components/MetricCard';
import {
  bytesToHuman,
  instanceStateBadge,
  parsePercent,
  type InstanceTone
} from '../lib/format';
import type { Instance, Page, StatsMap, SystemInfo } from '../lib/types';

const TONE_DOT: Record<InstanceTone, string> = {
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  muted: 'bg-[var(--color-fg-subtle)]'
};

export function Overview({
  instances,
  stats,
  dockerAvailable,
  dockerError,
  system,
  pendingAction,
  onSelect,
  onPage,
  onAction,
  onDelete
}: {
  instances: Instance[];
  stats: StatsMap;
  dockerAvailable: boolean;
  dockerError: string;
  system: SystemInfo | null;
  pendingAction: Record<string, string>;
  onSelect: (name: string) => void;
  onPage: (page: Page) => void;
  onAction: (name: string, action: string) => void;
  onDelete: (name: string) => void;
}) {
  const [keyword, setKeyword] = useState('');

  let running = 0;
  let stopped = 0;
  let error = 0;
  let cpuTotal = 0;
  let memTotal = 0;
  let cpuSamples = 0;
  let memSamples = 0;
  for (const item of instances) {
    const stat = stats[item.name];
    const state = stat?.state || '';
    if (state === 'running') running += 1;
    else if ((state === 'exited' || state === 'dead') && stat?.exitCode && stat.exitCode !== 0)
      error += 1;
    else stopped += 1;
    if (stat?.cpuPercent) {
      cpuTotal += parsePercent(stat.cpuPercent);
      cpuSamples += 1;
    }
    if (stat?.memPercent) {
      memTotal += parsePercent(stat.memPercent);
      memSamples += 1;
    }
  }
  const total = instances.length;

  const lower = keyword.toLowerCase();
  const filtered = lower
    ? instances.filter(
        (item) =>
          item.name.toLowerCase().includes(lower) ||
          (item.displayName || '').toLowerCase().includes(lower)
      )
    : instances;

  const diskRatio =
    system && system.disk.total > 0 ? (system.disk.used / system.disk.total) * 100 : 0;

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          运行摘要
        </h2>
        {!dockerAvailable && dockerError && (
          <span className="text-[12px] text-[var(--color-warning)]">
            Docker：{dockerError}
          </span>
        )}
      </div>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <MetricCard
          icon={<Cpu size={14} />}
          title="CPU"
          value={cpuSamples ? `${cpuTotal.toFixed(1)}%` : '—'}
        />
        <MetricCard
          icon={<MemoryStick size={14} />}
          title="内存"
          value={memSamples ? `${memTotal.toFixed(1)}%` : '—'}
        />
        <MetricCard
          icon={<HardDrive size={14} />}
          title="磁盘"
          value={system ? `${diskRatio.toFixed(0)}%` : '—'}
          hint={
            system
              ? `${bytesToHuman(system.disk.used)} / ${bytesToHuman(system.disk.total)}`
              : undefined
          }
        />
      </section>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <MetricCard icon={<Server size={14} />} title="运行中" value={`${running}/${total}`} />
        <MetricCard
          icon={<AlertTriangle size={14} />}
          title="异常"
          value={`${error}/${total}`}
        />
        <MetricCard icon={<Square size={14} />} title="已停止" value={`${stopped}/${total}`} />
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-[13px] font-semibold text-[var(--color-fg)]">实例列表</h3>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-2 px-2.5 py-1.5 w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
              <Search size={13} className="text-[var(--color-fg-subtle)]" aria-hidden="true" />
              <input
                placeholder="搜索实例名"
                aria-label="搜索实例名"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
              />
            </div>
            <button
              onClick={() => onPage('create')}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
            >
              <Plus size={13} />
              创建实例
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <Th>实例名</Th>
                <Th>状态</Th>
                <Th align="right">CPU</Th>
                <Th align="right">内存</Th>
                <Th align="right">重启</Th>
                <Th>配置路径</Th>
                <Th align="right">操作</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const stat = stats[item.name];
                const badge = instanceStateBadge(stat, item.enabled);
                const pending = pendingAction[item.name];
                const isRunning = stat?.state === 'running';
                return (
                  <tr
                    key={item.name}
                    className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-muted)] transition-colors"
                  >
                    <Td>
                      <button
                        onClick={() => {
                          onSelect(item.name);
                          onPage('detail');
                        }}
                        className="rounded-sm text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-accent)] hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:underline focus-visible:text-[var(--color-accent)]"
                      >
                        {item.displayName || item.name}
                      </button>
                    </Td>
                    <Td>
                      <span
                        role="img"
                        aria-label={badge.label}
                        title={badge.label}
                        className={`inline-block w-2.5 h-2.5 rounded-full align-middle ${TONE_DOT[badge.tone]}`}
                      />
                    </Td>
                    <Td align="right" mono>
                      {stat?.cpuPercent || '—'}
                    </Td>
                    <Td align="right" mono>
                      {stat?.memUsage || '—'}
                    </Td>
                    <Td align="right" mono>
                      {stat ? stat.restartCount : '—'}
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                        {item.configPath}
                      </span>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        {isRunning ? (
                          <IconAction
                            onClick={() => onAction(item.name, 'stop')}
                            disabled={!!pending}
                            label="停止"
                            tone="default"
                          >
                            <Pause size={13} />
                          </IconAction>
                        ) : (
                          <IconAction
                            onClick={() => onAction(item.name, 'start')}
                            disabled={!!pending}
                            label="启动"
                            tone="primary"
                          >
                            <Play size={13} />
                          </IconAction>
                        )}
                        <IconAction
                          onClick={() => onAction(item.name, 'restart')}
                          disabled={!!pending}
                          label="重启"
                          tone="default"
                        >
                          <RotateCcw size={13} />
                        </IconAction>
                        <RowMenu
                          onLog={() => {
                            onSelect(item.name);
                            onPage('detail');
                          }}
                          onConfig={() => {
                            onSelect(item.name);
                            onPage('config');
                          }}
                          onDelete={() => onDelete(item.name)}
                          deleting={pending === 'delete'}
                        />
                      </div>
                    </Td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]"
                  >
                    没有匹配的实例
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Th({
  children,
  align = 'left'
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  mono = false
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
}) {
  return (
    <td
      className={`px-4 py-2.5 text-[13px] text-[var(--color-fg)] ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${mono ? 'font-mono tabular-nums text-[12px] text-[var(--color-fg-muted)]' : ''}`}
    >
      {children}
    </td>
  );
}

function IconAction({
  children,
  onClick,
  disabled,
  label,
  tone
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  tone: 'default' | 'primary';
}) {
  const base =
    'grid place-items-center w-7 h-7 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]';
  const toneCls =
    tone === 'primary'
      ? 'text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]'
      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`${base} ${toneCls}`}
    >
      {children}
    </button>
  );
}

function RowMenu({
  onLog,
  onConfig,
  onDelete,
  deleting
}: {
  onLog: () => void;
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

  function handleMenuKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!menuRef.current) return;
    const items = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1 + items.length) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

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
        className="grid place-items-center w-7 h-7 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="更多操作菜单"
          onKeyDown={handleMenuKey}
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="min-w-[140px] py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg z-50"
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onLog();
            }}
          >
            查看日志
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              onConfig();
            }}
          >
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
            {deleting ? '删除中…' : '删除实例'}
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
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] ${
        danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
  );
}
