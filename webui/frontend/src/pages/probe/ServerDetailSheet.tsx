import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  Globe,
  Gauge,
  Route,
  Rocket,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { lbApi, probeApi } from '../../lib/api';
import { formatLastSeen } from '../../lib/format';
import { probeEndpointHost } from '../../lib/probeEndpoint';
import type {
  LbDomain,
  ProbeConnectivityHistory,
  ProbeMode,
  ProbeServer,
  ProbeSpeedHistory,
} from '../../lib/types';
import { CopyableText } from '../../components/CopyableText';
import { Overlay } from '../../components/Overlay';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import { Skeleton } from '../../components/ui/skeleton';
import { GeoInfo } from './GeoInfo';
import { ConnBadge, SpeedText } from './ProbeParts';

export function ServerDetailSheet({
  server,
  onClose,
  onRetest,
  onAssignDomain,
}: {
  server: ProbeServer | null;
  onClose: () => void;
  onRetest: (server: ProbeServer, mode: ProbeMode) => void;
  onAssignDomain: (server: ProbeServer) => void;
}) {
  const navigate = useNavigate();
  const [connHistory, setConnHistory] = useState<ProbeConnectivityHistory[]>([]);
  const [speedHistory, setSpeedHistory] = useState<ProbeSpeedHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    const host = probeEndpointHost(server.ip);
    setLoadingHistory(true);
    Promise.all([
      probeApi.connectivityHistory(host, 8).catch(() => [] as ProbeConnectivityHistory[]),
      probeApi.speedHistory(host, 8).catch(() => [] as ProbeSpeedHistory[]),
    ])
      .then(([conn, speed]) => {
        if (cancelled) return;
        setConnHistory(Array.isArray(conn) ? conn : []);
        setSpeedHistory(Array.isArray(speed) ? speed : []);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server]);

  return (
    <Sheet open={!!server} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        {server && (
          <>
            <SheetHeader className="border-b pb-3">
              <SheetTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
                <CopyableText value={server.ip} label="服务器地址" alwaysShowIcon />
                {server.group && <Badge tone="info">{server.group}</Badge>}
              </SheetTitle>
              <SheetDescription asChild>
                <div className="space-y-2 pt-1 text-xs">
                  <GeoInfo geo={server.geo} labels={server.labels} />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {server.domainId && server.domainName ? (
                      <Link
                        to={`/lb/${server.domainId}`}
                        onClick={onClose}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary hover:bg-primary/15"
                      >
                        <Globe className="size-3" />
                        优选池：{server.domainName}
                      </Link>
                    ) : (
                      <Badge tone="muted">未分配优选域名</Badge>
                    )}
                    {server.labels.map((lbl) => (
                      <Badge key={lbl} tone="muted">{lbl}</Badge>
                    ))}
                  </div>
                </div>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
              {/* 三维当前测量投影 */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Activity className="size-3" /> 连通性
                  </div>
                  <ConnBadge latest={server.latestConnectivity} />
                  {server.latestConnectivity?.testTime && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {formatLastSeen(server.latestConnectivity.testTime)}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Gauge className="size-3" /> 上下行速率
                  </div>
                  <SpeedText latest={server.latestSpeed} />
                  {server.latestSpeed?.testTime && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {formatLastSeen(server.latestSpeed.testTime)}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Route className="size-3" /> 路由类型
                  </div>
                  {server.latestRoute ? (
                    <Badge tone={server.latestRoute.ok ? (server.latestRoute.isCn2 ? 'success' : 'warning') : 'muted'}>
                      {server.latestRoute.ok ? (server.latestRoute.isCn2 ? 'CN2 精品' : '普通直连/绕行') : '追踪失败'}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">未测试</span>
                  )}
                  {server.latestRoute?.test_time && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {formatLastSeen(server.latestRoute.test_time)}
                    </div>
                  )}
                </div>
              </div>

              {/* 最近路由跳点 */}
              {server.latestRoute && server.latestRoute.hops?.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="font-medium text-foreground">最近路由追踪跳点（共 {server.latestRoute.hops.length} 跳）</h4>
                  <div className="max-h-44 overflow-y-auto rounded-lg border bg-muted/15 p-2 font-mono text-[11px]">
                    {server.latestRoute.hops.map((hop) => (
                      <div key={hop.hop} className="flex items-center justify-between gap-2 py-0.5">
                        <span className="truncate">
                          <span className="inline-block w-6 text-muted-foreground">#{hop.hop}</span>
                          <span className={hop.host.startsWith('59.43.') ? 'font-semibold text-emerald-600 dark:text-emerald-400' : ''}>
                            {hop.host}
                          </span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {hop.avg != null ? `${hop.avg.toFixed(1)} ms` : 'timeout'}
                          {hop.loss > 0 ? ` (${hop.loss}% 丢包)` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 近期测速历史 */}
              <div className="space-y-1.5">
                <h4 className="font-medium text-foreground">近期测速记录</h4>
                {loadingHistory ? (
                  <Skeleton className="h-20 w-full" />
                ) : speedHistory.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-3 text-muted-foreground">暂无历史测速记录</p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {speedHistory.slice(0, 5).map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="text-emerald-600 dark:text-emerald-400">↓ {item.downloadMbps.toFixed(1)}</span>
                          <span className="text-sky-600 dark:text-sky-400">↑ {item.uploadMbps.toFixed(1)} Mbps</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground">{formatLastSeen(item.testTime)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 近期连通性历史 */}
              <div className="space-y-1.5">
                <h4 className="font-medium text-foreground">近期连通性记录</h4>
                {loadingHistory ? (
                  <Skeleton className="h-20 w-full" />
                ) : connHistory.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-3 text-muted-foreground">暂无历史连通性记录</p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {connHistory.slice(0, 5).map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge tone={item.firewallOpen ? 'success' : item.frpsReachable ? 'warning' : 'danger'}>
                            {item.firewallOpen ? '全栈通过' : item.frpsReachable ? '部分通过' : '未通过'}
                          </Badge>
                          <span className="max-w-44 truncate text-muted-foreground" title={item.detail}>
                            {item.detail || '—'}
                          </span>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{formatLastSeen(item.testTime)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onClick={() => onRetest(server, 'full')}>
                <Zap className="size-3.5" data-icon="inline-start" />单机全检
              </Button>
              {!server.domainId && (
                <Button size="sm" variant="outline" onClick={() => onAssignDomain(server)}>
                  <Globe className="size-3.5" data-icon="inline-start" />加入域名池
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  navigate(`/instances/new?${new URLSearchParams({ server: probeEndpointHost(server.ip), port: String(server.port) })}`);
                }}
              >
                <Rocket className="size-3.5" data-icon="inline-start" />创建实例
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function AssignDomainDialog({
  serverIds,
  onClose,
  onAssigned,
}: {
  serverIds: number[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [domains, setDomains] = useState<LbDomain[]>([]);
  const [domainId, setDomainId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    lbApi
      .domains()
      .then((items) => {
        if (cancelled) return;
        const list = Array.isArray(items) ? items : [];
        setDomains(list);
        if (list.length > 0) setDomainId(String(list[0].id));
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : '加载优选域名失败'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    const targetId = Number(domainId);
    if (!targetId || !serverIds.length) return;
    setSubmitting(true);
    try {
      const res = await lbApi.addDomainServers(targetId, serverIds);
      const target = domains.find((d) => d.id === targetId);
      toast.success(`已加入「${target?.name || targetId}」候选池（当前池共 ${res.total} 台）`);
      onAssigned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加入域名候选池失败');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedDomain = domains.find((d) => String(d.id) === domainId);

  return (
    <Overlay
      title={`加入优选域名候选池（${serverIds.length} 台）`}
      description="每台服务器只允许归属一个优选域名候选池；若目标域名配置了自动同步分组，入池服务器将同步归入该分组。"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={loading || submitting || !domainId || !domains.length}>
            {submitting ? '提交中…' : '确认加入'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {loading ? (
          <Skeleton className="h-9 w-full" />
        ) : domains.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            当前尚未创建任何优选域名，请先前往「域名选优」添加域名。
          </p>
        ) : (
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">目标优选域名</label>
            <Select value={domainId} onValueChange={setDomainId}>
              <SelectTrigger aria-label="目标优选域名">
                <SelectValue placeholder="选择优选域名" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {domains.map((domain) => (
                    <SelectItem key={domain.id} value={String(domain.id)}>
                      {domain.name}（现有候选 {domain.poolSize} 台{domain.syncGroup ? ` · 同步组 ${domain.syncGroup}` : ''}）
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selectedDomain?.syncGroup && (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                该域名启用了同步分组「{selectedDomain.syncGroup}」，加入候选池后这 {serverIds.length} 台服务器会自动归入该分组。
              </p>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}
