import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { probeApi } from '../../lib/api';
import type {
  DiscoverOrder,
  ServerConn,
  ServerDomainStatus,
  ServerPage,
  ServerQuery,
  ServerSort,
  ServerFacets,
} from '../../lib/types';

const EMPTY_PAGE: ServerPage = {
  items: [], page: 1, pageSize: 50, total: 0, sort: 'ip', order: 'asc',
};
const EMPTY_FACETS: ServerFacets = { labels: [], tagItems: [], groups: [] };
const TAG_CANDIDATE_PAGE_SIZE = 50;
const MANAGED_URL_KEYS = [
  'page', 'pageSize', 'conn', 'domainStatus', 'sort', 'order', 'q', 'group', 'label',
  'tagId', 'cursor', 'groupIds', 'includeTagIds', 'excludeTagIds', 'tagMode',
] as const;

export function parseServerQuery(search: string): ServerQuery {
  const params = new URLSearchParams(search);
  const pageSize = Number(params.get('pageSize'));
  const sort = params.get('sort');
  const order = params.get('order');
  const conn = params.get('conn');
  const domainStatus = params.get('domainStatus');
  const list = (key: string) => (params.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    page: Math.max(1, Number(params.get('page')) || 1),
    pageSize: [25, 50, 100, 200].includes(pageSize) ? pageSize : 50,
    conn: conn === 'pass' || conn === 'partial' || conn === 'fail' || conn === 'untested' ? conn : 'all',
    ...(domainStatus === 'assigned' || domainStatus === 'unassigned' ? { domainStatus } : {}),
    sort: sort === 'group' || sort === 'conn' || sort === 'speed' || sort === 'time' ? sort : 'ip',
    order: order === 'desc' ? 'desc' : 'asc',
    ...(params.has('q') ? { q: params.get('q') || '' } : {}),
    ...(params.has('group') ? { group: params.get('group') || '' } : {}),
    ...(params.has('label') ? { label: params.get('label') || '' } : {}),
    ...(params.has('tagId') ? { tagId: params.get('tagId') || '' } : {}),
    ...(params.has('cursor') ? { cursor: params.get('cursor') || undefined } : {}),
    ...(list('groupIds').length ? { groupIds: list('groupIds') } : {}),
    ...(list('includeTagIds').length ? { includeTagIds: list('includeTagIds') } : {}),
    ...(list('excludeTagIds').length ? { excludeTagIds: list('excludeTagIds') } : {}),
    ...(params.has('tagMode') ? { tagMode: params.get('tagMode') === 'all' ? 'all' as const : 'any' as const } : {}),
  };
}

export function writeServerQueryParams(current: URLSearchParams, query: ServerQuery): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of MANAGED_URL_KEYS) next.delete(key);
  next.set('page', String(query.page));
  next.set('pageSize', String(query.pageSize));
  next.set('conn', query.conn);
  if (query.domainStatus && query.domainStatus !== 'all') next.set('domainStatus', query.domainStatus);
  next.set('sort', query.sort);
  next.set('order', query.order);
  if (query.q !== undefined) next.set('q', query.q);
  if (query.group !== undefined) next.set('group', query.group);
  if (query.label !== undefined) next.set('label', query.label);
  if (query.tagId !== undefined) next.set('tagId', query.tagId);
  if (query.cursor) next.set('cursor', query.cursor);
  if (query.groupIds?.length) next.set('groupIds', query.groupIds.join(','));
  if (query.includeTagIds?.length) next.set('includeTagIds', query.includeTagIds.join(','));
  if (query.excludeTagIds?.length) next.set('excludeTagIds', query.excludeTagIds.join(','));
  if (query.tagMode) next.set('tagMode', query.tagMode);
  return next;
}

