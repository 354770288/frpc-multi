import { useEffect, useState } from 'react';
import { Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { api } from '../lib/api';
import { instanceStateLabel } from '../lib/format';
import type { InstanceDetail, Page, StatsMap } from '../lib/types';

export function Detail({
  name,
  stats,
  pendingAction,
  onPage,
  onAction
}: {
  name: string;
  stats: StatsMap;
  pendingAction: Record<string, string>;
  onPage: (page: Page) => void;
  onAction: (name: string, action: string) => void;
}) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!name) return;
    api<InstanceDetail>(`/api/instances/${name}`).then(setDetail).catch(console.error);
    api<{ lines: string[] }>(`/api/instances/${name}/logs?tail=300`)
      .then((data) => setLogs(data.lines))
      .catch(() => setLogs([]));
  }, [name]);

  if (!name)
    return (
      <main className="content">
        <h2>请选择实例</h2>
      </main>
    );

  const visibleLogs = keyword
    ? logs.filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
    : logs;
  const stat = stats[name];
  const stateInfo = instanceStateLabel(stat, detail?.enabled ?? false);
  const pending = pendingAction[name];

  return (
    <main className="content">
      <button className="back" onClick={() => onPage('overview')}>
        返回
      </button>
      <h2>
        实例详情：{name} <span>{stateInfo.label}</span>
      </h2>
      <section className="summary-card">
        <div>
          <span className={stateInfo.cls} />
          {detail?.displayName || name}
        </div>
        <div>
          <small>CPU 占用</small>
          <strong>{stat?.cpuPercent || '--'}</strong>
        </div>
        <div>
          <small>内存占用</small>
          <strong>{stat?.memUsage || '--'}</strong>
        </div>
        <div>
          <small>重启次数</small>
          <strong>{stat ? stat.restartCount : '--'}</strong>
        </div>
        <div>
          <small>配置路径</small>
          <strong>{detail?.configPath || '--'}</strong>
        </div>
      </section>

      <section className="detail-grid">
        <div className="panel log-panel">
          <div className="panel-head">
            <h3>最近日志</h3>
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索日志内容"
            />
          </div>
          <pre>{visibleLogs.length ? visibleLogs.join('\n') : '暂无日志或 Docker 未连接'}</pre>
        </div>
        <div className="panel actions-panel">
          <h3>操作区</h3>
          <button className="primary" disabled={!!pending} onClick={() => onAction(name, 'start')}>
            <Play size={16} />
            {pending === 'start' ? '启动中…' : '启动'}
          </button>
          <button disabled={!!pending} onClick={() => onAction(name, 'stop')}>
            <Square size={16} />
            {pending === 'stop' ? '停止中…' : '停止'}
          </button>
          <button disabled={!!pending} onClick={() => onAction(name, 'restart')}>
            <RefreshCw size={16} />
            {pending === 'restart' ? '重启中…' : '重启'}
          </button>
          <button disabled={!!pending} onClick={() => onAction(name, 'recreate')}>
            <RotateCcw size={16} />
            {pending === 'recreate' ? '重建中…' : '重新创建容器'}
          </button>
        </div>
      </section>

      <section className="panel">
        <h3>配置摘要</h3>
        <div className="summary-table">
          <span>服务端地址</span>
          <strong>{detail?.summary.serverAddr || '--'}</strong>
          <span>服务端端口</span>
          <strong>{detail?.summary.serverPort || '--'}</strong>
          <span>认证方式</span>
          <strong>{detail?.summary.authMethod || '--'}</strong>
          <span>代理数量</span>
          <strong>{detail?.summary.proxyCount ?? '--'}</strong>
        </div>
      </section>
    </main>
  );
}
