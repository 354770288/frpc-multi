import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, Settings } from 'lucide-react';

export function Topbar({
  pageTitle,
  username,
  sidebarCollapsed,
  onToggleSidebar,
  onLogout,
  onOpenSystem
}: {
  pageTitle: string;
  username: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
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
    <header className="h-14 flex items-center gap-3 px-5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        aria-expanded={!sidebarCollapsed}
        className="grid place-items-center w-8 h-8 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <Menu size={16} />
      </button>
      <div className="text-[13px] font-medium text-[var(--color-fg)]">{pageTitle}</div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <button
            ref={triggerRef}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`用户菜单：${username || 'admin'}`}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-[var(--color-surface-muted)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <span
              aria-hidden="true"
              className="grid place-items-center w-6 h-6 rounded-full bg-[var(--color-accent)] text-white text-[11px] font-semibold"
            >
              {(username || 'admin').slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[12px] text-[var(--color-fg)]">{username || 'admin'}</span>
            <ChevronDown size={12} className="text-[var(--color-fg-muted)]" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              aria-label="用户菜单"
              onKeyDown={handleMenuKey}
              className="absolute right-0 top-[calc(100%+4px)] min-w-[160px] py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg z-50"
            >
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSystem();
                  triggerRef.current?.focus();
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] text-left"
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
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-muted)] text-left"
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