export function serverQuerySignature(query: ServerQuery): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function cursorStorageKey(query: ServerQuery) {
  return `probe_servers_cursor:${JSON.stringify({
    q: query.q ?? '',
    group: query.group,
    groupIds: query.groupIds,
    label: query.label,
    tagId: query.tagId,
    includeTagIds: query.includeTagIds,
    excludeTagIds: query.excludeTagIds,
    tagMode: query.tagMode ?? 'any',
    conn: query.conn,
    domainStatus: query.domainStatus,
    sort: query.sort,
    order: query.order,
    pageSize: query.pageSize,
  })}`;
}

function countKeyFor(query: ServerQuery) {
  return JSON.stringify({
    q: query.q,
    group: query.group,
    groupIds: query.groupIds,
    label: query.label,
    tagId: query.tagId,
    includeTagIds: query.includeTagIds,
    excludeTagIds: query.excludeTagIds,
    tagMode: query.tagMode,
    conn: query.conn,
    domainStatus: query.domainStatus,
    sort: query.sort,
  });
}

function facetKeyFor(query: ServerQuery) {
  return JSON.stringify({
    q: query.q,
    group: query.group,
    groupIds: query.groupIds,
    label: query.label,
    tagId: query.tagId,
    includeTagIds: query.includeTagIds,
    excludeTagIds: query.excludeTagIds,
    tagMode: query.tagMode,
    conn: query.conn,
    domainStatus: query.domainStatus,
  });
}

function facetRequestKeyFor(query: ServerQuery, tagSearch: string, tagPage: number) {
  return JSON.stringify({ filters: facetKeyFor(query), tagSearch, tagPage, tagPageSize: TAG_CANDIDATE_PAGE_SIZE });
}

function loadCursorTrail(key: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) && saved.every((value) => typeof value === 'string') && saved.length ? saved as string[] : [''];
  } catch {
    return [''];
  }
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

type PageRefreshOptions = { recoverOutOfRange?: boolean };

