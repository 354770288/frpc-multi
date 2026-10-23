import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { probeApi, lbApi } from '../lib/api';
import type { ProbeDashboard, ProbeJob, TestNode, LbDomain } from '../lib/types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export function ResourceOverview() {
  const [dashboard, setDashboard] = useState<ProbeDashboard | null>(null);
  const [activeJobs, setActiveJobs] = useState<{items:ProbeJob[];total:number}|null>(null);
  const [failedJobs, setFailedJobs] = useState<{items:ProbeJob[];total:number}|null>(null);
  const [nodes, setNodes] = useState<TestNode[] | null>(null);
  const [domains, setDomains] = useState<LbDomain[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    async function load() {
      const values = await Promise.allSettled([probeApi.dashboard(), probeApi.jobsPage({page:1,pageSize:5,state:'running'}), probeApi.jobsPage({page:1,pageSize:5,state:'failed'}), probeApi.testNodes(), lbApi.domains()]);
      if (!active) return;
      const failed: string[] = [];
      if (values[0].status === 'fulfilled') setDashboard(values[0].value); else failed.push('服务器统计');
      if (values[1].status === 'fulfilled') setActiveJobs(values[1].value); else failed.push('进行中的测试');
      if (values[2].status === 'fulfilled') setFailedJobs(values[2].value); else failed.push('失败测试');
      if (values[3].status === 'fulfilled') setNodes(values[3].value.items); else failed.push('测试节点');
      if (values[4].status === 'fulfilled') setDomains(values[4].value); else failed.push('域名');
      setErrors(failed);
    }
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return <main className="mx-auto max-w-[1300px] space-y-6 px-4 py-6 sm:px-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">资源与测试工作台</h2><p className="text-sm text-muted-foreground">发现服务器、核对测试结果，再配置域名选优</p></div>
      <div className="flex gap-2"><Button asChild variant="outline"><Link to="/discovery">发现服务器</Link></Button><Button asChild><Link to="/tests/new">新建测试</Link></Button></div>
    </div>
    {errors.length > 0 && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{errors.join('、')}加载失败；已有数据可能不是最新。刷新页面可重试。</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title="服务器资产" value={dashboard?.servers} to="/servers" />
      <Metric title="进行中的批次" value={activeJobs?.total} to="/tests" />
      <Metric title="在线测试节点" value={nodes ? `${nodes.filter((n) => n.online).length}/${nodes.length}` : null} to="/test-nodes" />
      <Metric title="已启用域名" value={domains ? domains.filter((d) => d.enabled).length : null} to="/lb" />
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>正在测试</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{activeJobs === null ? '加载中…' : activeJobs.total === 0 ? '暂无进行中的测试' : activeJobs.items.map((job) => <Link className="block rounded-lg border p-3 hover:bg-muted" key={job.id} to={`/tests/${job.id}`}>{job.mode} · {job.taskTotal} 项 · {job.createdAt}</Link>)}<Button asChild variant="link"><Link to="/tests">查看全部批次</Link></Button></CardContent></Card>
      <Card><CardHeader><CardTitle>需要关注</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{failedJobs === null ? '加载中…' : failedJobs.total === 0 ? '暂无失败批次' : failedJobs.items.map((job) => <Link className="block rounded-lg border p-3 hover:bg-muted" key={job.id} to={`/tests/${job.id}`}><Badge tone="danger">失败</Badge> {job.mode} · {job.createdAt}</Link>)}{domains?.filter((d) => d.enabled && d.lastSyncOk === false).map((domain) => <Link className="block rounded-lg border p-3 hover:bg-muted" key={domain.id} to="/lb">{domain.name} · 最近同步失败</Link>)}</CardContent></Card>
    </div>
    <Button asChild variant="outline"><Link to="/instances">打开实例运维</Link></Button>
  </main>;
}

function Metric({title,value,to}:{title:string;value:string|number|null|undefined;to:string}) {
  return <Link to={to} className="rounded-xl border bg-card p-5 hover:bg-muted"><p className="text-sm text-muted-foreground">{title}</p><p className="mt-2 text-2xl font-semibold">{value ?? '—'}</p></Link>;
}
