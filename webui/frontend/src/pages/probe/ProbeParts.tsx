import { CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import type {
  ProbeConnectivitySummary,
  ProbeDashboard,
  ProbeRecentEntry,
  ProbeSpeedSummary,
} from '../../lib/types';

/** 最新连通性结果的三态徽标：全通过 / 部分通过 / 未测。 */
export function ConnBadge({ latest }: { latest: ProbeConnectivitySummary | null }) {
  if (!latest) return <Badge tone="muted">未测试</Badge>;
  const { frpsReachable, tunnelEstablished, firewallOpen } = latest;
  if (frpsReachable && tunnelEstablished && firewallOpen) {
    return <Badge tone="success"><CheckCircle2 size={12} />通过</Badge>;
  }
  if (frpsReachable && tunnelEstablished && !firewallOpen) {
    return <Badge tone="warning"><MinusCircle size={12} />端口未放行</Badge>;
  }
  if (frpsReachable) return <Badge tone="warning"><MinusCircle size={12} />隧道失败</Badge>;
  return <Badge tone="danger"><XCircle size={12} />不可达</Badge>;
}

/** 最新速率结果文本：↓ 12.3 ↑ 4.5 Mbps；失败时给原因入口。 */
export function SpeedText({ latest }: { latest: ProbeSpeedSummary | null }) {
  if (!latest) return <span className="text-xs text-muted-foreground">—</span>;
  if (!latest.downloadOk && !latest.uploadOk) {
    return <span className="text-xs text-destructive">均失败</span>;
  }
  const dl = latest.downloadOk ? `↓ ${latest.downloadMbps.toFixed(1)}` : '↓ —';
  const ul = latest.uploadOk ? `↑ ${latest.uploadMbps.toFixed(1)}` : '↑ —';
  return (
    <span className="font-mono text-[11px] tabular-nums text-foreground" title="Mbps">
      {dl} {ul} <span className="text-muted-foreground">Mbps</span>
    </span>
  );
}

/** 页头统计块。 */
export function ProbeStatCards({ stats }: { stats: ProbeDashboard | null }) {
  const items = stats
    ? [
        { label: '服务器', value: String(stats.servers) },
        { label: 'frps 可达', value: `${stats.connectivity.reachable}/${stats.connectivity.tested || 0}` },
        { label: '端口放行', value: `${stats.connectivity.firewallOpen}/${stats.connectivity.tested || 0}` },
        {
          label: '平均速率',
          value: stats.speed.avgDownloadMbps === null
            ? '—'
            : `↓${stats.speed.avgDownloadMbps} ↑${stats.speed.avgUploadMbps ?? '—'}`,
        },
      ]
    : [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <div key={item.label} className="flex h-8 items-center gap-2 rounded-md bg-muted px-2.5">
          <span className="text-[10px] text-muted-foreground">{item.label}</span>
          <span className="font-mono text-[11px] tabular-nums">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 测试进度区最近完成列表（倒序展示最近条目）。 */
export function RecentList({ recent }: { recent: ProbeRecentEntry[] }) {
  if (!recent.length) {
    return <div className="rounded-md border border-dashed border-input p-4 text-center text-xs text-muted-foreground">还没有已完成的服务器</div>;
  }
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      {recent.map((entry, index) => (
        <div
          key={`${entry.ip}-${entry.kind}-${index}`}
          className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5"
        >
          <span className="w-14 shrink-0 text-[10px] text-muted-foreground">
            {entry.kind === 'connectivity' ? '连通' : '速率'}
          </span>
          <span className="w-32 shrink-0 truncate font-mono text-[11px]" title={entry.ip}>{entry.ip}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={entry.summary}>
            {entry.skipped ? '已跳过' : entry.summary}
          </span>
          {entry.skipped ? (
            <Badge tone="muted">跳过</Badge>
          ) : entry.ok ? (
            <Badge tone="success">通过</Badge>
          ) : (
            <Badge tone="danger">未过</Badge>
          )}
        </div>
      ))}
    </div>
  );
}
