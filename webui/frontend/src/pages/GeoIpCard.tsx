import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { geoipApi } from '../lib/api';
import { geoDatabaseAge } from '../lib/geoip';
import type { GeoIpStatus } from '../lib/types';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';

const timestamp = (value: string | null) => value ? new Date(value).toLocaleString() : '—';

export function GeoIpCard() {
  const [status, setStatus] = useState<GeoIpStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setStatus(await geoipApi.status()); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '归属地状态读取失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.enabled) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, status.updating || !status.backfill.done ? 2000 : 30000);
    return () => window.clearInterval(timer);
  }, [status?.enabled, status?.updating, status?.backfill.done, refresh]);
  const run = async (action: 'update' | 'refresh') => {
    setBusy(true);
    try {
      await geoipApi[action]();
      toast.success(action === 'update' ? '数据库更新任务已提交' : '归属地刷新任务已提交');
      await refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '任务提交失败'); }
    finally { setBusy(false); }
  };
  return <Card className="mt-4">
    <CardHeader>
      <CardTitle>本地 IP 归属地</CardTitle>
      <CardDescription>自动生成国家/地区与 ASN 标签，用于查看和筛选。业务分组可选，按用途手动维护；测试状态来自已有测试，域名成员独立维护。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">正在读取归属地状态…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {status && <>
        <div className="flex flex-wrap gap-2"><Badge tone={status.enabled && status.version ? 'success' : 'muted'}>{!status.enabled ? '已停用' : status.version ? '数据库已就绪' : '待安装数据库'}</Badge>{status.updating && <Badge tone="warning">更新中</Badge>}<Badge tone="muted">下载凭据{status.tokenConfigured ? '已配置' : '未配置'}</Badge></div>
        {!status.enabled && <p className="text-xs text-muted-foreground">归属地功能已停用；启用后会继续自动识别。</p>}
        {status.enabled && !status.version && <p className="text-xs text-muted-foreground">本地数据库尚未就绪。配置下载凭据后更新数据库，或在配置路径放置 IPinfo Lite MMDB。</p>}
        <dl className="grid gap-4 text-xs sm:grid-cols-2">
          <GeoItem label="数据库版本" value={status.version || '—'} />
          <GeoItem label="数据年龄" value={geoDatabaseAge(status)} />
          <GeoItem label="更新时间" value={timestamp(status.updatedAt)} />
          <GeoItem label="最近检查" value={timestamp(status.lastCheckAt)} />
          <GeoItem label="本地路径" value={status.path} />
          <GeoItem label="回填进度" value={status.backfill.done ? '已完成' : `${status.backfill.phase} · ${status.backfill.cursor}`} />
        </dl>
        <div className="flex flex-wrap gap-2"><Badge tone="muted">待查询 {status.counts.pending}</Badge><Badge tone="muted">已识别 {status.counts.ready}</Badge><Badge tone="muted">无数据 {status.counts.notFound}</Badge><Badge tone="muted">非公网 {status.counts.nonPublic}</Badge><Badge tone={status.counts.error ? 'warning' : 'muted'}>错误 {status.counts.error}</Badge></div>
        {status.lastError && <p role="alert" className="text-xs text-destructive">{status.lastError}</p>}
      </>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy || !status?.enabled || !status.tokenConfigured || status.updating} onClick={() => void run('update')}>更新数据库</Button>
      <Button variant="outline" size="sm" disabled={busy || !status?.enabled || !status.version || status.updating} onClick={() => void run('refresh')}>刷新归属地</Button>
      <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void refresh()}>刷新状态</Button>
      <a className="ml-auto text-xs text-muted-foreground underline underline-offset-4" href="https://ipinfo.io/" target="_blank" rel="noreferrer">IP geolocation by IPinfo</a>
    </CardFooter>
  </Card>;
}

function GeoItem({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-1"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
}