export function useServers(active = true) {
  const [searchParams, setUrl] = useSearchParams();
  const setUrlRef = useRef(setUrl);
  setUrlRef.current = setUrl;
  const rawUrlKey = searchParams.toString();
  const rawUrlKeyRef = useRef(rawUrlKey);
  rawUrlKeyRef.current = rawUrlKey;
  const latestUrlKeyRef = useRef(rawUrlKey);
  const pushedInTickRef = useRef<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<{ fromUrlKey: string; nextUrlKey: string } | null>(null);
  const urlKey = pendingUrl && pendingUrl.fromUrlKey === rawUrlKey ? pendingUrl.nextUrlKey : rawUrlKey;
  if (!pendingUrl || pendingUrl.fromUrlKey !== rawUrlKey) {
    latestUrlKeyRef.current = rawUrlKey;
    pushedInTickRef.current = null;
  }
  // URL searchParams 是查询状态的权威来源；pendingUrl 仅弥合受控表单事件同帧同步渲染，popstate 时立即释放
  const query = useMemo(() => parseServerQuery(urlKey), [urlKey]);
  const querySig = useMemo(() => serverQuerySignature(query), [query]);

  const [tagSearch, setTagSearchText] = useState('');
  const [tagPage, setTagPage] = useState(1);
  const cursorMode = query.sort === 'ip';
  const countFilterKey = countKeyFor(query);
  const facetFilterKey = facetKeyFor(query);
  const cursorKey = useMemo(() => cursorStorageKey(query), [
    query.q, query.group, query.groupIds, query.label, query.tagId,
    query.includeTagIds, query.excludeTagIds, query.tagMode, query.conn, query.domainStatus,
    query.sort, query.order, query.pageSize,
  ]);
  const [cursorTrail, setCursorTrail] = useState<string[]>(() => loadCursorTrail(cursorStorageKey(query)));
  const cursorTrailRef = useRef(cursorTrail);
  cursorTrailRef.current = cursorTrail;
  const [cursorPage, setCursorPage] = useState<{ nextCursor: string | null; hasMore: boolean }>({ nextCursor: null, hasMore: false });
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const totalCountRef = useRef<number | null>(null);
  totalCountRef.current = totalCount;
  const [totalCountKey, setTotalCountKey] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [countLoading, setCountLoading] = useState(true);
  const [countError, setCountError] = useState<string | null>(null);
  const [countErrorKey, setCountErrorKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (pendingUrl && rawUrlKey !== pendingUrl.fromUrlKey) {
      setPendingUrl(null);
    }
  }, [pendingUrl, rawUrlKey]);

  useEffect(() => {
    const onPopState = () => {
      latestUrlKeyRef.current = new URLSearchParams(window.location.search).toString();
      setPendingUrl(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 初始进入若缺少规范化的默认查询参数，以 replace 补齐到 URL（querySig 不变，不触发额外请求）
  useEffect(() => {
    if (!active) return;
    const currentParams = new URLSearchParams(latestUrlKeyRef.current);
    const normalized = writeServerQueryParams(currentParams, parseServerQuery(currentParams.toString()));
    if (normalized.toString() !== currentParams.toString()) {
      latestUrlKeyRef.current = normalized.toString();
      setUrlRef.current(normalized, { replace: true });
    }
  }, [active, rawUrlKey]);

  useEffect(() => {
    const next = loadCursorTrail(cursorKey);
    setCursorTrail(next);
    cursorTrailRef.current = next;
  }, [cursorKey]);

  const commitQuery = useCallback((updater: (current: ServerQuery) => ServerQuery, pushHistory: boolean) => {
    if (!active) return;
    const baseParams = new URLSearchParams(latestUrlKeyRef.current);
    const currentQuery = parseServerQuery(baseParams.toString());
    const nextQuery = updater(currentQuery);
    const nextParams = writeServerQueryParams(baseParams, nextQuery);
    const nextSearch = nextParams.toString();
    if (nextSearch === latestUrlKeyRef.current) return;
    const alreadyPushed = pushedInTickRef.current === rawUrlKeyRef.current;
    const shouldPush = pushHistory && !alreadyPushed;
    if (shouldPush) pushedInTickRef.current = rawUrlKeyRef.current;
    latestUrlKeyRef.current = nextSearch;
    setPendingUrl({ fromUrlKey: rawUrlKeyRef.current, nextUrlKey: nextSearch });
    setUrlRef.current(nextParams, { replace: !shouldPush });
  }, [active]);

  const queryRef = useRef(query);
  queryRef.current = query;
  const tagSearchRef = useRef(tagSearch);
  tagSearchRef.current = tagSearch;
  const tagPageRef = useRef(tagPage);
  tagPageRef.current = tagPage;
  const facetRequestKey = facetRequestKeyFor(query, tagSearch, tagPage);
  const facetRequestKeyRef = useRef(facetRequestKey);
  facetRequestKeyRef.current = facetRequestKey;
  const priorFacetFilterKey = useRef(facetFilterKey);
  useLayoutEffect(() => {
    if (priorFacetFilterKey.current === facetFilterKey) return;
    priorFacetFilterKey.current = facetFilterKey;
    setTagPage(1);
  }, [facetFilterKey]);

  const [page, setPage] = useState<ServerPage>(EMPTY_PAGE);
  const [facets, setFacets] = useState<ServerFacets>(EMPTY_FACETS);
  const [facetDataKey, setFacetDataKey] = useState<string | null>(null);
  const [facetRequestDataKey, setFacetRequestDataKey] = useState<string | null>(null);
  const [facetLoading, setFacetLoading] = useState(false);
  const [facetError, setFacetError] = useState<string | null>(null);
  const [facetErrorKey, setFacetErrorKey] = useState<string | null>(null);
  // 跨页勾选：id → ip（一键测试需要 IP 列表，跨页后不能只靠当前页推导）
  const [selected, setSelected] = useState<Map<number, string>>(() => {
    try { return new Map(JSON.parse(sessionStorage.getItem('probe_selected_servers') || '[]') as [number, string][]); }
    catch { return new Map(); }
  });
  useEffect(() => {
    sessionStorage.setItem('probe_selected_servers', JSON.stringify([...selected]));
    sessionStorage.setItem('probe_selected_endpoints', JSON.stringify([...selected.values()]));
  }, [selected]);

  const pageController = useRef<AbortController | null>(null);
  const facetController = useRef<AbortController | null>(null);
  const countController = useRef<AbortController | null>(null);
  const pageGeneration = useRef(0);
  const facetGeneration = useRef(0);
  const countGeneration = useRef(0);

  const isVisible = useCallback(
    () => active && document.visibilityState === 'visible',
    [active],
  );

  const refreshPage = useCallback(async (options: PageRefreshOptions = {}) => {
    if (!isVisible()) return;
    pageController.current?.abort();
    const controller = new AbortController();
    pageController.current = controller;
    const generation = ++pageGeneration.current;
    const requested = queryRef.current;
    setPageLoading(true);
    setPageError(null);
    try {
      if (requested.sort === 'ip') {
        const next = await probeApi.serversCursor(requested, controller.signal);
        if (controller.signal.aborted || generation !== pageGeneration.current) return;
        setPage({
          items: next.items,
          page: requested.page,
          pageSize: requested.pageSize,
          total: totalCountRef.current ?? 0,
          sort: requested.sort,
          order: requested.order,
        });
        setCursorPage({ nextCursor: next.nextCursor, hasMore: next.hasMore });
        return;
      }
      const next = await probeApi.servers(requested, controller.signal);
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (options.recoverOutOfRange && requested.page > lastPage) {
        commitQuery((current) => ({ ...current, page: lastPage }), false);
        return;
      }
      setPage(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === pageGeneration.current) {
        setPageError(requestErrorMessage(error));
      }
    } finally {
      if (generation === pageGeneration.current) setPageLoading(false);
    }
  }, [commitQuery, isVisible]);

  const refreshCount = useCallback(async () => {
    if (!isVisible() || queryRef.current.sort !== 'ip') return;
    const requestedQuery = queryRef.current;
    const requestedCountKey = countKeyFor(requestedQuery);
    countController.current?.abort();
    const controller = new AbortController();
    countController.current = controller;
    const generation = ++countGeneration.current;
    setCountLoading(true);
    setCountError(null);
    setCountErrorKey(null);
    try {
      const result = await probeApi.serverCount(requestedQuery, controller.signal);
      if (!controller.signal.aborted && generation === countGeneration.current) {
        setTotalCount(result.total);
        totalCountRef.current = result.total;
        setTotalCountKey(requestedCountKey);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === countGeneration.current) {
        setCountError(requestErrorMessage(error));
        setCountErrorKey(requestedCountKey);
      }
    } finally {
      if (generation === countGeneration.current) setCountLoading(false);
    }
  }, [isVisible]);

  const refreshFacets = useCallback(async () => {
    if (!isVisible()) return;
    const requested = queryRef.current;
    const requestedKey = facetKeyFor(requested);
    const requestedTagSearch = tagSearchRef.current;
    const requestedTagPage = tagPageRef.current;
    const requestedRequestKey = facetRequestKeyFor(requested, requestedTagSearch, requestedTagPage);
    facetController.current?.abort();
    const controller = new AbortController();
    facetController.current = controller;
    const generation = ++facetGeneration.current;
    setFacetLoading(true);
    setFacetError(null);
    setFacetErrorKey(null);
    try {
      const next = await probeApi.serverFacets(requested, controller.signal, {
        tagSearch: requestedTagSearch, tagPage: requestedTagPage, tagPageSize: TAG_CANDIDATE_PAGE_SIZE,
      });
      if (!controller.signal.aborted && generation === facetGeneration.current && requestedRequestKey === facetRequestKeyRef.current) {
        setFacets(next);
        setFacetDataKey(requestedKey);
        setFacetRequestDataKey(requestedRequestKey);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === facetGeneration.current && requestedRequestKey === facetRequestKeyRef.current) {
        setFacetError(requestErrorMessage(error));
        setFacetErrorKey(requestedRequestKey);
      }
    } finally {
      if (generation === facetGeneration.current) setFacetLoading(false);
    }
  }, [isVisible]);

  const refreshAll = useCallback(async (options: PageRefreshOptions = {}) => {
    await Promise.all([refreshPage(options), refreshFacets(), refreshCount()]);
  }, [refreshCount, refreshFacets, refreshPage]);

  useEffect(() => {
    if (!isVisible()) return;
    void refreshPage().catch(() => {});
  }, [active, querySig, isVisible, refreshPage]);

  useEffect(() => {
    if (!isVisible()) return;
    void refreshFacets().catch(() => {});
  }, [active, facetRequestKey, isVisible, refreshFacets]);

  useEffect(() => {
    if (isVisible() && query.sort === 'ip') void refreshCount().catch(() => {});
  }, [active, countFilterKey, isVisible, query.sort, refreshCount]);

  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  // 服务器库轮询：仅激活且页面可见时 10s 一拍；仅在停用或卸载时中止在途请求
  useEffect(() => {
    if (!active) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        pageController.current?.abort();
        facetController.current?.abort();
        countController.current?.abort();
        return;
      }
      void refreshAllRef.current().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAllRef.current().catch(() => {});
    }, 10000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      pageController.current?.abort();
      facetController.current?.abort();
      countController.current?.abort();
    };
  }, [active]);

  const updateQuery = useCallback((changes: Partial<ServerQuery>, resetPage = true) => {
    if (resetPage) setTagPage(1);
    commitQuery((current) => ({
      ...current,
      ...changes,
      ...(resetPage && !Object.prototype.hasOwnProperty.call(changes, 'cursor') ? { cursor: undefined } : {}),
      page: resetPage ? 1 : (changes.page ?? current.page),
    }), resetPage);
  }, [commitQuery]);

  const setSearch = useCallback((q: string) => {
    if ((queryRef.current.q ?? '') === q) return;
    updateQuery({ q });
  }, [updateQuery]);
  const setGroup = useCallback((group: string) => updateQuery({ group: group === 'all' ? undefined : group, groupIds: undefined }), [updateQuery]);
  const setGroupIds = useCallback((ids: string[]) => updateQuery({ group: undefined, groupIds: [...new Set(ids)] }), [updateQuery]);
  // null = 取消筛选；'' = 筛「无标签」行，二者不可混淆
  const setLabel = useCallback((label: string | null) => updateQuery({ label: label === null ? undefined : label }), [updateQuery]);
  const setTagId = useCallback((tagId: string | null) => updateQuery({
    tagId: tagId === null ? undefined : tagId,
    label: undefined,
    ...(tagId ? {
      includeTagIds: undefined,
      excludeTagIds: (queryRef.current.excludeTagIds ?? []).filter((id) => id !== tagId),
    } : {}),
  }), [updateQuery]);
  const setIncludeTagIds = useCallback((ids: string[]) => updateQuery({ tagId: undefined, label: undefined, includeTagIds: [...new Set(ids)] }), [updateQuery]);
  const setExcludeTagIds = useCallback((ids: string[]) => updateQuery({ excludeTagIds: [...new Set(ids)] }), [updateQuery]);
  const setTagMode = useCallback((tagMode: 'any' | 'all') => updateQuery({ tagMode }), [updateQuery]);
  const setTagCandidateSearch = useCallback((value: string) => {
    setTagSearchText(value);
    setTagPage(1);
  }, []);
  const setTagCandidatePage = useCallback((value: number) => {
    setTagPage(Math.max(1, Math.floor(value)));
  }, []);
  const setConn = useCallback((conn: ServerConn) => updateQuery({ conn }), [updateQuery]);
  const setDomainStatus = useCallback((domainStatus: ServerDomainStatus) => updateQuery({ domainStatus: domainStatus === 'all' ? undefined : domainStatus }), [updateQuery]);
  const setSort = useCallback((sort: ServerSort, order: DiscoverOrder) => updateQuery({ sort, order }), [updateQuery]);
  const applySavedView = useCallback((changes: Partial<ServerQuery>) => {
    setTagPage(1);
    commitQuery((current) => ({ ...current, domainStatus: undefined, ...changes, page: 1, cursor: undefined }), true);
  }, [commitQuery]);
  const setPageNumber = useCallback((nextPage: number) => updateQuery({ page: nextPage }, false), [updateQuery]);
  const setPageSize = useCallback((pageSize: number) => updateQuery({ pageSize }), [updateQuery]);
  const cursorIndex = Math.max(0, cursorTrail.lastIndexOf(query.cursor ?? ''));
  const navigateCursor = useCallback((direction: 'next' | 'previous') => {
    const current = queryRef.current;
    const trail = cursorTrailRef.current;
    const index = Math.max(0, trail.lastIndexOf(current.cursor ?? ''));
    let nextTrail: string[];
    let nextCursor: string | undefined;
    let nextPage: number;
    if (direction === 'next' && cursorPage.hasMore && cursorPage.nextCursor) {
      nextTrail = [...trail.slice(0, index + 1), cursorPage.nextCursor];
      nextCursor = cursorPage.nextCursor;
      nextPage = current.page + 1;
    } else if (direction === 'previous' && index > 0) {
      nextTrail = trail.slice(0, index);
      nextCursor = nextTrail[nextTrail.length - 1] || undefined;
      nextPage = Math.max(1, current.page - 1);
    } else {
      return;
    }
    cursorTrailRef.current = nextTrail;
    setCursorTrail(nextTrail);
    sessionStorage.setItem(cursorKey, JSON.stringify(nextTrail));
    commitQuery((value) => ({ ...value, page: nextPage, cursor: nextCursor }), true);
  }, [commitQuery, cursorKey, cursorPage.hasMore, cursorPage.nextCursor]);

  const toggleSelected = useCallback((id: number, ip: string) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else next.set(id, ip);
      return next;
    });
  }, []);

  const toggleCurrentPage = useCallback((checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      for (const item of page.items) {
        if (checked) next.set(item.id, item.ip);
        else next.delete(item.id);
      }
      return next;
    });
  }, [page.items]);

  const removeSelected = useCallback((ids: number[]) => {
    const removed = new Set(ids);
    setSelected((current) => {
      const next = new Map([...current].filter(([id]) => !removed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, []);

  return {
    query,
    page,
    facets,
    facetsCurrent: facetDataKey === facetFilterKey,
    tagCandidatesCurrent: facetRequestDataKey === facetRequestKey,
    facetsLoading: facetLoading,
    facetsError: facetErrorKey === facetRequestKey ? facetError : null,
    tagSearch,
    tagPage,
    tagPageSize: TAG_CANDIDATE_PAGE_SIZE,
    tagTotal: facetRequestDataKey === facetRequestKey ? facets.tagTotal ?? null : null,
    totalCount: cursorMode ? (totalCountKey === countFilterKey ? totalCount : null) : page.total,
    pageLoading,
    pageError,
    countLoading: cursorMode && countLoading,
    countError: cursorMode && countErrorKey === countFilterKey ? countError : null,
    cursorMode,
    cursorHasMore: cursorPage.hasMore,
    cursorCanPrevious: cursorIndex > 0,
    nextCursorPage: () => navigateCursor('next'),
    previousCursorPage: () => navigateCursor('previous'),
    selected,
    setSelected,
    setSearch,
    setGroup,
    setGroupIds,
    setLabel,
    setTagId,
    setIncludeTagIds,
    setExcludeTagIds,
    setTagMode,
    setTagCandidateSearch,
    setTagCandidatePage,
    setConn,
    setDomainStatus,
    setSort,
    applySavedView,
    setPageNumber,
    setPageSize,
    toggleSelected,
    toggleCurrentPage,
    removeSelected,
    refreshPage,
    refreshCount,
    refreshFacets,
    refreshAll,
  };
}
