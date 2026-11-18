import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert, Unplug, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, lbApi, probeApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import type {
  LbDomain,
  LbGfwBlock,
  LbPortAlert,
  LbPortHealthResponse,
  ProbeDashboard,
  ProbeJob,
  SummaryResponse,
  TestNode,
} from '../lib/types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

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

  return (
    <main className="mx-auto max-w-[1300px] space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">资源与测试工作台</h2>
          <p className="text-sm text-muted-foreground">发现服务器、核对测试结果，再配置域名选优</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link to="/discovery">发现服务器</Link></Button>
          <Button asChild><Link to="/tests/new">新建测试</Link></Button>
        </div>
      </div>
      {errors.length > 0 && (
        <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          {errors.join('、')}加载失败；已有数据可能不是最新。刷新页面可重试。
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="服务器资产" value={dashboard?.servers} to="/servers" />
        <Metric title="进行中的批次" value={activeJobs?.total} to="/tests" />
        <Metric title="在线测试节点" value={nodes ? `${nodes.filter((n) => n.online).length}/${nodes.length}` : null} to="/test-nodes" />
        <Metric title="已启用域名" value={domains ? domains.filter((d) => d.enabled).length : null} to="/lb" />
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
        <Card>
          <CardHeader><CardTitle>正在测试</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {activeJobs === null
              ? '加载中…'
              : activeJobs.total === 0
                ? '暂无进行中的测试'
                : activeJobs.items.map((job) => (
                    <Link className="block rounded-lg border p-3 hover:bg-muted" key={job.id} to={`/tests/${job.id}`}>
                      {job.mode} · {job.taskTotal} 项 · {job.createdAt}
                    </Link>
                  ))}
            <Button asChild variant="link"><Link to="/tests">查看全部批次</Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>需要关注</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {failedJobs === null
              ? '加载中…'
              : failedJobs.total === 0
                ? '暂无失败批次'
                : failedJobs.items.map((job) => (
                    <Link className="block rounded-lg border p-3 hover:bg-muted" key={job.id} to={`/tests/${job.id}`}>
                      <Badge tone="danger">失败</Badge> {job.mode} · {job.createdAt}
                    </Link>
                  ))}
            {domains?.filter((d) => d.enabled && d.lastSyncOk === false).map((domain) => (
              <Link className="block rounded-lg border p-3 hover:bg-muted" key={domain.id} to={`/lb/${domain.id}`}>
                {domain.name} · 最近同步失败
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <Button asChild variant="outline"><Link to="/instances">打开实例运维</Link></Button>
    </main>
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

  // 未包含在活跃 gfwAlerts 中的隔离态 IP（例如已手动确认关闭告警但 IP 仍在屏蔽名单中）
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
    <Card className={totalAnomalies > 0 ? 'border-destructive/40' : undefined} data-testid="anomaly-window">
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

function Metric({ title, value, to }: { title: string; value: string | number | null | undefined; to: string }) {
  return (
    <Link to={to} className="rounded-xl border bg-card p-5 hover:bg-muted">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value ?? '—'}</p>
    </Link>
  );
}
