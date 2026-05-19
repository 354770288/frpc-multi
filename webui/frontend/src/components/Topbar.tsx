import { LogOut, Menu, RefreshCw } from 'lucide-react';

export function Topbar({
  onRefresh,
  username,
  onLogout
}: {
  onRefresh: () => void;
  username: string;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button">
        <Menu size={18} />
      </button>
      <div className="crumb">控制台 / frpc WebUI</div>
      <div className="top-actions">
        <button onClick={onRefresh}>
          <RefreshCw size={16} />
          刷新
        </button>
        <span className="avatar">{username || 'admin'}</span>
        <button onClick={onLogout} title="退出登录">
          <LogOut size={16} />
          退出
        </button>
      </div>
    </header>
  );
}
