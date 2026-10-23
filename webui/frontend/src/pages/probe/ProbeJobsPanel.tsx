import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import type { ProbeJob, ProbeJobDetail, ProbeTask, TestNode } from '../../lib/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Progress } from '../../components/ui/progress';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../components/ui/empty';
import { formatLastSeen } from '../../lib/format';
import { MODE_NAMES } from './NodeControls';
import { ConfirmOverlay } from '../../components/Overlay';

const STATES: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  cancelling: '收尾中',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
  stopped: '已停止',
};
const active = (task: ProbeTask) => task.state === 'pending' || task.state === 'running';
function progressText(task: ProbeTask) {
  const values = task.progress;
  if (task.stage === 'discover')
    return `已扫描 ${Number(values.scanned || 0)} · 命中 ${Number(values.foundCount || 0)}`;
  return (
    [values.step, values.text, values.message]
      .filter((value) => typeof value === 'string' && value)
      .join(' · ') || '等待阶段更新'
  );
}
function resultText(task: ProbeTask) {
  const result = task.result;
  if (!result) return '';
  const check = (value: unknown) => (value === true ? '通过' : value === false ? '失败' : '—');
  if (task.stage === 'route')
    return `${result.ok ? (result.isCn2 ? 'CN2' : '非 CN2') : '路由失败'} · ${Array.isArray(result.hops) ? result.hops.length : 0} 跳`;
  if (task.stage === 'connectivity')
    return `可达 ${check(result.frps_reachable)} · 隧道 ${check(result.tunnel_established)} · 端口 ${check(result.firewall_open)}`;
  if (task.stage === 'speed') {
    const speed = (prefix: 'dl' | 'ul') =>
      result[`${prefix}_ok`] === true
        ? `${((Number(result[`${prefix}_speed_bps`] ?? 0) * 8) / 1048576).toFixed(2)} Mbps`
        : '失败';
    return `↓ ${speed('dl')} · ↑ ${speed('ul')}`;
  }
  return '扫描已提交';
}
const ERROR_NAMES: Record<string, string> = {
  dependency: '等待连通性通过后恢复速率阶段',
  skipped: '已按指令跳过',
  stopped: '已按指令停止',
  'lease expired': '节点连接超时，等待重新领取',
};
const retryable = (task: ProbeTask) => ['failed', 'skipped', 'stopped'].includes(task.state);
export function ProbeJobsPanel({
  nodes,
  focusJobId,
  revision,
  onChanged,
}: {
  nodes: TestNode[];
  focusJobId: string;
  revision: number;
  onChanged: () => void;
}) {
  const [jobs, setJobs] = useState<ProbeJob[]>([]);
  const navigate = useNavigate();
  const [searchParams,setSearchParams] = useSearchParams();
  const listPage = Math.max(1,Number(searchParams.get('page') || 1) || 1);
  const listState = searchParams.get('state') || '';
  const listMode = searchParams.get('mode') || '';
  const listNode = searchParams.get('listNode') || '';
  const listTarget = searchParams.get('q') || '';
  const fromDate = searchParams.get('from') || '';
  const toDate = searchParams.get('to') || '';
  const taskState = searchParams.get('taskState') || '';
  const taskNode = searchParams.get('taskNode') || '';
  const taskStage = searchParams.get('taskStage') || '';
  const taskTarget = searchParams.get('target') || '';
  const [listTotal,setListTotal] = useState(0);
  const [jobId, setJobId] = useState(focusJobId || '');
  const [loadedDetail, setDetail] = useState<ProbeJobDetail | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmStop,setConfirmStop] = useState(false);
  const [loading, setLoading] = useState(true);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const previous = useRef('');
  const requestId = useRef(0);
  const mounted = useRef(true);
  const pendingAction = useRef<symbol | null>(null);
  const selection = useRef({ jobId, page });
  // A new owner object also rejects an earlier A request after A → B → A.
  if (selection.current.jobId !== jobId || selection.current.page !== page) {
    selection.current = { jobId, page };
  }
  const owner = selection.current;
  const detail = loadedDetail?.id === jobId && loadedDetail.page === page ? loadedDetail : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setJobId(focusJobId || '');
    setPage(1);
  }, [focusJobId]);
  useEffect(() => {
    setDetail(null);
    setSelected(new Set());
    setPage(1);
    sessionStorage.setItem('probe_job_id', jobId);
  }, [jobId]);
  const load = useCallback(async () => {
    // Check ownership before incrementing: an old action must not invalidate B's fetch.
    if (!mounted.current || selection.current !== owner) return;
    const generation = ++requestId.current;
    const isCurrent = () =>
      mounted.current && selection.current === owner && generation === requestId.current;
    try {
      const query:Record<string,string|number>={page:listPage,pageSize:20};
      if(listState)query.state=listState;
      if(listMode)query.mode=listMode;
      if(listNode)query.nodeId=listNode;
      if(listTarget)query.target=listTarget;
      const start=fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? new Date(`${fromDate}T00:00:00`) : null;
      const end=toDate && /^\d{4}-\d{2}-\d{2}$/.test(toDate) ? new Date(`${toDate}T23:59:59.999`) : null;
      if(start && Number.isFinite(start.getTime()))query.fromTime=start.toISOString().replace('Z','+00:00');
      if(end && Number.isFinite(end.getTime()))query.toTime=end.toISOString().replace('Z','+00:00');
      const list = await probeApi.jobsPage(query);
      if (!isCurrent()) return;
      setJobs(list.items);
      setListTotal(list.total);
      const id = focusJobId || jobId;
      if (id) {
        const next = await probeApi.jobFiltered(id,{page,pageSize:200,...(taskState ? {state:taskState} : {}),...(taskNode ? {nodeId:taskNode} : {}),...(taskStage ? {stage:taskStage} : {}),...(taskTarget ? {target:taskTarget} : {})});
        if (!isCurrent()) return;
        const lastPage = Math.max(1, Math.ceil((next.filteredTaskTotal ?? next.taskTotal) / next.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        const signature = `${id}:${JSON.stringify(next.counts)}:${JSON.stringify(next.progress)}`;
        if (previous.current && previous.current !== signature) changedRef.current();
        previous.current = signature;
        setDetail(next);
      } else setDetail(null);
      setError('');
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : '批次加载失败');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [jobId, page, owner, listPage, listState, listMode, listNode, listTarget, fromDate, toDate, focusJobId, taskState, taskNode, taskStage, taskTarget]);
  const changeFilter = (key:string,value:string) => {
    setSearchParams((current)=>{const next=new URLSearchParams(current);if(value)next.set(key,value);else next.delete(key);next.delete('page');return next;});
    setPage(1);
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 2500);
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      requestId.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, revision]);
  const actions = async (action: 'stop' | 'skip' | 'retry', ids?: string[]) => {
    if (
      !jobId ||
      busy ||
      pendingAction.current ||
      !detail ||
      selection.current !== owner ||
      (ids && !ids.length)
    )
      return;
    const actionId = Symbol();
    pendingAction.current = actionId;
    setBusy(true);
    const ownsSelection = () => mounted.current && selection.current === owner;
    try {
      const result = await probeApi.jobAction(jobId, action, ids);
      if (!mounted.current) return;
      toast.success(
        `已更新 ${result.changed} 项任务${action === 'retry' ? '（速率任务仍遵守连通性门禁）' : ''}`,
      );
      if (!ownsSelection()) return;
      setSelected(new Set());
      await load();
      if (ownsSelection()) changedRef.current();
    } catch (err) {
      if (mounted.current) toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      if (pendingAction.current === actionId) {
        pendingAction.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const nodeName = (id: string) => nodes.find((node) => node.id === id)?.name || id;
  const groups = useMemo(() => {
    const result = new Map<
      string,
      { nodeId: string; stage: string; total: number; done: number }
    >();
    for (const entry of detail?.stageCounts || []) {
      const key = `${entry.nodeId}:${entry.stage}`;
      const group = result.get(key) || {
        nodeId: entry.nodeId,
        stage: entry.stage,
        total: 0,
        done: 0,
      };
      group.total += entry.count;
      if (!['pending', 'running', 'cancelling'].includes(entry.state)) group.done += entry.count;
      result.set(key, group);
    }
    return [...result.values()];
  }, [detail]);
  const tasks = detail?.tasks || [];
  const selectedTasks = tasks.filter((task) => selected.has(task.taskId));
  const waitingOffline =
    detail?.state === 'running' &&
    !(detail.counts.running || detail.counts.cancelling) &&
    !!detail.counts.pending &&
    detail.nodeIds.some((id) => nodes.some((node) => node.id === id && !node.online));
  const total = detail?.taskTotal || 0;
  const filteredTotal = detail?.filteredTaskTotal ?? total;
  const done = detail
    ? Object.entries(detail.counts).reduce(
        (count, [state, n]) =>
          count + (['done', 'failed', 'skipped', 'stopped'].includes(state) ? n || 0 : 0),
        0,
      )
    : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>测试批次</CardTitle>
        <CardDescription>
          批次与进度保存在服务端，刷新页面可继续跟踪。完整测试依次运行路由、连通性与速率，连通性通过后才测速。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">批次状态 <select className="ml-2 rounded-md border bg-background p-2" value={listState} onChange={(event)=>changeFilter('state',event.target.value)}><option value="">全部状态</option><option value="running">进行中</option><option value="done">已完成</option><option value="failed">失败</option><option value="stopped">已停止</option></select></label>
          <label className="text-sm">类型 <select className="ml-2 rounded-md border bg-background p-2" value={listMode} onChange={(event)=>changeFilter('mode',event.target.value)}><option value="">全部类型</option>{(['discover','route','connectivity','speed','full'] as const).map((item)=><option key={item} value={item}>{MODE_NAMES[item]}</option>)}</select></label>
          <label className="text-sm">执行节点 <select className="ml-2 rounded-md border bg-background p-2" value={listNode} onChange={(event)=>changeFilter('listNode',event.target.value)}><option value="">全部节点</option>{nodes.map((node)=><option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
          <label className="text-sm">目标 <input className="ml-2 rounded-md border bg-background p-2" value={listTarget} onChange={(event)=>changeFilter('q',event.target.value)} placeholder="IP 或域名" /></label>
          <label className="text-sm">起 <input className="ml-2 rounded-md border bg-background p-2" type="date" value={fromDate} onChange={(event)=>changeFilter('from',event.target.value)} /></label>
          <label className="text-sm">止 <input className="ml-2 rounded-md border bg-background p-2" type="date" value={toDate} onChange={(event)=>changeFilter('to',event.target.value)} /></label>
          <Button size="sm" variant="outline" onClick={load} disabled={busy}>
            刷新
          </Button>
        </div>
        <div className="grid gap-2" aria-label="测试批次列表">
          {jobs.map((job) => <button key={job.id} type="button" onClick={()=>navigate(`/tests/${job.id}${searchParams.size ? `?${searchParams.toString()}` : ''}`)} className={`rounded-lg border p-3 text-left text-sm hover:bg-muted ${job.id===jobId ? 'border-primary' : ''}`}>
            <span className="font-medium">{MODE_NAMES[job.mode]}</span> · {formatLastSeen(job.createdAt)} · <span>{STATES[job.state] || job.state}</span>
            <span className="mt-1 block text-xs text-muted-foreground">执行节点 {job.nodeIds.map(nodeName).join('、')} · 阶段任务 {job.taskTotal} · 异常 {(job.counts.failed || 0)+(job.counts.skipped || 0)}</span>
          </button>)}
          {!loading && !jobs.length && <p className="text-sm text-muted-foreground">暂无匹配批次</p>}
        </div>
        <div className="flex items-center gap-2 text-sm"><span>第 {listPage} 页 / 共 {listTotal} 批</span><Button variant="outline" size="sm" disabled={listPage<=1} onClick={()=>setSearchParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(listPage-1));return next;})}>上一页</Button><Button variant="outline" size="sm" disabled={listPage*20>=listTotal} onClick={()=>setSearchParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(listPage+1));return next;})}>下一页</Button></div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {detail ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={detail.state === 'failed' ? 'danger' : 'muted'}>
                {waitingOffline ? '等待节点上线 · 排队中' : STATES[detail.state] || detail.state}
              </Badge>
              <span className="text-xs">
                阶段任务 {done}/{total}
              </span>
              {Object.entries(detail.counts).map(([state, count]) => (
                <Badge key={state} tone="muted">
                  {STATES[state] || state} {count}
                </Badge>
              ))}
            </div>
            <Progress value={total ? (done / total) * 100 : 0} />
            {detail.mode === 'discover' && (
              <p className="text-xs text-muted-foreground">
                扫描完成 {detail.progress.scanned} · 命中 {detail.progress.foundCount}
                （各节点独立扫描合计）
              </p>
            )}
            <p className="break-all text-[11px] text-muted-foreground">
              批次 {detail.id} · 节点 {detail.nodeIds.map(nodeName).join('、')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || detail.state !== 'running'}
                onClick={() => setConfirmStop(true)}
              >
                停止整个批次
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  !Object.entries(detail.counts).some(
                    ([state, n]) => ['failed', 'skipped', 'stopped'].includes(state) && !!n,
                  )
                }
                onClick={() => actions('retry')}
              >
                重试批次失败 / 跳过 / 停止项
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                全批次按节点 / 阶段已结束数（任务列表最近优先，按页查看）
              </p>
              <div className="flex flex-wrap gap-2">
                {groups.map((group) => (
                  <Badge key={`${group.nodeId}:${group.stage}`} tone="muted">
                    {nodeName(group.nodeId)} ·{' '}
                    {MODE_NAMES[group.stage as keyof typeof MODE_NAMES] || group.stage} {group.done}
                    /{group.total}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">勾选本页 {selectedTasks.length} 项</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !selectedTasks.some(active)}
                onClick={() =>
                  actions(
                    'skip',
                    selectedTasks.filter(active).map((task) => task.taskId),
                  )
                }
              >
                跳过选中待执行 / 进行项
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !selectedTasks.some(retryable)}
                onClick={() =>
                  actions(
                    'retry',
                    selectedTasks.filter(retryable).map((task) => task.taskId),
                  )
                }
              >
                重试选中失败项
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label>节点 <select className="ml-1 rounded-md border bg-background p-2" value={taskNode} onChange={(event)=>changeFilter('taskNode',event.target.value)}><option value="">全部</option>{nodes.map((node)=><option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
              <label>阶段 <select className="ml-1 rounded-md border bg-background p-2" value={taskStage} onChange={(event)=>changeFilter('taskStage',event.target.value)}><option value="">全部</option>{['discover','route','connectivity','speed'].map((stage)=><option key={stage} value={stage}>{MODE_NAMES[stage as keyof typeof MODE_NAMES]}</option>)}</select></label>
              <label>状态 <select className="ml-1 rounded-md border bg-background p-2" value={taskState} onChange={(event)=>changeFilter('taskState',event.target.value)}><option value="">全部</option>{Object.entries(STATES).map(([state,name])=><option key={state} value={state}>{name}</option>)}</select></label>
              <label>目标 <input className="ml-1 rounded-md border bg-background p-2" value={taskTarget} onChange={(event)=>changeFilter('target',event.target.value)} placeholder="IP 或域名" /></label>
              <span>匹配 {detail.filteredTaskTotal ?? detail.taskTotal} 项 / 全批次 {detail.taskTotal} 项</span>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full min-w-[660px] text-xs">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">
                      <input
                        aria-label="全选本页任务"
                        type="checkbox"
                        checked={!!tasks.length && tasks.every((task) => selected.has(task.taskId))}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? new Set(tasks.map((task) => task.taskId))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th className="p-2">节点 / 目标</th>
                    <th className="p-2">阶段</th>
                    <th className="p-2">状态</th>
                    <th className="p-2">进度 / 结果</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.taskId} className="border-b">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`选择任务 ${task.ip || '扫描'} ${nodeName(task.nodeId)} ${task.stage}`}
                          checked={selected.has(task.taskId)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(task.taskId);
                              else next.delete(task.taskId);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="p-2">
                        <div>{nodeName(task.nodeId)}</div>
                        <div className="font-mono text-muted-foreground">
                          {task.ip ? `${task.ip}:${task.port}` : '网段扫描'}
                        </div>
                      </td>
                      <td className="p-2">
                        {MODE_NAMES[task.stage as keyof typeof MODE_NAMES] || task.stage}
                      </td>
                      <td className="p-2">
                        <Badge
                          tone={
                            task.state === 'failed'
                              ? 'danger'
                              : task.state === 'done'
                                ? 'success'
                                : 'muted'
                          }
                        >
                          {STATES[task.state]}
                        </Badge>
                      </td>
                      <td className="max-w-80 p-2">
                        <p className="break-words text-muted-foreground">
                          {task.error
                            ? ERROR_NAMES[task.error] || task.error
                            : task.state === 'pending' &&
                                nodes.some((node) => node.id === task.nodeId && !node.online)
                              ? '等待该节点上线领取'
                              : progressText(task)}
                        </p>
                        {task.result && (
                          <p className="mt-1">
                            {resultText(task)}
                            {typeof task.result.test_time === 'string' && (
                              <span className="ml-2 text-muted-foreground">
                                {formatLastSeen(task.result.test_time)}
                              </span>
                            )}
                          </p>
                        )}
                        {task.result && (
                          <details>
                            <summary className="cursor-pointer">
                              技术详情 · 尝试 {task.attempts}
                            </summary>
                            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px]">
                              {JSON.stringify(task.result, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-2 text-xs">
              <span>
                共 {filteredTotal} 项 · 第 {page}/{Math.max(1, Math.ceil(filteredTotal / (detail.pageSize || 200)))}{' '}
                页
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || page <= 1}
                onClick={() => {
                  setPage(page - 1);
                  setSelected(new Set());
                }}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || page * detail.pageSize >= filteredTotal}
                onClick={() => {
                  setPage(page + 1);
                  setSelected(new Set());
                }}
              >
                下一页
              </Button>
            </div>
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{loading ? '批次加载中' : '选择批次查看详情'}</EmptyTitle>
              <EmptyDescription>在上方列表选择批次，或新建测试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {confirmStop && detail && <ConfirmOverlay title="停止整个测试批次" description={`将停止批次 ${detail.id} 的待执行和运行中任务；正在执行的任务会先清理。`} confirmLabel="确认停止" variant="destructive" onCancel={()=>setConfirmStop(false)} onConfirm={()=>{setConfirmStop(false);void actions('stop');}} />}
      </CardContent>
    </Card>
  );
}
