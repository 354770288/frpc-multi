import { describe, expect, it } from 'vitest';
import { parseServerQuery, serverQuerySignature, writeServerQueryParams } from './useServers';

describe('useServers URL state authority', () => {
  it('produces identical query signature before and after initial default URL normalization', () => {
    const raw = new URLSearchParams('nodeId=remote&pageSize=25');
    const parsedBefore = parseServerQuery(raw.toString());
    const normalized = writeServerQueryParams(raw, parsedBefore);
    const parsedAfter = parseServerQuery(normalized.toString());

    expect(normalized.get('nodeId')).toBe('remote');
    expect(normalized.get('pageSize')).toBe('25');
    expect(normalized.get('page')).toBe('1');
    expect(serverQuerySignature(parsedBefore)).toBe(serverQuerySignature(parsedAfter));
  });

  it('round-trips cursor navigation and immediately reflects popstate back/forward URL transitions', () => {
    const page1Params = writeServerQueryParams(new URLSearchParams('nodeId=remote&pageSize=25'), parseServerQuery('nodeId=remote&pageSize=25'));
    const page2Params = writeServerQueryParams(page1Params, {
      ...parseServerQuery(page1Params.toString()),
      page: 2,
      cursor: 'cursor-page2',
    });

    expect(page2Params.get('cursor')).toBe('cursor-page2');
    expect(page2Params.get('page')).toBe('2');

    const restoredBack = parseServerQuery(page1Params.toString());
    const restoredForward = parseServerQuery(page2Params.toString());
    expect(restoredBack).toMatchObject({ page: 1, pageSize: 25 });
    expect(restoredBack.cursor).toBeUndefined();
    expect(restoredForward).toMatchObject({ page: 2, cursor: 'cursor-page2', pageSize: 25 });
    expect(serverQuerySignature(restoredBack)).not.toBe(serverQuerySignature(restoredForward));
  });

  it('preserves empty-string group and label filters distinct from omitted filters', () => {
    const ungrouped = parseServerQuery('group=&label=');
    expect(ungrouped.group).toBe('');
    expect(ungrouped.label).toBe('');

    const written = writeServerQueryParams(new URLSearchParams(), ungrouped);
    expect(written.has('group')).toBe(true);
    expect(written.get('group')).toBe('');
    expect(written.has('label')).toBe(true);
    expect(written.get('label')).toBe('');

    const cleared = writeServerQueryParams(written, { ...ungrouped, group: undefined, label: undefined });
    expect(cleared.has('group')).toBe(false);
    expect(cleared.has('label')).toBe(false);
  });

  it('round-trips domainStatus filter only when non-default', () => {
    const unassigned = parseServerQuery('domainStatus=unassigned');
    expect(unassigned.domainStatus).toBe('unassigned');
    const params = writeServerQueryParams(new URLSearchParams(), unassigned);
    expect(params.get('domainStatus')).toBe('unassigned');

    const reset = writeServerQueryParams(params, { ...unassigned, domainStatus: undefined });
    expect(reset.has('domainStatus')).toBe(false);
  });
});
