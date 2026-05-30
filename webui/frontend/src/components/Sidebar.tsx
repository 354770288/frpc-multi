import { Boxes, ClipboardList, FileCode2, Home, Network, Plus, Settings } from 'lucide-react';
import type { ConsoleInfo, Page } from '../lib/types';

export function Sidebar({
  page,
  onPage,
  system,
  collapsed
}: {
  page: Page;
  onPage: (page: Page) => void;
  system: ConsoleInfo | null;
  collapsed: boolean;
}) {
  const items = [
    ['overview', Home, '总览'],
    ['nodes', Network, '节点'],
    ['audit', ClipboardList, '审计'],
    ['create', Plus, '创建实例'],
    ['config', FileCode2, '配置'],
    ['system', Settings, '系统']
  ] as const;

  return (
    <aside
      className={`${
        collapsed ? 'w-[68px]' : 'w-[232px]'
      } shrink-0 min-h-screen flex flex-col bg-[var(--color-sidebar-bg)] text-[var(--color-sidebar-fg)] transition-[width] duration-200 overflow-hidden`}
    >
      <div className="flex items-center gap-3 px-5 h-16 border-b border-white/5">
        <Boxes size={22} className="text-white shrink-0" />
        <span
          className={`text-[14px] font-semibold tracking-tight text-white whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? 'opacity-0' : 'opacity-100'
          }`}
        >
          frpc 多实例管理
        </span>
      </div>

      <nav aria-label="主导航" className="flex-1 px-2 py-4 flex flex-col gap-1">
        {items.map(([key, Icon, label]) => {
          const active = page === key;
          return (
            <button
              key={key}
              onClick={() => onPage(key)}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                active
                  ? 'bg-[var(--color-sidebar-active)] text-[var(--color-sidebar-fg-active)]'
                  : 'text-[var(--color-sidebar-fg)] hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span
                className={`whitespace-nowrap transition-opacity duration-200 ${
                  collapsed ? 'opacity-0' : 'opacity-100'
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="m-3 mt-auto rounded-md border border-white/5 bg-white/[0.02] p-3 text-[11px] leading-[1.7] text-slate-400 whitespace-nowrap">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            系统信息
          </div>
          <div className="flex justify-between gap-2">
            <span>面板</span>
            <span className="text-slate-300 font-mono">{system?.version || '--'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>节点数</span>
            <span className="text-slate-300 font-mono">{system?.nodeCount ?? '--'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>角色</span>
            <span className="text-slate-300 font-mono">{system?.role || '--'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>端口</span>
            <span className="text-slate-300 font-mono">{system?.webuiPort ?? '--'}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
