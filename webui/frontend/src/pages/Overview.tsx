import { useState } from 'react';
import {
  AlertTriangle,
  Cpu,
  HardDrive,
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
  const instancesReadable = instances.length >= 0;

  return (
    <main className="content">
      <h2>
        运行摘要 <span>共 {instances.length} 个 frpc 实例</span>
      </h2>
      <section className="metrics">
        <MetricCard icon={<Server size={20} />} title="运行中" value={String(running)} hint="docker compose ps 状态" />
        <MetricCard icon={<AlertTriangle size={20} />} title="异常" value={String(error)} hint="exited 且 exitCode 非 0" tone="orange" />
        <MetricCard icon={<Square size={20} />} title="已停止" value={String(stopped)} hint="未运行的实例数" tone="gray" />
        <MetricCard
          icon={<RotateCcw size={20} />}
          title="累计重启"
          value={String(restartTotal)}
          hint="docker inspect 中 RestartCount 累加"
          tone="purple"
        />
        <MetricCard
          icon={<HardDrive size={20} />}
          title="内存占用"
          value={memSamples ? `${memTotal.toFixed(1)}%` : '0%'}
          hint={memSamples ? `${memSamples} 个容器汇总` : '暂无运行容器'}
          tone="green"
        />
        <MetricCard
          icon={<Cpu size={20} />}
          title="CPU 占用"
          value={cpuSamples ? `${cpuTotal.toFixed(1)}%` : '0%'}
          hint={cpuSamples ? `${cpuSamples} 个容器汇总` : '暂无运行容器'}
        />
      </section>

      <section className="dashboard-grid">
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

        <aside className="side-stack">
          <div className="panel">
            <h3>健康检查</h3>
            <p className={instancesReadable ? 'check ok' : 'check'}>
              <span className={instancesReadable ? 'status ok' : 'status'} />
              实例目录 {instancesReadable ? '可读取' : '读取失败'}
            </p>
            <p className={instancesReadable ? 'check ok' : 'check'}>
              <span className={instancesReadable ? 'status ok' : 'status'} />
              配置文件 {instancesReadable ? '可读取' : '读取失败'}
            </p>
            <p className={dockerAvailable ? 'check ok' : 'check'}>
              <span className={dockerAvailable ? 'status ok' : 'status'} />
              Docker 状态 {dockerAvailable ? '已连接' : '未连接'}
            </p>
            {!dockerAvailable && dockerError && (
              <p className="muted" style={{ marginTop: 4 }}>
                {dockerError}
              </p>
            )}
            <p className={error === 0 ? 'check ok' : 'check'}>
              <span className={error === 0 ? 'status ok' : 'status'} />
              异常实例 {error === 0 ? '0 个' : `${error} 个`}
            </p>
          </div>
          <div className="panel">
            <h3>磁盘使用</h3>
            {system ? (
              <>
                <div className="donut">{diskRatio.toFixed(0)}%</div>
                <p className="muted">
                  已用 {bytesToHuman(system.disk.used)} / 总 {bytesToHuman(system.disk.total)}
                </p>
              </>
            ) : (
              <div className="donut">--</div>
            )}
          </div>
          <div className="panel">
            <h3>最近告警</h3>
            {error > 0 ? <p className="check">检测到 {error} 个实例异常退出</p> : <p className="muted">暂无告警</p>}
          </div>
        </aside>
      </section>
    </main>
  );
}
