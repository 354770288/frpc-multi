import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, RefreshCw, Settings } from 'lucide-react';

export function Topbar({
  pageTitle,
  username,
  sidebarCollapsed,
  onToggleSidebar,
  onRefresh,
  onLogout,
  onOpenSystem
}: {
  pageTitle: string;
  username: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenSystem: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(event: MouseEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setMenuOpen(false);
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [menuOpen]);

  return (
    <header className="h-14 flex items-center gap-3 px-5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        className="grid place-items-center w-8 h-8 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] transition-colors"
      >
        <Menu size={16} />
      </button>
      <div className="text-[13px] font-medium text-[var(--color-fg)]">{pageTitle}</div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onRefresh}
          title="刷新"
          className="grid place-items-center w-8 h-8 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] transition-colors"
        >
          <RefreshCw size={14} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            <span className="grid place-items-center w-6 h-6 rounded-full bg-[var(--color-accent)] text-white text-[11px] font-semibold">
              {(username || 'admin').slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[12px] text-[var(--color-fg)]">{username || 'admin'}</span>
            <ChevronDown size={12} className="text-[var(--color-fg-muted)]" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-[calc(100%+4px)] min-w-[160px] py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg z-50"
            >
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSystem();
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] text-left"
              >
                <Settings size={13} />
                系统
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] text-left"
              >
                <LogOut size={13} />
                注销
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
