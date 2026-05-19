import { useState } from 'react';
import {
  AlertTriangle,
  Cpu,
  HardDrive,
  MemoryStick,
  Plus,
  RotateCcw,
  Search,
  Server,
  Square,
  Trash2
} from 'lucide-react';
import { MetricCard } from '../components/MetricCard';
import { bytesToHuman, instanceStateLabel, parsePercent } from '../lib/format';
import type { Instance, Page, StatsMap, SystemInfo } from '../lib/types';

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
  let restartTotal = 0;
  let cpuTotal = 0;
  let memTotal = 0;
  let cpuSamples = 0;
  let memSamples = 0;
  for (const item of instances) {
    const stat = stats[item.name];
    const state = stat?.state || '';
    if (state === 'running') running += 1;
    else if ((state === 'exited' || state === 'dead') && stat?.exitCode && stat.exitCode !== 0) error += 1;
    else stopped += 1;
    restartTotal += stat?.restartCount || 0;
    if (stat?.cpuPercent) {
      cpuTotal += parsePercent(stat.cpuPercent);
      cpuSamples += 1;
    }
    if (stat?.memPercent) {
      memTotal += parsePercent(stat.memPercent);
      memSamples += 1;
    }
  }

  const lower = keyword.toLowerCase();
  const filtered = lower
    ? instances.filter(
        (item) =>
          item.name.toLowerCase().includes(lower) ||
          (item.displayName || '').toLowerCase().includes(lower)
      )
    : instances;

  const diskRatio = system && system.disk.total > 0 ? (system.disk.used / system.disk.total) * 100 : 0;

  return (
    <main className="content">
      <h2>
        运行摘要 <span>共 {instances.length} 个 frpc 实例</span>
      </h2>
      <section className="metrics">
        <MetricCard icon={<Server size={20} />} title="运行中" value={String(running)} />
        <MetricCard icon={<AlertTriangle size={20} />} title="异常" value={String(error)} tone="orange" />
        <MetricCard icon={<Square size={20} />} title="已停止" value={String(stopped)} tone="gray" />
        <MetricCard
          icon={<RotateCcw size={20} />}
          title="累计重启"
          value={String(restartTotal)}
          tone="purple"
        />
        <MetricCard
          icon={<MemoryStick size={20} />}
          title="内存占用"
          value={memSamples ? `${memTotal.toFixed(1)}%` : '0%'}
          tone="green"
        />
        <MetricCard
          icon={<Cpu size={20} />}
          title="CPU 占用"
          value={cpuSamples ? `${cpuTotal.toFixed(1)}%` : '0%'}
        />
      </section>

      <section className="disk-row">
        <div className="panel disk-panel">
          <div className="disk-head">
            <HardDrive size={18} />
            <h3>磁盘使用</h3>
            <span className="muted">
              {system
                ? `已用 ${bytesToHuman(system.disk.used)} / 总 ${bytesToHuman(system.disk.total)}`
                : '--'}
            </span>
          </div>
          <div className="disk-bar">
            <div
              className="disk-bar-fill"
              style={{ width: `${Math.min(100, Math.max(0, diskRatio)).toFixed(1)}%` }}
            />
          </div>
          <div className="disk-meta">
            <strong>{system ? `${diskRatio.toFixed(0)}%` : '--'}</strong>
            {!dockerAvailable && dockerError && (
              <span className="muted">Docker：{dockerError}</span>
            )}
          </div>
        </div>
      </section>

      <section className="dashboard-grid single">
        <div className="panel large">
          <div className="panel-head">
            <h3>实例列表</h3>
            <div className="row-actions" style={{ alignItems: 'center' }}>
              <div className="search">
                <Search size={16} />
                <input
                  placeholder="搜索实例名"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </div>
              <button className="primary" onClick={() => onPage('create')}>
                <Plus size={16} />创建实例
              </button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>实例名</th>
                <th>状态</th>
                <th>CPU</th>
                <th>内存</th>
                <th>重启次数</th>
                <th>配置路径</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const stat = stats[item.name];
                const { label, cls } = instanceStateLabel(stat, item.enabled);
                const pending = pendingAction[item.name];
                return (
                  <tr key={item.name}>
                    <td>
                      <button
                        className="link"
                        onClick={() => {
                          onSelect(item.name);
                          onPage('detail');
                        }}
                      >
                        {item.displayName || item.name}
                      </button>
                    </td>
                    <td>
                      <span className={cls} />
                      {label}
                    </td>
                    <td>{stat?.cpuPercent || '--'}</td>
                    <td>{stat?.memUsage || '--'}</td>
                    <td>{stat ? stat.restartCount : '--'}</td>
                    <td>{item.configPath}</td>
                    <td className="row-actions">
                      <button disabled={!!pending} onClick={() => onAction(item.name, 'start')}>
                        {pending === 'start' ? '启动中…' : '启动'}
                      </button>
                      <button disabled={!!pending} onClick={() => onAction(item.name, 'stop')}>
                        {pending === 'stop' ? '停止中…' : '停止'}
                      </button>
                      <button disabled={!!pending} onClick={() => onAction(item.name, 'restart')}>
                        {pending === 'restart' ? '重启中…' : '重启'}
                      </button>
                      <button
                        onClick={() => {
                          onSelect(item.name);
                          onPage('detail');
                        }}
                      >
                        日志
                      </button>
                      <button
                        onClick={() => {
                          onSelect(item.name);
                          onPage('config');
                        }}
                      >
                        编辑配置
                      </button>
                      <button
                        className="danger"
                        disabled={!!pending}
                        onClick={() => onDelete(item.name)}
                        title="停止并完全移除该实例（含目录与容器）"
                      >
                        <Trash2 size={14} />
                        {pending === 'delete' ? '删除中…' : '删除'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
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
