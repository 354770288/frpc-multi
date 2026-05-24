import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, RefreshCw, RotateCcw, Search, Square } from 'lucide-react';
import { api } from '../lib/api';
import { getAuthToken } from '../lib/auth';
import { instanceStateBadge } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import type { InstanceDetail, Page, StatsMap } from '../lib/types';

const TAIL_OPTIONS = [100, 300, 1000] as const;
type TailOption = (typeof TAIL_OPTIONS)[number];
const FOLLOW_BUFFER_LIMIT = 5000;

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
  const [follow, setFollow] = useState(false);
  const [followState, setFollowState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!name) return;
    api<InstanceDetail>(`/api/instances/${name}`).then(setDetail).catch(console.error);
  }, [name]);

  useEffect(() => {
    if (!name || follow) return;
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
  }, [name, tail, appliedKeyword, follow]);

  useEffect(() => {
    if (!name || !follow) return;
    const token = getAuthToken();
    if (!token) {
      setFollowState('error');
      return;
    }
    const params = new URLSearchParams({ tail: String(tail), token });
    if (appliedKeyword) params.set('keyword', appliedKeyword);
    const url = `/api/instances/${name}/logs/stream?${params.toString()}`;
    setLogs([]);
    setFollowState('connecting');
    const source = new EventSource(url);
    source.addEventListener('ready', () => setFollowState('live'));
    source.addEventListener('log', (event) => {
      const line = (event as MessageEvent<string>).data ?? '';
      setLogs((prev) => {
        const next = prev.length >= FOLLOW_BUFFER_LIMIT
          ? prev.slice(prev.length - FOLLOW_BUFFER_LIMIT + 1)
          : prev.slice();
        next.push(line);
        return next;
      });
    });
    source.addEventListener('error', (event) => {
      const message = (event as MessageEvent<string>).data;
      if (message) {
        setLogs((prev) => [...prev, `[stream] ${message}`]);
      }
    });
    source.addEventListener('end', () => {
      setFollowState('idle');
      source.close();
    });
    source.onerror = () => {
      setFollowState('error');
    };
    return () => {
      source.close();
      setFollowState('idle');
    };
  }, [name, follow, tail, appliedKeyword]);

  useEffect(() => {
    if (!follow) return;
    const box = logBoxRef.current;
    if (!box) return;
    box.scrollTop = 0;
  }, [logs, follow]);

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
              {follow && (
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-normal ${
                    followState === 'live'
                      ? 'text-[var(--color-success)]'
                      : followState === 'error'
                        ? 'text-[var(--color-danger)]'
                        : 'text-[var(--color-fg-muted)]'
                  }`}
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      followState === 'live'
                        ? 'bg-[var(--color-success)] animate-pulse'
                        : followState === 'error'
                          ? 'bg-[var(--color-danger)]'
                          : 'bg-[var(--color-fg-subtle)]'
                    }`}
                  />
                  {followState === 'live'
                    ? '实时跟随中'
                    : followState === 'connecting'
                      ? '正在连接…'
                      : followState === 'error'
                        ? '连接失败'
                        : '已停止'}
                </span>
              )}
              {!follow && logsLoading && (
                <span className="text-[11px] font-normal text-[var(--color-fg-muted)]">加载中…</span>
              )}
            </span>
          }
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              <FollowToggle checked={follow} onChange={setFollow} />
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
          <pre
            ref={logBoxRef}
            className="m-0 h-[420px] overflow-auto px-4 py-3 bg-[#0b1220] text-[#cbd5e1] font-mono text-[12px] leading-[1.65] whitespace-pre-wrap"
          >
            {logs.length
              ? logs.slice().reverse().join('\n')
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
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-[12px] mb-4">
          <SummaryItem label="服务端地址" value={detail?.summary.serverAddr} mono />
          <SummaryItem label="服务端端口" value={detail?.summary.serverPort} mono />
          <SummaryItem label="认证方式" value={detail?.summary.authMethod} />
          <SummaryItem
            label="代理数量"
            value={detail?.summary.proxyCount?.toString()}
          />
        </dl>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
          <ChipGroup label="代理类型" entries={detail ? proxyTypeEntries(detail.summary.proxyTypes) : []} />
          <ChipGroup label="占用远端端口" entries={detail ? portEntries(detail.summary.remotePorts) : []} mono />
        </div>
      </Panel>
    </main>
  );
}

function proxyTypeEntries(types: Record<string, number> | undefined): { key: string; label: string }[] {
  if (!types) return [];
  return Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ key: type, label: `${type} · ${count}` }));
}

function portEntries(ports: number[] | undefined): { key: string; label: string }[] {
  if (!ports || ports.length === 0) return [];
  const counts = new Map<number, number>();
  for (const port of ports) {
    counts.set(port, (counts.get(port) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([port, count]) => ({
      key: String(port),
      label: count > 1 ? `${port} ×${count}` : String(port)
    }));
}

function ChipGroup({
  label,
  entries,
  mono = false
}: {
  label: string;
  entries: { key: string; label: string }[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[var(--color-fg-muted)] mb-1.5">{label}</div>
      {entries.length === 0 ? (
        <span className="text-[var(--color-fg-subtle)]">—</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry.key}
              className={`inline-flex items-center h-6 px-2 rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-[11px] text-[var(--color-fg)] ${
                mono ? 'font-mono tabular-nums' : ''
              }`}
            >
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function FollowToggle({
  checked,
  onChange
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={checked ? '关闭实时跟随' : '打开实时跟随'}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 h-8 px-2.5 rounded-md border text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        checked
          ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
          : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          checked ? 'bg-[var(--color-success)] animate-pulse' : 'bg-[var(--color-fg-subtle)]'
        }`}
      />
      实时跟随
    </button>
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
