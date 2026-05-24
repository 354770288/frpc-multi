import { useEffect, useState } from 'react';
import { ArrowLeft, Play, RefreshCw, RotateCcw, Search, Square } from 'lucide-react';
import { api } from '../lib/api';
import { instanceStateBadge } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import type { InstanceDetail, Page, StatsMap } from '../lib/types';

const TAIL_OPTIONS = [100, 300, 1000] as const;
type TailOption = (typeof TAIL_OPTIONS)[number];

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
  const [keywordInput, setKeywordInput] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [tail, setTail] = useState<TailOption>(300);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (!name) return;
    api<InstanceDetail>(`/api/instances/${name}`).then(setDetail).catch(console.error);
  }, [name]);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLogsLoading(true);
    const params = new URLSearchParams({ tail: String(tail) });
    if (appliedKeyword) params.set('keyword', appliedKeyword);
    api<{ lines: string[] }>(`/api/instances/${name}/logs?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setLogs(data.lines);
      })
      .catch(() => {
        if (!cancelled) setLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name, tail, appliedKeyword]);

  if (!name)
    return (
      <main className="px-6 py-6">
        <h2 className="text-[18px] font-semibold text-[var(--color-fg)]">请选择实例</h2>
      </main>
    );

  const stat = stats[name];
  const badge = instanceStateBadge(stat, detail?.enabled ?? false);
  const pending = pendingAction[name];

  function applyKeyword() {
    setAppliedKeyword(keywordInput.trim());
  }

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <button
        onClick={() => onPage('overview')}
        className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
      >
        <ArrowLeft size={13} />
        返回总览
      </button>

      <div className="mb-2 flex items-center gap-3 flex-wrap">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          {detail?.displayName || name}
        </h2>
        <Badge tone={badge.tone} dot>
          {badge.label}
        </Badge>
        {detail && !detail.enabled && (
          <Badge tone="muted">已停用</Badge>
        )}
        {detail?.displayName && detail.displayName !== name && (
          <span className="text-[12px] text-[var(--color-fg-muted)] font-mono">{name}</span>
        )}
      </div>
      {detail?.description && (
        <p className="mb-6 text-[12px] text-[var(--color-fg-muted)] max-w-[720px]">
          {detail.description}
        </p>
      )}
      {!detail?.description && <div className="mb-6" />}

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
          title={
            <span className="inline-flex items-center gap-2">
              最近日志
              {logsLoading && (
                <span className="text-[11px] font-normal text-[var(--color-fg-muted)]">加载中…</span>
              )}
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <select
                value={tail}
                onChange={(event) => setTail(Number(event.target.value) as TailOption)}
                aria-label="日志行数"
                className="h-8 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
              >
                {TAIL_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    最近 {value} 行
                  </option>
                ))}
              </select>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  applyKeyword();
                }}
                className="flex items-center gap-2 px-2.5 py-1.5 w-[220px] rounded-md border border-[var(--color-border)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15"
              >
                <Search size={12} className="text-[var(--color-fg-subtle)]" aria-hidden="true" />
                <input
                  value={keywordInput}
                  onChange={(event) => setKeywordInput(event.target.value)}
                  onBlur={applyKeyword}
                  placeholder="按 Enter 搜索"
                  aria-label="按关键字过滤日志"
                  className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                />
                {appliedKeyword && (
                  <button
                    type="button"
                    onClick={() => {
                      setKeywordInput('');
                      setAppliedKeyword('');
                    }}
                    className="text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    aria-label="清除过滤"
                  >
                    清除
                  </button>
                )}
              </form>
            </div>
          }
          bodyClassName="p-0"
        >
          <pre className="m-0 h-[420px] overflow-auto px-4 py-3 bg-[#0b1220] text-[#cbd5e1] font-mono text-[12px] leading-[1.65] whitespace-pre-wrap">
            {logs.length
              ? logs.join('\n')
              : appliedKeyword
                ? `没有匹配「${appliedKeyword}」的日志`
                : '暂无日志或 Docker 未连接'}
          </pre>
        </Panel>

        <Panel title="操作">
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              disabled={!!pending || !(detail?.enabled ?? true)}
              onClick={() => onAction(name, 'start')}
              title={detail && !detail.enabled ? '实例已停用，请先在总览启用' : undefined}
            >
              <Play size={13} />
              {pending === 'start' ? '启动中…' : '启动'}
            </Button>
            <Button disabled={!!pending} onClick={() => onAction(name, 'stop')}>
              <Square size={13} />
              {pending === 'stop' ? '停止中…' : '停止'}
            </Button>
            <Button
              disabled={!!pending || !(detail?.enabled ?? true)}
              onClick={() => onAction(name, 'restart')}
            >
              <RefreshCw size={13} />
              {pending === 'restart' ? '重启中…' : '重启'}
            </Button>
            <Button
              disabled={!!pending || !(detail?.enabled ?? true)}
              onClick={() => onAction(name, 'recreate')}
            >
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
