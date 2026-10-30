import type { GeoIpInfo, GeoIpStatus, ManagedTag, TagCategory } from './types';

export function isReadOnlyTag(item: { readOnly?: boolean; source?: 'manual' | 'geoip' }, categories: TagCategory[] = [], categoryId?: string) {
  return item.readOnly === true || item.source === 'geoip' || categories.some((category) => category.id === categoryId && (category.readOnly === true || category.source === 'geoip'));
}

export function editableTags(tags: ManagedTag[], categories: TagCategory[]) {
  return tags.filter((tag) => !isReadOnlyTag(tag, categories, tag.categoryId));
}

export function geoCountry(geo: GeoIpInfo) {
  if (!geo.countryCode) return geo.country;
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(geo.countryCode) || geo.country || geo.countryCode; }
  catch { return geo.country || geo.countryCode; }
}

export function geoBadges(geo: GeoIpInfo, labels: string[] = []) {
  const existing = new Set(labels);
  return [
    geo.countryCode && !existing.has(geo.countryCode) && !existing.has(`自动归属地 / ${geo.countryCode}`) && !existing.has(`自动归属地:${geo.countryCode}`) ? { text: `${geoCountry(geo)} (${geo.countryCode})`, title: '自动归属地 · IPinfo Lite' } : null,
    geo.asn && !existing.has(geo.asn) && !existing.has(`自动 ASN / ${geo.asn}`) && !existing.has(`自动 ASN:${geo.asn}`) ? { text: geo.asn, title: [geo.asName, geo.asDomain, 'IPinfo Lite'].filter(Boolean).join(' · ') } : null,
  ].filter((item): item is { text: string; title: string } => !!item);
}

export function geoDatabaseAge(status: Pick<GeoIpStatus, 'buildEpoch' | 'updatedAt'>, now = Date.now()) {
  const timestamp = status.buildEpoch ? status.buildEpoch * 1000 : status.updatedAt ? Date.parse(status.updatedAt) : NaN;
  return Number.isFinite(timestamp) ? `${Math.max(0, Math.floor((now - timestamp) / 86400000))} 天` : '—';
}

export function manualGeoLabels(labels: string[], manualLabels?: string[]) {
  // Identical names can belong to both manual and automatic categories.
  // Source identity comes from the server, never from country/ASN text.
  return manualLabels ?? labels;
}

export function readOnlyTagNames(tags: ManagedTag[], categories: TagCategory[]) {
  const manualNames = new Set(editableTags(tags, categories).map((tag) => tag.name));
  return new Set(tags.filter((tag) => isReadOnlyTag(tag, categories, tag.categoryId) && !manualNames.has(tag.name)).map((tag) => tag.name));
}
