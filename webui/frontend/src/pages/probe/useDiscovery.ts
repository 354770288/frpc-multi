import { useCallback, useEffect, useRef, useState } from 'react';
import { probeApi } from '../../lib/api';
import type {
  DiscoverFacets,
  DiscoverLibrary,
  DiscoverOrder,
  DiscoverPage,
  DiscoverQuery,
  DiscoverSort,
} from '../../lib/types';

const EMPTY_PAGE: DiscoverPage = {
  items: [], page: 1, pageSize: 50, total: 0, sort: 'discoveredAt', order: 'desc',
};
const EMPTY_FACETS: DiscoverFacets = { labels: [], groups: [], imported: 0, new: 0 };

type PageRefreshOptions = { recoverOutOfRange?: boolean };

export function useDiscovery(active: boolean, nodeId = 'console') {
  const [query, setQuery] = useState<DiscoverQuery>({
    page: 1,
    pageSize: 50,
    library: 'all',
    sort: 'discoveredAt',
    order: 'desc',
  });
  const queryRef = useRef(query);
  queryRef.current = query;

  const [page, setPage] = useState<DiscoverPage>(EMPTY_PAGE);
  const [facets, setFacets] = useState<DiscoverFacets>(EMPTY_FACETS);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectedTargets, setSelectedTargets] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    pageController.current?.abort(); facetController.current?.abort();
    pageGeneration.current++; facetGeneration.current++;
    setPage(EMPTY_PAGE);
    setFacets(EMPTY_FACETS);
    setQuery((current) => ({ ...current, page: 1 }));
  }, [nodeId]);

  const pageController = useRef<AbortController | null>(null);
  const facetController = useRef<AbortController | null>(null);
  const pageGeneration = useRef(0);
  const facetGeneration = useRef(0);
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
    try {
      const next = await probeApi.discoverResults(requested, controller.signal, nodeId);
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (options.recoverOutOfRange && requested.page > lastPage) {
        setQuery((current) => ({ ...current, page: lastPage }));
        return;
      }
      setPage(next);
      setSelectedTargets((current) => { const updated = new Map(current); for (const item of next.items) updated.set(item.id, `${item.ip}:${item.port}`); return updated; });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
  }, [isVisible, nodeId]);

  const refreshFacets = useCallback(async () => {
    if (!isVisible()) return;
    facetController.current?.abort();
    const controller = new AbortController();
    facetController.current = controller;
    const generation = ++facetGeneration.current;
    try {
      const next = await probeApi.discoverFacets(controller.signal, nodeId);
      if (!controller.signal.aborted && generation === facetGeneration.current) setFacets(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
  }, [isVisible, nodeId]);

  const refreshAll = useCallback(async (options: PageRefreshOptions = {}) => {
    await Promise.all([refreshPage(options), refreshFacets()]);
  }, [refreshFacets, refreshPage]);

  useEffect(() => {
    if (!isVisible()) return;
    void refreshPage().catch(() => {});
  }, [query, isVisible, refreshPage]);

  useEffect(() => {
    if (!isVisible()) return;
    void refreshFacets().catch(() => {});
  }, [active, isVisible, refreshFacets]);

  useEffect(() => {
    if (!active) return;
    const tick = () => { if (isVisible()) void refreshAll({ recoverOutOfRange: true }).catch(() => {}); };
    tick();
    const timer = setInterval(tick, 6000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); pageController.current?.abort(); facetController.current?.abort(); };
  }, [active, isVisible, refreshAll]);

  const updateQuery = useCallback((changes: Partial<DiscoverQuery>, resetPage = true) => {
    setQuery((current) => ({ ...current, ...changes, page: resetPage ? 1 : (changes.page ?? current.page) }));
  }, []);

  const setSearch = useCallback((q: string) => {
    if ((queryRef.current.q ?? '') === q) return;  // 防抖相等时不触发无谓 refetch
    updateQuery({ q });
  }, [updateQuery]);
  const setGroup = useCallback((group: string) => updateQuery({ group: group === 'all' ? undefined : group }), [updateQuery]);
  // null = 取消筛选；'' = 筛「无标签」行；二者不可混淆
  const setLabel = useCallback((label: string | null) => updateQuery({ label: label === null ? undefined : label }), [updateQuery]);
  const setLibrary = useCallback((library: DiscoverLibrary) => updateQuery({ library }), [updateQuery]);
  const setSort = useCallback((sort: DiscoverSort, order: DiscoverOrder) => updateQuery({ sort, order }), [updateQuery]);
  const setPageNumber = useCallback((nextPage: number) => updateQuery({ page: nextPage }, false), [updateQuery]);
  const setPageSize = useCallback((pageSize: number) => updateQuery({ pageSize }), [updateQuery]);

  const toggleSelected = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCurrentPage = useCallback((checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of page.items) {
        if (item.inLibrary) continue;
        if (checked) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }, [page.items]);

  const removeSelected = useCallback((ids: number[]) => {
    const removed = new Set(ids);
    setSelected((current) => new Set([...current].filter((id) => !removed.has(id))));
  }, []);

  return {
    query,
    page,
    facets,
    selected,
    setSelected,
    selectedTargets,
    setSearch,
    setGroup,
    setLabel,
    setLibrary,
    setSort,
    setPageNumber,
    setPageSize,
    toggleSelected,
    toggleCurrentPage,
    removeSelected,
    refreshPage,
    refreshFacets,
    refreshAll,
  };
}
