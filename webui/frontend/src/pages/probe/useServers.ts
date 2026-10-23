import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { probeApi } from '../../lib/api';
import type {
  DiscoverOrder,
  ServerConn,
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

function parseQuery(search: string): ServerQuery {
  const params = new URLSearchParams(search);
  const pageSize = Number(params.get('pageSize'));
  const sort = params.get('sort'); const order = params.get('order'); const conn = params.get('conn');
  const list = (key: string) => (params.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    page: Math.max(1, Number(params.get('page')) || 1),
    pageSize: [25, 50, 100, 200].includes(pageSize) ? pageSize : 50,
    conn: conn === 'pass' || conn === 'partial' || conn === 'fail' || conn === 'untested' ? conn : 'all',
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

function cursorStorageKey(query: ServerQuery) {
  return `probe_servers_cursor:${JSON.stringify({ q: query.q ?? '', group: query.group, groupIds: query.groupIds, label: query.label, tagId: query.tagId, includeTagIds: query.includeTagIds, excludeTagIds: query.excludeTagIds, tagMode: query.tagMode ?? 'any', conn: query.conn, sort: query.sort, order: query.order, pageSize: query.pageSize })}`;
}

function countKeyFor(query: ServerQuery) {
  return JSON.stringify({ q: query.q, group: query.group, groupIds: query.groupIds, label: query.label, tagId: query.tagId, includeTagIds: query.includeTagIds, excludeTagIds: query.excludeTagIds, tagMode: query.tagMode, conn: query.conn, sort: query.sort });
}

function facetKeyFor(query: ServerQuery) {
  return JSON.stringify({ q: query.q, group: query.group, groupIds: query.groupIds, label: query.label, tagId: query.tagId, includeTagIds: query.includeTagIds, excludeTagIds: query.excludeTagIds, tagMode: query.tagMode, conn: query.conn });
}

function facetRequestKeyFor(query: ServerQuery, tagSearch: string, tagPage: number) {
  return JSON.stringify({ filters: facetKeyFor(query), tagSearch, tagPage, tagPageSize: TAG_CANDIDATE_PAGE_SIZE });
}

function loadCursorTrail(key: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) && saved.every((value) => typeof value === 'string') && saved.length ? saved as string[] : [''];
  } catch { return ['']; }
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function querySignature(query: ServerQuery) {
  return JSON.stringify(Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))));
}

type PageRefreshOptions = { recoverOutOfRange?: boolean };

