import { Boxes, FileCode2, Home, Plus, Settings } from 'lucide-react';
import type { Page, SystemInfo } from '../lib/types';

export function Sidebar({
  page,
  onPage,
  system
}: {
  page: Page;
  onPage: (page: Page) => void;
  system: SystemInfo | null;
}) {
  const items = [
    ['overview', Home, '总览'],
    ['create', Plus, '创建实例'],
    ['config', FileCode2, '配置'],
    ['system', Settings, '系统']
  ] as const;

  return (
    <aside className="sidebar">
      <div className="brand">
        <Boxes size={26} />
        <strong>frpc 多实例管理</strong>
      </div>
      <nav>
        {items.map(([key, Icon, label]) => (
          <button className={page === key ? 'active' : ''} key={key} onClick={() => onPage(key)}>
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="system-card">
        <strong>系统信息</strong>
        <p>面板版本 {system?.version || '--'}</p>
        <p>frpc 版本 {system?.frpVersion || '--'}</p>
        <p>Docker 版本 {system?.dockerVersion || '--'}</p>
        <p>面板端口 {system?.webuiPort ?? '--'}</p>
        <p>项目目录 {system?.projectDir || '--'}</p>
      </div>
    </aside>
  );
}
