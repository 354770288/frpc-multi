import { describe, expect, it } from 'vitest';
import type { ServerQuery, ServerView } from '../../lib/types';
import { queryFromSavedView, savedViewPayload, serverViewDraftSignature } from './serverViews';

const query: ServerQuery = {
  page: 4, pageSize: 100, cursor: 'cursor-secret', q: 'edge', conn: 'pass', sort: 'group', order: 'desc',
  groupIds: ['group-stable-id'], includeTagIds: ['tag-include'], excludeTagIds: ['tag-exclude'], tagMode: 'all',
};

describe('saved server views', () => {
  it('stores stable filters, sort, and visible columns without paging state', () => {
    const saved = savedViewPayload(query, ['ip', 'tags', 'speed']);
    expect(saved.filters).toEqual({
      q: 'edge', group: undefined, label: undefined, tagId: undefined,
      groupIds: ['group-stable-id'], includeTagIds: ['tag-include'], excludeTagIds: ['tag-exclude'],
      tagMode: 'all', conn: 'pass',
    });
    expect(saved.sort).toBe('group');
    expect(saved.order).toBe('desc');
    expect(saved.visibleColumns).toEqual(['ip', 'tags', 'speed']);
    expect(JSON.stringify(saved)).not.toMatch(/page|cursor|selection/i);
  });

  it('restores saved filters and sorting without introducing page or selection state', () => {
    const view = {
      id: 'view-id', name: 'Edge', ...savedViewPayload(query, ['group', 'connectivity']),
      createdAt: 'now', updatedAt: 'now',
    } satisfies ServerView;
    expect(queryFromSavedView(view)).toEqual({
      q: 'edge', group: undefined, label: undefined, tagId: undefined,
      groupIds: ['group-stable-id'], includeTagIds: ['tag-include'], excludeTagIds: ['tag-exclude'],
      tagMode: 'all', conn: 'pass', sort: 'group', order: 'desc',
    });
  });

  it('changes the draft signature when search, query, or visible columns change', () => {
    const base = serverViewDraftSignature(query, 'edge', ['ip', 'group']);
    expect(serverViewDraftSignature({ ...query, page: 1, cursor: undefined, pageSize: 25 }, 'edge', ['ip', 'group'])).toBe(base);
    expect(serverViewDraftSignature(query, 'new-search', ['ip', 'group'])).not.toBe(base);
    expect(serverViewDraftSignature({ ...query, sort: 'conn' }, 'edge', ['ip', 'group'])).not.toBe(base);
    expect(serverViewDraftSignature(query, 'edge', ['ip'])).not.toBe(base);
  });
});
