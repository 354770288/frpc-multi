import { useCallback, useEffect, useState } from 'react';
import { probeApi } from '../../lib/api';
import type { ProbeComparison } from '../../lib/types';
import { Overlay } from '../../components/Overlay';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { formatLastSeen } from '../../lib/format';
const flag = (value: boolean) => (value ? '通过' : '失败');
export function ProbeComparisonDialog({
  ip,
  port,
  onClose,
}: {
  ip: string;
  port: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ProbeComparison[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await probeApi.compare(ip, port)).items);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '对比加载失败');
    } finally {
      setLoading(false);
    }
  }, [ip, port]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Overlay title={`${ip}:${port} · 各节点最新观测`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">
            每项指标保留独立来源与时间。— 表示尚无观测；0 表示已测得零值。
          </p>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            刷新
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="overflow-auto">
          <table className="w-full min-w-[800px] text-xs">
            <thead>
              <tr className="border-b text-left">
                {['节点', '发现延迟', '路由 / CN2', '连通性', '下载 / 上传 Mbps'].map((label) => (
                  <th className="p-2" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b align-top" key={row.node.id}>
                  <td className="p-2">
                    <strong>{row.node.name}</strong>
                    <div className="mt-1">
                      <Badge tone={row.node.online ? 'success' : 'muted'}>
                        {row.node.online ? '在线' : '离线'}
                      </Badge>
                    </div>
                  </td>
                  <td className="p-2">
                    {row.discovery ? (
                      <>
                        {row.discovery.latency_ms.toFixed(2)} ms
                        <Time value={row.discovery.discovered_at} />
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2">
                    {row.route ? (
                      <>
                        <Badge
                          tone={row.route.ok ? (row.route.isCn2 ? 'success' : 'muted') : 'danger'}
                        >
                          {row.route.ok ? (row.route.isCn2 ? 'CN2' : '非 CN2') : '路由失败'}
                        </Badge>
                        <p className="mt-1">{row.route.hops.length} 跳</p>
                        <Time value={row.route.test_time} />
                        {row.route.error && <p>{row.route.error}</p>}
                        <details>
                          <summary className="cursor-pointer">逐跳详情</summary>
                          {row.route.hops.map((hop, index) => (
                            <p key={index} className="whitespace-nowrap font-mono">
                              {hop.hop} · {hop.host} · loss {hop.loss}% ·{' '}
                              {hop.avg == null ? '—' : `${hop.avg}ms`}
                            </p>
                          ))}
                        </details>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2">
                    {row.connectivity ? (
                      <>
                        <p>可达 {flag(row.connectivity.frps_reachable)}</p>
                        <p>隧道 {flag(row.connectivity.tunnel_established)}</p>
                        <p>端口 {flag(row.connectivity.firewall_open)}</p>
                        <Time value={row.connectivity.test_time} />
                        <p>{row.connectivity.detail}</p>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2">
                    {row.speed ? (
                      <>
                        <p>
                          ↓ {row.speed.dl_ok ? row.speed.dl_speed_mbps.toFixed(2) : '失败'} / ↑{' '}
                          {row.speed.ul_ok ? row.speed.ul_speed_mbps.toFixed(2) : '失败'}
                        </p>
                        <Time value={row.speed.test_time} />
                        <p>{row.speed.detail}</p>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && !loading && !error && (
          <p className="text-xs text-muted-foreground">暂无节点观测</p>
        )}
      </div>
    </Overlay>
  );
}
function Time({ value }: { value: string }) {
  return (
    <p className="mt-1 text-[11px] text-muted-foreground" title={value}>
      {formatLastSeen(value)}
    </p>
  );
}
