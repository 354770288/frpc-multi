import { useEffect, useState } from 'react';
import { ArrowLeft, Play, RefreshCw, RotateCcw, Search, Square } from 'lucide-react';
import { api } from '../lib/api';
import { instanceStateBadge } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
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
      <main className="px-6 py-6">
        <h2 className="text-[18px] font-semibold text-[var(--color-fg)]">请选择实例</h2>
      </main>
    );

  const visibleLogs = keyword
    ? logs.filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
    : logs;
  const stat = stats[name];
  const badge = instanceStateBadge(stat, detail?.enabled ?? false);
  const pending = pendingAction[name];

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <button
        onClick={() => onPage('overview')}
        className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
      >
        <ArrowLeft size={13} />
        返回总览
      </button>

      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          {detail?.displayName || name}
        </h2>
        <Badge tone={badge.tone} dot>
          {badge.label}
        </Badge>
        {detail?.displayName && detail.displayName !== name && (
          <span className="text-[12px] text-[var(--color-fg-muted)] font-mono">{name}</span>
        )}
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="CPU 占用" value={stat?.cpuPercent || '—'} />
        <StatTile label="内存占用" value={stat?.memUsage || '—'} />
        <StatTile label="重启次数" value={stat ? String(stat.restartCount) : '—'} />
        <StatTile
          label="配置路径"
          value={detail?.configPath || '—'}
          mono
          truncate
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4 mb-4">
        <Panel
          title="最近日志"
          actions={
            <div className="flex items-center gap-2 px-2.5 py-1.5 w-[220px] rounded-md border border-[var(--color-border)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
              <Search size={12} className="text-[var(--color-fg-subtle)]" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="过滤日志"
                className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
              />
            </div>
          }
          bodyClassName="p-0"
        >
          <pre className="m-0 h-[420px] overflow-auto px-4 py-3 bg-[#0b1220] text-[#cbd5e1] font-mono text-[12px] leading-[1.65] whitespace-pre-wrap">
            {visibleLogs.length ? visibleLogs.join('\n') : '暂无日志或 Docker 未连接'}
          </pre>
        </Panel>

        <Panel title="操作">
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              disabled={!!pending}
              onClick={() => onAction(name, 'start')}
            >
              <Play size={13} />
              {pending === 'start' ? '启动中…' : '启动'}
            </Button>
            <Button disabled={!!pending} onClick={() => onAction(name, 'stop')}>
              <Square size={13} />
              {pending === 'stop' ? '停止中…' : '停止'}
            </Button>
            <Button disabled={!!pending} onClick={() => onAction(name, 'restart')}>
              <RefreshCw size={13} />
              {pending === 'restart' ? '重启中…' : '重启'}
            </Button>
            <Button disabled={!!pending} onClick={() => onAction(name, 'recreate')}>
              <RotateCcw size={13} />
              {pending === 'recreate' ? '重建中…' : '重新创建容器'}
            </Button>
          </div>
        </Panel>
      </section>

      <Panel title="配置摘要">
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-[12px]">
          <SummaryItem label="服务端地址" value={detail?.summary.serverAddr} mono />
          <SummaryItem label="服务端端口" value={detail?.summary.serverPort} mono />
          <SummaryItem label="认证方式" value={detail?.summary.authMethod} />
          <SummaryItem
            label="代理数量"
            value={detail?.summary.proxyCount?.toString()}
          />
        </dl>
      </Panel>
    </main>
  );
}

function StatTile({
  label,
  value,
  mono = false,
  truncate = false
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-[12px] text-[var(--color-fg-muted)] mb-2">{label}</div>
      <div
        className={`text-[16px] font-semibold text-[var(--color-fg)] tabular-nums ${
          mono ? 'font-mono text-[12px] font-normal text-[var(--color-fg-muted)]' : ''
        } ${truncate ? 'truncate' : ''}`}
        title={truncate ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  mono = false
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--color-fg-muted)] mb-1">{label}</dt>
      <dd
        className={`text-[var(--color-fg)] font-medium ${mono ? 'font-mono tabular-nums' : ''}`}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}
