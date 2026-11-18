import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FlaskConical,
  Globe,
  Monitor,
  Plus,
  Radar,
  RefreshCw,
  Server,
  ShieldAlert,
  Unplug,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, lbApi, probeApi, workspaceApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import type {
  LbDomain,
  LbGfwBlock,
  LbPortAlert,
  LbPortHealthResponse,
  ProbeDashboard,
  ProbeJob,
  ProbeMode,
  SummaryResponse,
  TestNode,
} from '../lib/types';
import { CopyableText } from '../components/CopyableText';
import { PageHeader, PageShell } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { Skeleton } from '../components/ui/skeleton';

const JOB_MODE_LABELS: Record<ProbeMode, string> = {
  discover: '网段发现',
  route: '路由追踪',
  connectivity: '连通性测试',
  speed: '上下行速率',
  full: '连通+速率全检',
};

function jobProgress(job: ProbeJob): { done: number; total: number; percent: number } {
  const counts = job.counts || {};
  const done =
    Number(counts.done ?? 0) +
    Number(counts.failed ?? 0) +
    Number(counts.skipped ?? 0) +
    Number(counts.stopped ?? 0);
  const total = Math.max(Number(job.targetTotal ?? job.taskTotal ?? 0), done);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { done, total, percent };
}

