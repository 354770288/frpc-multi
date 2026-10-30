import { Badge } from '../../components/ui/badge';
import { geoBadges, geoCountry } from '../../lib/geoip';
import type { GeoIpInfo } from '../../lib/types';

const STATUS_TEXT: Record<GeoIpInfo['status'], string> = {
  pending: '归属地待查询', ready: '已识别', not_found: '暂无归属地数据', non_public: '非公网地址', error: '归属地查询失败',
};

export function GeoInfo({ geo, labels = [], detailed = false }: { geo?: GeoIpInfo | null; labels?: string[]; detailed?: boolean }) {
  if (!geo) return null;
  const title = [geo.asName, geo.asDomain, geo.databaseVersion && `数据库 ${geo.databaseVersion}`, geo.lookedUpAt && `查询 ${geo.lookedUpAt}`, 'IPinfo Lite'].filter(Boolean).join(' · ');
  const badges = geoBadges(geo, labels);
  return <div className="flex flex-col gap-1" aria-label="自动归属地与 ASN" title={title}>
    <div className="flex flex-wrap gap-1">
      {geo.status === 'ready' ? badges.map((item) => <Badge key={item.text} variant="outline" title={item.title}>{item.text}</Badge>) : <span className="text-xs text-muted-foreground">{STATUS_TEXT[geo.status]}</span>}
      {geo.status === 'ready' && !badges.length && !detailed && <span className="text-xs text-muted-foreground">{[geoCountry(geo), geo.asName].filter(Boolean).join(' · ')}</span>}
      {geo.stale && <Badge tone="warning">待刷新</Badge>}
    </div>
    {detailed && <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {geo.status === 'ready' && <span>{[geoCountry(geo), geo.asn, geo.asName, geo.asDomain].filter(Boolean).join(' · ') || '暂无归属地数据'}</span>}
      <span>来源：<a className="underline underline-offset-4" href="https://ipinfo.io/" target="_blank" rel="noreferrer">IPinfo Lite</a> · 数据库 {geo.databaseVersion || '—'} · 查询时间 {geo.lookedUpAt || '—'}</span>
    </div>}
  </div>;
}
