import { useCallback, useEffect, useRef, useState } from 'react';
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
  items: [], page: 1, pageSize: 50, total: 0, sort: 'group', order: 'asc',
};
const EMPTY_FACETS: ServerFacets = { labels: [], groups: [] };

type PageRefreshOptions = { recoverOutOfRange?: boolean };

export function useServers(active: boolean, nodeId = 'console') {
  const [,setUrl] = useSearchParams();
  const [query, setQuery] = useState<ServerQuery>(() => {
    const p=new URLSearchParams(window.location.search);
    const pageSize=Number(p.get('pageSize'));
    const sort=p.get('sort');const order=p.get('order');const conn=p.get('conn');
    return {page:Math.max(1,Number(p.get('page')) || 1),pageSize:[25,50,100,200].includes(pageSize) ? pageSize : 50,
      conn:conn==='pass'||conn==='partial'||conn==='fail'||conn==='untested' ? conn : 'all',
      sort:sort==='ip'||sort==='conn'||sort==='speed'||sort==='time' ? sort : 'group',order:order==='desc' ? 'desc':'asc',
      ...(p.has('q') ? {q:p.get('q') || ''} : {}),...(p.has('group') ? {group:p.get('group') || ''} : {}),...(p.has('label') ? {label:p.get('label') || ''} : {})};
  });
  useEffect(() => {
    if(!active)return;
    setUrl((current)=>{const next=new URLSearchParams(current);
      for(const key of ['page','pageSize','conn','sort','order','q','group','label'])next.delete(key);
      next.set('page',String(query.page));next.set('pageSize',String(query.pageSize));next.set('conn',query.conn);next.set('sort',query.sort);next.set('order',query.order);
      if(query.q!==undefined)next.set('q',query.q);if(query.group!==undefined)next.set('group',query.group);if(query.label!==undefined)next.set('label',query.label);
      return next.toString()===current.toString() ? current : next;
    },{replace:true});
  },[active,query,setUrl]);
  const queryRef = useRef(query);
  queryRef.current = query;

  const [page, setPage] = useState<ServerPage>(EMPTY_PAGE);
  const [facets, setFacets] = useState<ServerFacets>(EMPTY_FACETS);
  // 跨页勾选：id → ip（一键测试需要 IP 列表，跨页后不能只靠当前页推导）
  const [selected, setSelected] = useState<Map<number, string>>(() => {
    try { return new Map(JSON.parse(sessionStorage.getItem('probe_selected_servers') || '[]') as [number,string][]); }
    catch { return new Map(); }
  });
  useEffect(() => {
    sessionStorage.setItem('probe_selected_servers', JSON.stringify([...selected]));
    sessionStorage.setItem('probe_selected_endpoints', JSON.stringify([...selected.values()]));
  }, [selected]);

  const lastNode=useRef(nodeId);
  useEffect(() => {
    if(lastNode.current===nodeId)return;
    lastNode.current=nodeId;
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
      const next = await probeApi.servers(requested, controller.signal, nodeId);
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
      const next = await probeApi.serverFacets(controller.signal, nodeId);
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

  // 服务器库轮询：仅 Tab 激活且页面可见时，10s 一拍；隐藏即中止请求，回前台立即刷新
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        pageController.current?.abort();
        facetController.current?.abort();
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
    setQuery((current) => ({ ...current, ...changes, page: resetPage ? 1 : (changes.page ?? current.page) }));
  }, []);

  const setSearch = useCallback((q: string) => {
    if ((queryRef.current.q ?? '') === q) return;
    updateQuery({ q });
  }, [updateQuery]);
  const setGroup = useCallback((group: string) => updateQuery({ group: group === 'all' ? undefined : group }), [updateQuery]);
  // null = 取消筛选；'' = 筛「无标签」行，二者不可混淆
  const setLabel = useCallback((label: string | null) => updateQuery({ label: label === null ? undefined : label }), [updateQuery]);
  const setConn = useCallback((conn: ServerConn) => updateQuery({ conn }), [updateQuery]);
  const setSort = useCallback((sort: ServerSort, order: DiscoverOrder) => updateQuery({ sort, order }), [updateQuery]);
  const setPageNumber = useCallback((nextPage: number) => updateQuery({ page: nextPage }, false), [updateQuery]);
  const setPageSize = useCallback((pageSize: number) => updateQuery({ pageSize }), [updateQuery]);

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
    selected,
    setSelected,
    setSearch,
    setGroup,
    setLabel,
    setConn,
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
