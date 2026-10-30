import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { ProbeRouteResult } from '../../lib/types';
import { Badge } from '../../components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { formatLastSeen } from '../../lib/format';
export function ProbeRouteHistory({
  ip,
}: {
  ip: string;
}) {
  const [rows, setRows] = useState<ProbeRouteResult[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setError('');
    const params = new URLSearchParams({ limit: '200' });
    if (ip.trim()) params.set('ip', ip.trim());
    api<ProbeRouteResult[]>(`/api/probe/history/route?${params}`, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : '路由历史加载失败');
      });
    return () => controller.abort();
  }, [ip]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>路由历史</CardTitle>
          <CardDescription>最近 200 项路由观测</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-96 overflow-auto">
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <table className="w-full min-w-[580px] text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">目标</th>
                <th className="p-2">来源</th>
                <th className="p-2">路由</th>
                <th className="p-2">跳数</th>
                <th className="p-2">时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="p-2 font-mono">
                    {row.server_ip}:{row.port}
                  </td>
                  <td className="p-2">{row.node_id}</td>
                  <td className="p-2">
                    <Badge tone={row.ok ? (row.isCn2 ? 'success' : 'muted') : 'danger'}>
                      {row.ok ? (row.isCn2 ? 'CN2' : '非 CN2') : '失败'}
                    </Badge>
                    {row.error && <p>{row.error}</p>}
                  </td>
                  <td className="p-2">{row.hops.length}</td>
                  <td className="p-2" title={row.test_time}>
                    {formatLastSeen(row.test_time)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !error && (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无路由记录</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
