import type { ServerQuery, ServerView, ServerViewColumn } from '../../lib/types';

export const SERVER_VIEW_COLUMNS: { id: ServerViewColumn; label: string }[] = [
  { id: 'ip', label: '服务器' },
  { id: 'group', label: '分组' },
  { id: 'tags', label: '标签' },
  { id: 'route', label: '路由' },
  { id: 'connectivity', label: '连通性' },
  { id: 'speed', label: '速率' },
  { id: 'lastTestTime', label: '测速时间' },
];

export function savedViewPayload(query: ServerQuery, visibleColumns: ServerViewColumn[]) {
  const { q = '', group, label, tagId, groupIds = [], includeTagIds = [], excludeTagIds = [], tagMode = 'any', conn } = query;
  return {
    filters: { q, group, label, tagId, groupIds: [...groupIds], includeTagIds: [...includeTagIds], excludeTagIds: [...excludeTagIds], tagMode, conn },
    sort: query.sort,
    order: query.order,
    visibleColumns: [...visibleColumns],
  };
}

export function queryFromSavedView(view: ServerView): Partial<ServerQuery> {
  const filters = view.filters ?? {};
  return {
    q: filters.q ?? '',
    group: filters.group,
    label: filters.label,
    tagId: filters.tagId,
    groupIds: filters.groupIds ?? [],
    includeTagIds: filters.includeTagIds ?? [],
    excludeTagIds: filters.excludeTagIds ?? [],
    tagMode: filters.tagMode ?? 'any',
    conn: filters.conn ?? 'all',
    sort: view.sort,
    order: view.order,
  };
}

export function serverViewDraftSignature(query: ServerQuery, search: string, visibleColumns: ServerViewColumn[]): string {
  const filters = {
    q: search,
    group: query.group,
    label: query.label,
    tagId: query.tagId,
    groupIds: query.groupIds ?? [],
    includeTagIds: query.includeTagIds ?? [],
    excludeTagIds: query.excludeTagIds ?? [],
    tagMode: query.tagMode ?? 'any',
    conn: query.conn,
  };
  return JSON.stringify({ filters, sort: query.sort, order: query.order, visibleColumns });
}

