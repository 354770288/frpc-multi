import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { editableTags, geoBadges, geoDatabaseAge, isReadOnlyTag, manualGeoLabels, readOnlyTagNames } from './geoip';
import type { GeoIpInfo, ManagedTag, TagCategory } from './types';
import { GeoInfo } from '../pages/probe/GeoInfo';

const geo: GeoIpInfo = { status: 'ready', countryCode: 'US', country: 'United States', asn: 'AS15169', asName: 'Google LLC', asDomain: 'google.com', source: 'ipinfo_lite', databaseVersion: '2026-10', lookedUpAt: '2026-10-30T00:00:00Z', stale: false };
const categories: TagCategory[] = [{ id: 'manual', name: '用途' }, { id: 'geo', name: '自动归属地', readOnly: true }];
const tags: ManagedTag[] = [
  { id: 'production', categoryId: 'manual', category: '用途', name: '生产', serverCount: 1 },
  { id: 'country', categoryId: 'geo', category: '自动归属地', name: 'US', serverCount: 1 },
  { id: 'asn', categoryId: 'manual', category: 'ASN', name: 'AS15169', source: 'geoip', serverCount: 1 },
];

describe('IPinfo presentation and editable tag boundaries', () => {
  it('protects source-tagged and category-inherited automatic tags while keeping manual tags editable', () => {
    expect(isReadOnlyTag({ readOnly: true })).toBe(true);
    expect(editableTags(tags, categories).map((item) => item.id)).toEqual(['production']);
    expect([...readOnlyTagNames(tags, categories)]).toEqual(['US', 'AS15169']);
    expect(manualGeoLabels(['US', 'AS15169', '生产'], ['生产'])).toEqual(['生产']);
    expect(manualGeoLabels(['US', 'AS15169', '生产'], ['US', '生产'])).toEqual(['US', '生产']);
    expect(manualGeoLabels(['生产'])).toEqual(['生产']);
    const collidingManualTag = { ...tags[0], id: 'manual-country', name: 'US' };
    expect([...readOnlyTagNames([...tags, collidingManualTag], categories)]).toEqual(['AS15169']);
  });

  it('does not duplicate automatic country or ASN badges already shown as row tags', () => {
    expect(geoBadges(geo).map((item) => item.text)).toEqual(['美国 (US)', 'AS15169']);
    expect(geoBadges(geo, ['US', 'AS15169'])).toEqual([]);
    const markup = renderToStaticMarkup(<GeoInfo geo={geo} labels={['US', 'AS15169']} />);
    expect(markup).toContain('Google LLC');
    expect(markup).not.toContain('data-slot="badge"');
  });

  it.each([['pending', '归属地待查询'], ['not_found', '暂无归属地数据'], ['non_public', '非公网地址'], ['error', '归属地查询失败']] as const)('shows %s independently from test status', (status, text) => {
    expect(renderToStaticMarkup(<GeoInfo geo={{ ...geo, status }} />)).toContain(text);
  });

  it('exposes stale provenance and provider attribution in server details', () => {
    const markup = renderToStaticMarkup(<GeoInfo geo={{ ...geo, stale: true }} detailed />);
    expect(markup).toContain('待刷新');
    expect(markup).toContain('2026-10');
    expect(markup).toContain('href="https://ipinfo.io/"');
    expect(renderToStaticMarkup(<GeoInfo />)).toBe('');
  });

  it('measures data age from the database build and handles missing timestamps', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    expect(geoDatabaseAge({ buildEpoch: Date.parse('2026-10-20T00:00:00Z') / 1000, updatedAt: '2026-10-29T00:00:00Z' }, now)).toBe('10 天');
    expect(geoDatabaseAge({ buildEpoch: null, updatedAt: null }, now)).toBe('—');
  });
});
