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
    <header className="topbar">
      <button
        className="icon-button"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        <Menu size={18} />
      </button>
      <div className="crumb">{pageTitle}</div>
      <div className="top-actions">
        <button className="icon-button" onClick={onRefresh} title="刷新">
          <RefreshCw size={16} />
        </button>
        <div className="user-menu" ref={menuRef}>
          <button className="user-trigger" onClick={() => setMenuOpen((v) => !v)}>
            <span className="avatar">{(username || 'admin').slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{username || 'admin'}</span>
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="user-dropdown" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSystem();
                }}
              >
                <Settings size={14} />系统
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
              >
                <LogOut size={14} />注销
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
