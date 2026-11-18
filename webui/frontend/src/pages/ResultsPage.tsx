import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import type { ProbeMode, ProbeResultBase, TestNode } from '../lib/types';
import { formatLastSeen } from '../lib/format';
import { CopyableText } from '../components/CopyableText';
import { PageHeader, PageShell } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { Td, Th } from './probe/ProbeTableShared';

type Kind = 'route' | 'connectivity' | 'speed';
type Row = ProbeResultBase & Record<string, unknown>;
const KIND_NAMES: Record<Kind, string> = {
  route: '路由',
  connectivity: '穿透连通性',
  speed: '上下行速率',
};

function resultTone(row: Row, kind: Kind): 'success' | 'warning' | 'danger' | 'muted' {
  if (kind === 'route') return row.ok === true ? (row.isCn2 ? 'success' : 'warning') : 'danger';
  if (kind === 'connectivity') {
    if (row.firewall_open) return 'success';
    if (row.frps_reachable) return 'warning';
    return 'danger';
  }
  if (row.dl_ok || row.ul_ok) return 'success';
  return 'danger';
}

function resultSummary(row: Row, kind: Kind): string {
  if (kind === 'route') return row.ok === true ? (row.isCn2 ? 'CN2 精品' : '非 CN2') : '路由失败';
  if (kind === 'connectivity') {
    return `frps ${row.frps_reachable ? '可达' : '失败'} · 隧道 ${row.tunnel_established ? '已建立' : '失败'} · 端口 ${row.firewall_open ? '开放' : '失败'}`;
  }
  const rate = (prefix: string) =>
    row[`${prefix}_ok`] ? `${((Number(row[`${prefix}_speed_bps`] || 0) * 8) / 1048576).toFixed(2)} Mbps` : '失败';
  return `下载 ${rate('dl')} · 上传 ${rate('ul')}`;
}