export function useServers(active: boolean) {
  const [searchParams,setUrl] = useSearchParams();
  const [query, setQuery] = useState<ServerQuery>(() => parseQuery(window.location.search));
  const [tagSearch,setTagSearchText] = useState('');
  const [tagPage,setTagPage] = useState(1);
  const urlKey = searchParams.toString();
  const cursorMode = query.sort === 'ip';
  const countFilterKey = countKeyFor(query);
  const facetFilterKey = facetKeyFor(query);
  const cursorKey = useMemo(() => cursorStorageKey(query), [query.q, query.group, query.groupIds, query.label, query.tagId, query.includeTagIds, query.excludeTagIds, query.tagMode, query.conn, query.sort, query.order, query.pageSize]);
  const [cursorTrail, setCursorTrail] = useState<string[]>(() => loadCursorTrail(cursorStorageKey(parseQuery(window.location.search))));
  const cursorTrailRef = useRef(cursorTrail); cursorTrailRef.current = cursorTrail;
  const [cursorPage, setCursorPage] = useState<{ nextCursor: string | null; hasMore: boolean }>({ nextCursor: null, hasMore: false });
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [totalCountKey, setTotalCountKey] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [countLoading, setCountLoading] = useState(true);
  const [countError, setCountError] = useState<string | null>(null);
  const [countErrorKey, setCountErrorKey] = useState<string | null>(null);
  const lastObservedUrlRef = useRef(urlKey);
  const targetUrlRef = useRef<string | null>(null);
  const externalUrlQueryRef = useRef<ServerQuery | null>(null);
  const pushUrlRef = useRef(false);
  useLayoutEffect(() => {
    if (urlKey === lastObservedUrlRef.current) return;
    lastObservedUrlRef.current = urlKey;
    if (targetUrlRef.current === urlKey) { targetUrlRef.current = null; return; }
    const fromUrl = parseQuery(urlKey);
    externalUrlQueryRef.current = fromUrl;
    setQuery(fromUrl);
  }, [urlKey]);
  useEffect(() => {
    if(!active)return;
    const hydrated = externalUrlQueryRef.current;
    if (hydrated) {
      if (querySignature(query) !== querySignature(hydrated)) return;
      externalUrlQueryRef.current = null;
    }
    setUrl((current)=>{const next=new URLSearchParams(current);
      for(const key of ['page','pageSize','conn','sort','order','q','group','label','tagId','cursor','groupIds','includeTagIds','excludeTagIds','tagMode'])next.delete(key);
      next.set('page',String(query.page));next.set('pageSize',String(query.pageSize));next.set('conn',query.conn);next.set('sort',query.sort);next.set('order',query.order);
      if(query.q!==undefined)next.set('q',query.q);if(query.group!==undefined)next.set('group',query.group);if(query.label!==undefined)next.set('label',query.label);if(query.tagId!==undefined)next.set('tagId',query.tagId);if(query.cursor)next.set('cursor',query.cursor);
      if(query.groupIds?.length)next.set('groupIds',query.groupIds.join(','));if(query.includeTagIds?.length)next.set('includeTagIds',query.includeTagIds.join(','));if(query.excludeTagIds?.length)next.set('excludeTagIds',query.excludeTagIds.join(','));if(query.tagMode)next.set('tagMode',query.tagMode);
      const target = next.toString();
      if (target === current.toString()) { targetUrlRef.current = null; pushUrlRef.current = false; return current; }
      targetUrlRef.current = target;
      return next;
    },{replace:!pushUrlRef.current});
    pushUrlRef.current = false;
  },[active,query,setUrl]);
  useEffect(() => {
    const next = loadCursorTrail(cursorKey);
    setCursorTrail(next); cursorTrailRef.current = next;
  }, [cursorKey]);
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
    try { return new Map(JSON.parse(sessionStorage.getItem('probe_selected_servers') || '[]') as [number,string][]); }
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
    setPageLoading(true); setPageError(null);
    try {
      if (requested.sort === 'ip') {
        const next = await probeApi.serversCursor(requested, controller.signal);
        if (controller.signal.aborted || generation !== pageGeneration.current) return;
        setPage({ items: next.items, page: requested.page, pageSize: requested.pageSize, total: totalCount ?? 0, sort: requested.sort, order: requested.order });
        setCursorPage({ nextCursor: next.nextCursor, hasMore: next.hasMore });
        return;
      }
      const next = await probeApi.servers(requested, controller.signal);
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (options.recoverOutOfRange && requested.page > lastPage) {
        setQuery((current) => ({ ...current, page: lastPage }));
        return;
      }
      setPage(next);
      // 跨页勾选是本 hook 的核心语义：不按「是否在当前页」清理；
      // 行消失的清理由删除/导入流程显式调用 removeSelected 完成
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === pageGeneration.current) setPageError(requestErrorMessage(error));
    } finally {
      if (generation === pageGeneration.current) setPageLoading(false);
    }
  }, [isVisible]);

  const refreshCount = useCallback(async () => {
    if (!isVisible() || queryRef.current.sort !== 'ip') return;
    const requestedQuery = queryRef.current;
    const requestedCountKey = countKeyFor(requestedQuery);
    countController.current?.abort();
    const controller = new AbortController(); countController.current = controller;
    const generation = ++countGeneration.current;
    setCountLoading(true); setCountError(null); setCountErrorKey(null);
    try {
      const result = await probeApi.serverCount(requestedQuery, controller.signal);
      if (!controller.signal.aborted && generation === countGeneration.current) {
        setTotalCount(result.total); setTotalCountKey(requestedCountKey);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === countGeneration.current) {
        setCountError(requestErrorMessage(error)); setCountErrorKey(requestedCountKey);
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
    setFacetLoading(true); setFacetError(null); setFacetErrorKey(null);
    try {
      const next = await probeApi.serverFacets(requested, controller.signal, {
        tagSearch: requestedTagSearch, tagPage: requestedTagPage, tagPageSize: TAG_CANDIDATE_PAGE_SIZE,
      });
      if (!controller.signal.aborted && generation === facetGeneration.current && requestedRequestKey === facetRequestKeyRef.current) {
        setFacets(next); setFacetDataKey(requestedKey); setFacetRequestDataKey(requestedRequestKey);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === facetGeneration.current && requestedRequestKey === facetRequestKeyRef.current) {
        setFacetError(requestErrorMessage(error)); setFacetErrorKey(requestedRequestKey);
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
  }, [query, isVisible, refreshPage]);

  useEffect(() => {
    if (!isVisible()) return;
    void refreshFacets().catch(() => {});
  }, [active, facetRequestKey, isVisible, refreshFacets]);
  useEffect(() => { if (isVisible() && query.sort === 'ip') void refreshCount().catch(() => {}); }, [active, countFilterKey, isVisible, query.sort, refreshCount]);

  // 服务器库轮询：仅 Tab 激活且页面可见时，10s 一拍；隐藏即中止请求，回前台立即刷新
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        pageController.current?.abort();
        facetController.current?.abort();
        countController.current?.abort();
        return;
      }
      void refreshAll().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    timer = setInterval(() => {
      if (isVisible()) void refreshAll().catch(() => {});
    }, 10000);
    if (isVisible()) void refreshAll().catch(() => {});
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, isVisible, refreshAll]);

  const updateQuery = useCallback((changes: Partial<ServerQuery>, resetPage = true) => {
    if (resetPage) pushUrlRef.current = true;
    if (resetPage) setTagPage(1);
    setQuery((current) => ({ ...current, ...changes, ...(resetPage && !Object.prototype.hasOwnProperty.call(changes, 'cursor') ? { cursor: undefined } : {}), page: resetPage ? 1 : (changes.page ?? current.page) }));
  }, []);

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
  const setSort = useCallback((sort: ServerSort, order: DiscoverOrder) => updateQuery({ sort, order }), [updateQuery]);
  const applySavedView = useCallback((changes: Partial<ServerQuery>) => {
    pushUrlRef.current = true;
    setTagPage(1);
    setQuery((current) => ({ ...current, ...changes, page: 1, cursor: undefined }));
  }, []);
  const setPageNumber = useCallback((nextPage: number) => updateQuery({ page: nextPage }, false), [updateQuery]);
  const setPageSize = useCallback((pageSize: number) => updateQuery({ pageSize }), [updateQuery]);
  const cursorIndex = Math.max(0, cursorTrail.lastIndexOf(query.cursor ?? ''));
  const navigateCursor = useCallback((direction: 'next' | 'previous') => {
    const current = queryRef.current;
    const trail = cursorTrailRef.current;
    const index = Math.max(0, trail.lastIndexOf(current.cursor ?? ''));
    let nextTrail: string[]; let nextCursor: string | undefined; let nextPage: number;
    if (direction === 'next' && cursorPage.hasMore && cursorPage.nextCursor) {
      nextTrail = [...trail.slice(0, index + 1), cursorPage.nextCursor]; nextCursor = cursorPage.nextCursor; nextPage = current.page + 1;
    } else if (direction === 'previous' && index > 0) {
      nextTrail = trail.slice(0, index); nextCursor = nextTrail[nextTrail.length - 1] || undefined; nextPage = Math.max(1, current.page - 1);
    } else return;
    cursorTrailRef.current = nextTrail; setCursorTrail(nextTrail); sessionStorage.setItem(cursorKey, JSON.stringify(nextTrail));
    pushUrlRef.current = true;
    setQuery((value) => ({ ...value, page: nextPage, cursor: nextCursor }));
  }, [cursorKey, cursorPage.hasMore, cursorPage.nextCursor]);

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
