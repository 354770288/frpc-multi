import { useCallback, useEffect, useRef, useState } from 'react';
import { probeApi } from '../../lib/api';
import type {
  DiscoverFacets,
  DiscoverLibrary,
  DiscoverOrder,
  DiscoverPage,
  DiscoverQuery,
  DiscoverSort,
  DiscoverStatus,
  RouteStatusView,
} from '../../lib/types';

const EMPTY_PAGE: DiscoverPage = {
  items: [], page: 1, pageSize: 50, total: 0, sort: 'discoveredAt', order: 'desc',
};
const EMPTY_FACETS: DiscoverFacets = { labels: [], groups: [], imported: 0, new: 0 };

type PageRefreshOptions = { recoverOutOfRange?: boolean };

export function useDiscovery(active: boolean) {
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
  const [scanStatus, setScanStatus] = useState<DiscoverStatus | null>(null);
  const [routeStatus, setRouteStatus] = useState<RouteStatusView | null>(null);

  const pageController = useRef<AbortController | null>(null);
  const facetController = useRef<AbortController | null>(null);
  const pageGeneration = useRef(0);
  const facetGeneration = useRef(0);
  // 扫描/路由的「之前在跑」状态必须是 hook 级 ref：ScanDialog.onStarted 等外部
  // setter 也要能 seed，否则短扫描在一个空闲轮询周期内完成时 terminal 转换被漏检
  const previousScanRunning = useRef(false);
  const previousRouteActive = useRef(false);
  // 轮询协调器在 effect 闭包内，外部通过 nudge 请求立即跑一拍（进入 1.5s 节奏）
  const pollNudge = useRef<() => void>(() => {});

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
      const next = await probeApi.discoverResults(requested, controller.signal);
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (options.recoverOutOfRange && requested.page > lastPage) {
        setQuery((current) => ({ ...current, page: lastPage }));
        return;
      }
      setPage(next);
      const imported = new Set(next.items.filter((item) => item.inLibrary).map((item) => item.id));
      if (imported.size) {
        setSelected((current) => {
          const retained = new Set([...current].filter((id) => !imported.has(id)));
          return retained.size === current.size ? current : retained;
        });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
  }, [isVisible]);

  const refreshFacets = useCallback(async () => {
    if (!isVisible()) return;
    facetController.current?.abort();
    const controller = new AbortController();
    facetController.current = controller;
    const generation = ++facetGeneration.current;
    try {
      const next = await probeApi.discoverFacets(controller.signal);
      if (!controller.signal.aborted && generation === facetGeneration.current) setFacets(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
  }, [isVisible]);

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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let restartAfterPoll = false;
    let visibilityGeneration = 0;

    const abortDiscoveryRequests = () => {
      pageController.current?.abort();
      facetController.current?.abort();
    };

    const schedule = (delay: number) => {
      if (cancelled || !isVisible()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, delay);
    };

    pollNudge.current = () => {
      restartAfterPoll = true;
      schedule(0);
    };

    const tick = async () => {
      if (cancelled || !isVisible()) return;
      if (polling) {
        restartAfterPoll = true;
        return;
      }
      polling = true;
      const generation = visibilityGeneration;
      let nextDelay = 6000;
      try {
        const [nextScan, nextRoute] = await Promise.all([
          probeApi.discoverStatus(),
          probeApi.routeStatus(),
        ]);
        if (cancelled || generation !== visibilityGeneration || !isVisible()) return;
        setScanStatus(nextScan);
        setRouteStatus(nextRoute);

        const terminal = (previousScanRunning.current && !nextScan.running)
          || (previousRouteActive.current && !nextRoute.active);
        if (terminal) await refreshAll();
        else if (nextScan.running || nextRoute.active) await refreshPage();

        if (cancelled || generation !== visibilityGeneration || !isVisible()) return;
        previousScanRunning.current = nextScan.running;
        previousRouteActive.current = nextRoute.active;
        nextDelay = nextScan.running || nextRoute.active ? 1500 : 6000;
      } catch {
        nextDelay = 6000;
      } finally {
        polling = false;
        if (cancelled || !isVisible()) return;
        if (restartAfterPoll || generation !== visibilityGeneration) {
          restartAfterPoll = false;
          schedule(0);
        } else {
          schedule(nextDelay);
        }
      }
    };

    const onVisibilityChange = () => {
      visibilityGeneration += 1;
      if (!isVisible()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        abortDiscoveryRequests();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      void refreshAll().catch(() => {});
      void tick();
    };

    if (isVisible()) void tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      pollNudge.current = () => {};
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      abortDiscoveryRequests();
    };
  }, [isVisible, refreshAll, refreshPage]);

  // 外部置 running/active 时同步 seed 轮询 ref 并立即提速，避免短任务在空闲周期内漏检
  const setScanStatusExternal = useCallback((next: DiscoverStatus | null) => {
    if (next?.running) {
      previousScanRunning.current = true;
      pollNudge.current();
    }
    setScanStatus(next);
  }, []);
  const setRouteStatusExternal = useCallback((next: RouteStatusView | null) => {
    if (next?.active) {
      previousRouteActive.current = true;
      pollNudge.current();
    }
    setRouteStatus(next);
  }, []);

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
    scanStatus,
    setScanStatus: setScanStatusExternal,
    routeStatus,
    setRouteStatus: setRouteStatusExternal,
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
