import { useEffect, useRef, useState } from 'react';
import { ClipboardList, LogOut, Plus, Search, Settings, X } from 'lucide-react';

export function Topbar({
  username,
  onCreateInstance,
  workspaceSearch,
  onWorkspaceSearchChange,
  onOpenWorkspace,
  onOpenAudit,
  onLogout,
  onOpenSystem
}: {
  username: string;
  onCreateInstance: () => void;
  workspaceSearch: string;
  onWorkspaceSearchChange: (value: string) => void;
  onOpenWorkspace: () => void;
  onOpenAudit: () => void;
  onLogout: () => void;
  onOpenSystem: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const first = menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

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
      setMenuOpen(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 h-16 flex items-center gap-4 px-4 sm:px-6 border-b border-[var(--color-border)] bg-white/90 backdrop-blur">
      <button
        type="button"
        onClick={onOpenWorkspace}
        className="min-w-0 sm:min-w-[236px] flex items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        aria-label="返回节点工作台"
      >
        <div className="grid place-items-center w-[34px] h-[34px] rounded-lg bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-success)] text-white text-[14px] font-black shadow-sm">
          F
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-[var(--color-fg)]">
            frpc 多实例管理
          </div>
          <div className="hidden sm:block text-[11px] text-[var(--color-fg-muted)]">
            节点工作台
          </div>
        </div>
      </button>

      <div className="hidden md:flex items-center gap-2 h-9 w-[min(460px,34vw)] ml-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 text-[12px] text-[var(--color-fg-muted)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
        <Search size={14} aria-hidden="true" />
        <input
          value={workspaceSearch}
          onFocus={onOpenWorkspace}
          onChange={(event) => onWorkspaceSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && workspaceSearch) onWorkspaceSearchChange('');
          }}
          aria-label="搜索节点工作台实例"
          placeholder="搜索工作台实例、节点、配置路径"
          className="min-w-0 flex-1 bg-transparent outline-none text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
        />
        {workspaceSearch && (
          <button
            type="button"
            onClick={() => onWorkspaceSearchChange('')}
            className="-mr-1 grid h-6 w-6 place-items-center rounded-md text-[var(--color-fg-subtle)] hover:bg-white hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            aria-label="清除工作台搜索"
            title="清除工作台搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onCreateInstance}
          className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          <Plus size={14} />
          创建实例
        </button>
        <div className="relative">
          <button
            ref={triggerRef}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`用户菜单：${username || 'admin'}`}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-[var(--color-surface-muted)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <span
              aria-hidden="true"
              className="grid place-items-center w-8 h-8 rounded-full bg-slate-900 text-white text-[12px] font-semibold"
            >
              {(username || 'admin').slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden sm:inline text-[12px] text-[var(--color-fg)]">
              {username || 'admin'}
            </span>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              aria-label="用户菜单"
              onKeyDown={handleMenuKey}
              className="absolute right-0 top-[calc(100%+6px)] min-w-[206px] overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg z-50"
            >
              <div className="px-3 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <div className="text-[12px] font-semibold text-[var(--color-fg)]">
                  {username || 'admin'}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
                  系统与审计入口
                </div>
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenAudit();
                  triggerRef.current?.focus();
                }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] text-left"
              >
                <ClipboardList size={13} />
                审计日志
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSystem();
                  triggerRef.current?.focus();
                }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] text-left"
              >
                <Settings size={13} />
                账号与安全
              </button>
              <div className="border-t border-[var(--color-border)]" />
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] text-left"
              >
                <LogOut size={13} />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