export function ResourceOverview() {
  const [dashboard, setDashboard] = useState<ProbeDashboard | null>(null);
  const [activeJobs, setActiveJobs] = useState<{ items: ProbeJob[]; total: number } | null>(null);
  const [failedJobs, setFailedJobs] = useState<{ items: ProbeJob[]; total: number } | null>(null);
  const [nodes, setNodes] = useState<TestNode[] | null>(null);
  const [domains, setDomains] = useState<LbDomain[] | null>(null);
  const [portHealth, setPortHealth] = useState<LbPortHealthResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [checkingPorts, setCheckingPorts] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    // 优先使用单请求聚合接口；若测试夹具未提供有效聚合体，则无缝回退分项加载
    try {
      const agg = await workspaceApi.overview();
      if (agg && agg.dashboard && Array.isArray(agg.domains) && Array.isArray(agg.testNodes)) {
        setDashboard(agg.dashboard);
        setActiveJobs(agg.activeJobs ?? { items: [], total: 0 });
        setFailedJobs(agg.failedJobs ?? { items: [], total: 0 });
        setNodes(agg.testNodes);
        setDomains(agg.domains);
        setPortHealth(agg.portHealth ?? null);
        setSummary(agg.summary ?? null);
        setErrors([]);
        return;
      }
    } catch {
      // 回退至分项请求
    }

    const values = await Promise.allSettled([
      probeApi.dashboard(),
      probeApi.jobsPage({ page: 1, pageSize: 5, state: 'running' }),
      probeApi.jobsPage({ page: 1, pageSize: 5, state: 'failed' }),
      probeApi.testNodes(),
      lbApi.domains(),
      lbApi.portHealth('active'),
      api<SummaryResponse>('/api/summary'),
    ]);
    const failed: string[] = [];
    if (values[0].status === 'fulfilled') setDashboard(values[0].value); else failed.push('服务器统计');
    if (values[1].status === 'fulfilled') setActiveJobs(values[1].value); else failed.push('进行中的测试');
    if (values[2].status === 'fulfilled') setFailedJobs(values[2].value); else failed.push('失败测试');
    if (values[3].status === 'fulfilled') setNodes(values[3].value.items); else failed.push('测试节点');
    if (values[4].status === 'fulfilled') setDomains(values[4].value); else failed.push('域名');
    if (values[5].status === 'fulfilled') setPortHealth(values[5].value);
    if (values[6].status === 'fulfilled') setSummary(values[6].value);
    setErrors(failed);
  }, []);

  useEffect(() => {
    let active = true;
    const safeLoad = async () => {
      if (!active) return;
      await load();
    };
    void safeLoad();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void safeLoad();
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const handleCheckPorts = async () => {
    setCheckingPorts(true);
    try {
      const res = await lbApi.checkPortHealth();
      setPortHealth((prev) => (prev ? { ...prev, alerts: res.alerts, gfwBlocks: res.gfwBlocks } : prev));
      if (res.policySkipReason) {
        toast.warning(`业务端口检测跳过：${res.policySkipReason}`);
      } else if (res.switchedCount > 0) {
        toast.warning(`检测到防火墙屏蔽，已自动切换 ${res.switchedCount} 个优选域名`);
      } else if (res.alerts.length > 0) {
        toast.warning(`检测完成：当前存在 ${res.alerts.length} 条业务端口/屏蔽异常`);
      } else {
        toast.success('业务端口检测通过，所有关联端口正常');
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '业务端口检测失败');
    } finally {
      setCheckingPorts(false);
    }
  };

  const handleUnblockIp = async (ip: string) => {
    setBusyKey(`unblock:${ip}`);
    try {
      await lbApi.unblockGfwIp(ip);
      toast.success(`已解除 ${ip} 的防火墙屏蔽标记`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解除屏蔽失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDismissAlert = async (alertId: number) => {
    setBusyKey(`dismiss:${alertId}`);
    try {
      await lbApi.dismissPortAlert(alertId);
      toast.success('异常记录已标记为已处理');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyKey(null);
    }
  };

  const enabledDomains = domains ? domains.filter((d) => d.enabled) : null;
  const syncFailedDomains = domains ? domains.filter((d) => d.enabled && d.lastSyncOk === false) : [];
  const onlineTestNodes = nodes ? nodes.filter((n) => n.online).length : null;
  const deployTotal = summary?.nodeCount ?? summary?.nodes?.length;
  const deployOnline =
    summary?.onlineCount ??
    (summary?.nodes ? summary.nodes.filter((n) => n.status === 'online').length : undefined);

  return (
    <PageShell>
      <PageHeader
        title="全域资源与运维工作台"
        description="实时洞察服务器资产、探测任务、优选域名业务端口健康与多节点 frpc 实例运行状态"
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/discovery">
                <Radar className="size-3.5" data-icon="inline-start" />发现服务器
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/instances/new">
                <Plus className="size-3.5" data-icon="inline-start" />创建实例
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/tests/new">
                <FlaskConical className="size-3.5" data-icon="inline-start" />新建测试
              </Link>
            </Button>
          </>
        }
      />

      {errors.length > 0 && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errors.join('、')}加载失败；已有数据可能不是最新。刷新页面可重试。
        </p>
      )}

      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Metric
          title="服务器资产"
          value={dashboard?.servers}
          sub={
            dashboard?.connectivity
              ? `${dashboard.connectivity.firewallOpen ?? 0} 台全栈可用`
              : '点击查看资产库'
          }
          icon={Server}
          to="/servers"
        />
        <Metric
          title="进行中的批次"
          value={activeJobs?.total}
          sub={activeJobs?.total ? '任务队列实时推进中' : '当前无活跃探测'}
          icon={Activity}
          tone={activeJobs?.total ? 'primary' : 'default'}
          to="/tests"
        />
        <Metric
          title="在线测试节点"
          value={nodes ? `${onlineTestNodes}/${nodes.length}` : null}
          sub="全局主备探测集群"
          icon={FlaskConical}
          to="/test-nodes"
        />
        <Metric
          title="已启用域名"
          value={enabledDomains ? enabledDomains.length : null}
          sub={domains ? `共管理 ${domains.length} 个优选域名` : 'Cloudflare 自动选优'}
          icon={Globe}
          to="/lb"
        />
        <Metric
          title="运行中实例"
          value={summary ? `${summary.running}/${summary.total}` : null}
          sub={summary?.error ? `${summary.error} 个实例异常` : 'frpc 隧道运行状态'}
          icon={Monitor}
          tone={summary?.error ? 'danger' : 'default'}
          to="/instances"
        />
        <Metric
          title="在线部署节点"
          value={deployTotal !== undefined ? `${deployOnline ?? 0}/${deployTotal}` : null}
          sub="远端 Agent 连接池"
          icon={Server}
          tone={deployTotal !== undefined && (deployOnline ?? 0) < deployTotal ? 'warning' : 'default'}
          to="/nodes"
        />
      </div>

      <AnomalyWindowCard
        portHealth={portHealth}
        domains={domains}
        summary={summary}
        testNodes={nodes}
        checking={checkingPorts}
        busyKey={busyKey}
        onCheckNow={handleCheckPorts}
        onUnblockIp={handleUnblockIp}
        onDismissAlert={handleDismissAlert}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">正在测试</CardTitle>
              <CardDescription className="mt-0.5">实时追踪活跃探测批次的执行进度</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 gap-1 text-xs">
              <Link to="/tests">
                查看全部批次 <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex-1 space-y-2.5 text-sm">
            {activeJobs === null ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : activeJobs.total === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/15 px-4 py-5 text-muted-foreground">
                <span>暂无进行中的测试</span>
                <Button asChild size="sm" variant="outline">
                  <Link to="/tests/new">发起探测</Link>
                </Button>
              </div>
            ) : (
              activeJobs.items.map((job) => {
                const { done, total, percent } = jobProgress(job);
                return (
                  <Link
                    className="block space-y-2 rounded-lg border bg-card p-3.5 transition-colors hover:bg-muted/40"
                    key={job.id}
                    to={`/tests/${job.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge tone="info">{JOB_MODE_LABELS[job.mode] || job.mode}</Badge>
                        <span className="font-mono text-xs text-muted-foreground">#{job.id.slice(0, 8)}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {done}/{total} 项（{percent}%）· {formatLastSeen(job.createdAt)}
                      </span>
                    </div>
                    <Progress value={percent} className="h-1.5" />
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">优选域名与关注事项</CardTitle>
              <CardDescription className="mt-0.5">当前解析指向速览与近期失败任务提醒</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 gap-1 text-xs">
              <Link to="/lb">
                管理域名 <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex-1 space-y-2.5 text-sm">
            {failedJobs === null && domains === null ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              <>
                {failedJobs && failedJobs.items.length > 0 && (
                  <div className="space-y-2">
                    {failedJobs.items.slice(0, 2).map((job) => (
                      <Link
                        className="flex items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 transition-colors hover:bg-destructive/10"
                        key={job.id}
                        to={`/tests/${job.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <Badge tone="danger">失败批次</Badge>
                          <span className="font-medium">{JOB_MODE_LABELS[job.mode] || job.mode}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{formatLastSeen(job.createdAt)}</span>
                      </Link>
                    ))}
                  </div>
                )}

                {syncFailedDomains.map((domain) => (
                  <Link
                    className="flex items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 transition-colors hover:bg-destructive/10"
                    key={`fail-${domain.id}`}
                    to={`/lb/${domain.id}`}
                  >
                    <span className="font-mono text-xs font-medium">{domain.name}</span>
                    <Badge tone="danger">最近同步失败</Badge>
                  </Link>
                ))}

                {enabledDomains && enabledDomains.length > 0 ? (
                  <div className="divide-y rounded-lg border">
                    {enabledDomains.slice(0, 4).map((domain) => (
                      <div
                        key={domain.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                          <Link to={`/lb/${domain.id}`} className="truncate font-mono font-medium hover:underline">
                            {domain.name}
                          </Link>
                          <span className="text-muted-foreground">候选 {domain.poolSize}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {domain.currentIp ? (
                            <CopyableText value={domain.currentIp} label={`${domain.name} 当前 IP`} />
                          ) : (
                            <span className="text-muted-foreground">待同步</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  failedJobs?.total === 0 && (
                    <div className="rounded-lg border border-dashed bg-muted/15 px-4 py-5 text-muted-foreground">
                      暂无失败批次，也尚未配置启用的优选域名
                    </div>
                  )
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

export type AnomalyWindowProps = {
  portHealth: LbPortHealthResponse | null;
  domains: LbDomain[] | null;
  summary: SummaryResponse | null;
  testNodes: TestNode[] | null;
  checking?: boolean;
  busyKey?: string | null;
  onCheckNow?: () => void;
  onUnblockIp?: (ip: string) => void;
  onDismissAlert?: (alertId: number) => void;
};

export function AnomalyWindowCard({
  portHealth,
  domains,
  summary,
  testNodes,
  checking = false,
  busyKey = null,
  onCheckNow,
  onUnblockIp,
  onDismissAlert,
}: AnomalyWindowProps) {
  const alerts: LbPortAlert[] = portHealth?.alerts ?? [];
  const gfwBlocks: LbGfwBlock[] = portHealth?.gfwBlocks ?? [];
  const portAlerts = alerts.filter((a) => a.kind === 'port_unreachable');
  const gfwAlerts = alerts.filter((a) => a.kind === 'gfw_blocked');
  const syncFailedDomains = (domains ?? []).filter((d) => d.enabled && d.lastSyncOk === false);
  const offlineDeployNodes = (summary?.nodes ?? []).filter((n) => n.status !== 'online');
  const errorInstanceCount = summary?.error ?? 0;
  const offlineTestNodes = (testNodes ?? []).filter((n) => n.kind === 'worker' && !n.online);

  const alertedBlockIps = new Set(gfwAlerts.map((a) => a.ip));
  const standaloneBlocks = gfwBlocks.filter((b) => !alertedBlockIps.has(b.ip));

  const totalAnomalies =
    portAlerts.length +
    gfwAlerts.length +
    standaloneBlocks.length +
    syncFailedDomains.length +
    offlineDeployNodes.length +
    (errorInstanceCount > 0 ? 1 : 0) +
    offlineTestNodes.length;

  const monitoredDomains = (portHealth?.domains ?? []).filter((d) => d.enabled);
  const monitoredPortCount = monitoredDomains.reduce((acc, d) => acc + d.businessPorts.length, 0);

  return (
    <Card className={totalAnomalies > 0 ? 'border-destructive/40 shadow-xs' : undefined} data-testid="anomaly-window">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {totalAnomalies > 0 ? (
              <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            )}
            <CardTitle className="text-base">异常监控窗口</CardTitle>
            {totalAnomalies > 0 ? (
              <Badge tone="danger">异常 {totalAnomalies} 项</Badge>
            ) : (
              <Badge tone="success">运行正常</Badge>
            )}
          </div>
          <CardDescription>
            监控优选域名关联的业务端口连通性（主备 tcping 对比识别 GFW 端口屏蔽与业务端口故障）及节点运行状态
          </CardDescription>
        </div>
        {onCheckNow && (
          <Button size="sm" variant="outline" onClick={onCheckNow} disabled={checking}>
            <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} data-icon="inline-start" />
            {checking ? '正在检测业务端口…' : '立即检测业务端口'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {totalAnomalies === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-4 py-3 text-muted-foreground">
            <span>当前无业务端口异常、GFW 屏蔽告警或节点故障。</span>
            <span className="text-xs">
              已监控 {monitoredDomains.length} 个启用域名 · {monitoredPortCount} 个运行中业务端口
            </span>
          </div>
        ) : (
          <div className="space-y-2.5">
            {portAlerts.map((alert) => (
              <div
                key={alert.id}
                className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">
                      <Unplug className="mr-1 size-3" />业务端口异常
                    </Badge>
                    <Link to={`/lb/${alert.domainId}`} className="font-mono font-medium hover:underline">
                      {alert.domainName}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      {alert.ip}:{alert.port}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      最近检测 {formatLastSeen(alert.lastCheckedAt)}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/90">
                    主节点（{alert.primaryNodeName || alert.primaryNodeId}）与备用节点（{alert.backupNodeName || alert.backupNodeId}）tcping 均不通，请检查源站服务、frpc 隧道或 frps 端口放行。
                  </p>
                  {alert.instances.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">关联实例：</span>
                      {alert.instances.map((inst) => (
                        <Link
                          key={`${inst.nodeId}:${inst.instanceName}`}
                          to={`/instances/${inst.nodeId}/${encodeURIComponent(inst.instanceName)}`}
                          className="rounded border bg-background px-2 py-0.5 font-mono hover:bg-muted"
                        >
                          {inst.nodeName} / {inst.displayName || inst.instanceName}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
                {onDismissAlert && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyKey === `dismiss:${alert.id}`}
                      onClick={() => onDismissAlert(alert.id)}
                      title="标记为已处理"
                    >
                      <X className="size-3.5" />忽略
                    </Button>
                  </div>
                )}
              </div>
            ))}

            {gfwAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`flex flex-col gap-2 rounded-lg border p-3.5 sm:flex-row sm:items-start sm:justify-between ${
                  alert.switched
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-destructive/40 bg-destructive/5'
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={alert.switched ? 'warning' : 'danger'}>
                      <ShieldAlert className="mr-1 size-3" />
                      {alert.switched ? 'GFW 屏蔽 · 已自动切换' : 'GFW 屏蔽 · 未能切换'}
                    </Badge>
                    <Link to={`/lb/${alert.domainId}`} className="font-mono font-medium hover:underline">
                      {alert.domainName}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      原 IP {alert.ip}:{alert.port}
                      {alert.switched && alert.switchedToIp ? ` → 新 IP ${alert.switchedToIp}` : ''}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatLastSeen(alert.lastCheckedAt)}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/90">{alert.message}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {onUnblockIp && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyKey === `unblock:${alert.ip}`}
                      onClick={() => onUnblockIp(alert.ip)}
                    >
                      解除 {alert.ip} 屏蔽
                    </Button>
                  )}
                  {onDismissAlert && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyKey === `dismiss:${alert.id}`}
                      onClick={() => onDismissAlert(alert.id)}
                    >
                      已知晓
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {standaloneBlocks.map((block) => (
              <div
                key={block.ip}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="warning">屏蔽隔离中</Badge>
                  <span className="font-mono font-medium">{block.ip}:{block.blockedPort}</span>
                  {block.domainName && <span className="text-muted-foreground">（触发域名：{block.domainName}）</span>}
                  <span className="text-muted-foreground">候选选优已自动排除该 IP</span>
                </div>
                {onUnblockIp && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyKey === `unblock:${block.ip}`}
                    onClick={() => onUnblockIp(block.ip)}
                  >
                    解除屏蔽
                  </Button>
                )}
              </div>
            ))}

            {syncFailedDomains.map((domain) => (
              <Link
                key={`sync-${domain.id}`}
                to={`/lb/${domain.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 hover:bg-muted/50"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="danger">DNS 同步失败</Badge>
                  <span className="font-mono font-medium">{domain.name}</span>
                  <span className="text-muted-foreground">{domain.lastSyncMessage || '请检查候选健康状态或 Cloudflare 配置'}</span>
                </div>
                <span className="text-xs text-muted-foreground">查看域名 →</span>
              </Link>
            ))}

            {errorInstanceCount > 0 && (
              <Link
                to="/instances"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="danger">实例运行异常</Badge>
                  <span>当前有 {errorInstanceCount} 个 frpc 实例容器异常退出</span>
                </div>
                <span className="text-xs text-muted-foreground">前往实例运维 →</span>
              </Link>
            )}

            {offlineDeployNodes.map((node) => (
              <Link
                key={`deploy-node-${node.id}`}
                to="/nodes"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="warning">部署节点离线</Badge>
                  <span className="font-medium">{node.name}</span>
                  <span className="text-muted-foreground">
                    {node.lastSeenAt ? `最后在线 ${formatLastSeen(node.lastSeenAt)}` : '尚未连接'}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">查看节点 →</span>
              </Link>
            ))}

            {offlineTestNodes.map((node) => (
              <Link
                key={`test-node-${node.id}`}
                to="/test-nodes"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="warning">测试节点离线</Badge>
                  <span className="font-medium">{node.name}</span>
                  <span className="text-muted-foreground">若为主用节点可能影响业务端口巡检与任务领取</span>
                </div>
                <span className="text-xs text-muted-foreground">测试节点设置 →</span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  title,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  to,
}: {
  title: string;
  value: string | number | null | undefined;
  sub?: string;
  icon: LucideIcon;
  tone?: 'default' | 'primary' | 'warning' | 'danger';
  to: string;
}) {
  const iconTone = {
    default: 'bg-muted text-muted-foreground',
    primary: 'bg-primary/12 text-primary',
    warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    danger: 'bg-destructive/12 text-destructive',
  }[tone];

  return (
    <Link
      to={to}
      className="group flex flex-col justify-between rounded-xl border bg-card p-4 shadow-2xs transition-all hover:border-primary/40 hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className={`grid size-7 place-items-center rounded-lg ${iconTone}`}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-3">
        {value === null || value === undefined ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">{value}</p>
        )}
        {sub && <p className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </Link>
  );
}