export function ResultsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = (['route', 'connectivity', 'speed'].includes(params.get('kind') || '')
    ? params.get('kind')
    : 'connectivity') as Kind;
  const ip = params.get('ip') || '';
  const port = params.get('port') || '';
  const jobId = params.get('jobId') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const page = Math.max(1, Number(params.get('page') || 1) || 1);

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retestingIp, setRetestingIp] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    probeApi
      .testNodes()
      .then((res) => {
        if (!cancelled && Array.isArray(res?.items)) setNodes(res.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodes) map.set(node.id, node.name);
    return map;
  }, [nodes]);

  const change = (key: string, value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete('page');
      return next;
    });

  const hasFilter = Boolean(ip || port || jobId || from || to);

  const clearFilters = () =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const k of ['ip', 'port', 'jobId', 'from', 'to', 'page']) next.delete(k);
      return next;
    });

  useEffect(() => {
    const id = ++request.current;
    const query: Record<string, string | number> = { page, pageSize: 50 };
    if (ip) query.ip = ip;
    if (port && Number(port) > 0) query.port = Number(port);
    if (jobId) query.jobId = jobId;
    const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00`) : null;
    const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999`) : null;
    if (start && Number.isFinite(start.getTime())) query.fromTime = start.toISOString().replace('Z', '+00:00');
    if (end && Number.isFinite(end.getTime())) query.toTime = end.toISOString().replace('Z', '+00:00');
    setLoading(true);
    void probeApi
      .historyPage(kind, query)
      .then((data) => {
        if (id === request.current) {
          setRows(data.items as Row[]);
          setTotal(data.total);
          setError('');
        }
      })
      .catch((err) => {
        if (id === request.current) setError(err instanceof Error ? err.message : '结果加载失败');
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [kind, ip, port, jobId, from, to, page]);

  async function retestRow(row: Row) {
    const endpoint = `${row.server_ip}:${row.port || 7000}`;
    setRetestingIp(endpoint);
    try {
      const mode: ProbeMode = kind;
      const job = await probeApi.createJob({
        mode,
        ips: [row.server_ip],
        targetScope: 'explicit',
      });
      toast.success(`已提交 ${row.server_ip} 的${KIND_NAMES[kind]}重测任务`, {
        action: {
          label: '查看批次',
          onClick: () => navigate(`/tests/${job.id}`),
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重测提交失败');
    } finally {
      setRetestingIp(null);
    }
  }

  return (
    <PageShell maxWidth="full" className="max-w-[1500px]">
      <PageHeader
        title="测试结果"
        description="按端点和批次追溯完整探测历史；每条记录保留实际执行节点，0 是已测得的数值，— 表示缺少观测"
      />

      <Card>
        <CardHeader className="border-b pb-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">测试项目</Label>
              <Select value={kind} onValueChange={(val) => change('kind', val)}>
                <SelectTrigger size="sm" aria-label="测试项目"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(KIND_NAMES) as Kind[]).map((item) => (
                      <SelectItem key={item} value={item}>{KIND_NAMES[item]}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">目标主机</Label>
              <Input
                className="h-8"
                aria-label="目标主机"
                value={ip}
                onChange={(event) => change('ip', event.target.value)}
                placeholder="IP 或域名"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">端口</Label>
              <Input
                className="h-8"
                aria-label="端口"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => change('port', event.target.value)}
                placeholder="全部端口"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">批次 ID</Label>
              <Input
                className="h-8"
                aria-label="批次 ID"
                value={jobId}
                onChange={(event) => change('jobId', event.target.value)}
                placeholder="全部批次"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">开始日期</Label>
              <Input
                className="h-8"
                aria-label="开始日期"
                type="date"
                value={from}
                onChange={(event) => change('from', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">结束日期</Label>
                {hasFilter && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />清空
                  </button>
                )}
              </div>
              <Input
                className="h-8"
                aria-label="结束日期"
                type="date"
                value={to}
                onChange={(event) => change('to', event.target.value)}
              />
            </div>
          </div>
        </CardHeader>

        {error && (
          <div role="alert" className="border-b bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            {error}；显示的可能是上一次成功加载的数据。
          </div>
        )}

        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <CardTitle className="text-sm">
              {KIND_NAMES[kind]} · {total === null ? '加载中' : `共 ${total} 条`}
            </CardTitle>
            {loading && <span role="status" className="text-xs text-muted-foreground">正在加载…</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="border-b bg-muted/40">
                  <Th>目标端点</Th>
                  <Th>测量结果</Th>
                  <Th>实际执行节点</Th>
                  <Th>详情 / 跳点</Th>
                  <Th>测试时间</Th>
                  <Th align="right">操作</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const endpoint = `${row.server_ip}:${row.port}`;
                  const resolvedNode = nodeNameById.get(row.node_id) || row.node_id;
                  return (
                    <tr key={row.id} className="border-b transition-colors last:border-b-0 hover:bg-muted/40">
                      <Td>
                        <CopyableText value={endpoint} label={endpoint} textClassName="text-[12.5px] font-medium" />
                      </Td>
                      <Td>
                        <Badge tone={resultTone(row, kind)}>{resultSummary(row, kind)}</Badge>
                      </Td>
                      <Td>
                        <span className="text-xs text-foreground" title={`节点 ID: ${row.node_id}`}>
                          {resolvedNode}
                        </span>
                      </Td>
                      <Td>
                        <div className="max-w-md space-y-1 text-xs text-muted-foreground">
                          {row.detail && <p className="truncate" title={row.detail}>{row.detail}</p>}
                          {kind === 'route' && Array.isArray(row.hops) && row.hops.length > 0 && (
                            <details>
                              <summary className="cursor-pointer hover:text-foreground">
                                路由跳点（{row.hops.length}）
                              </summary>
                              <ol className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded bg-muted/40 p-2 font-mono text-[11px]">
                                {row.hops.map((hop, index) => (
                                  <li key={index}>
                                    {index + 1}. {String((hop as { host?: string }).host || '*')}
                                  </li>
                                ))}
                              </ol>
                            </details>
                          )}
                          {!row.detail && !(kind === 'route' && Array.isArray(row.hops) && row.hops.length > 0) && '—'}
                        </div>
                      </Td>
                      <Td>
                        <span className="whitespace-nowrap text-xs text-muted-foreground" title={row.test_time}>
                          {formatLastSeen(row.test_time)}
                        </span>
                      </Td>
                      <Td align="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={retestingIp === endpoint}
                          onClick={() => void retestRow(row)}
                        >
                          <RotateCcw className="size-3" data-icon="inline-start" />重测
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
                {!loading && !rows.length && !error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-xs text-muted-foreground">
                      暂无匹配结果
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
            <span>第 {page} 页{total !== null ? ` / ${Math.max(1, Math.ceil(total / 50))} 页` : ''}</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() =>
                  setParams((current) => {
                    const next = new URLSearchParams(current);
                    next.set('page', String(page - 1));
                    return next;
                  })
                }
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={total === null || page * 50 >= total}
                onClick={() =>
                  setParams((current) => {
                    const next = new URLSearchParams(current);
                    next.set('page', String(page + 1));
                    return next;
                  })
                }
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
