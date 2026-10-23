import { useCallback, useEffect, useRef, useState } from 'react';
import { probeApi } from '../lib/api';
import type { TestNode } from '../lib/types';
import { formatLastSeen } from '../lib/format';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { TestNodesDialog } from './probe/TestNodesDialog';

export function TestNodesPage() {
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const manageButton=useRef<HTMLButtonElement>(null);
  const close=()=>{setOpen(false);requestAnimationFrame(()=>manageButton.current?.focus());};
  const load = useCallback(async () => {
    try { setNodes((await probeApi.testNodes()).items); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : '测试节点加载失败'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  return <main className="mx-auto max-w-[1300px] px-4 py-6 sm:px-6">
    <div className="mb-5 flex items-center gap-3">
      <div><h2 className="text-lg font-semibold">测试节点</h2><p className="text-sm text-muted-foreground">执行网段发现、路由、穿透与速率测量</p></div>
      <Button ref={manageButton} className="ml-auto" onClick={() => setOpen(true)}>接入或管理节点</Button>
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error} <Button variant="link" onClick={load}>重试</Button></p>}
    <div className="grid gap-4 md:grid-cols-2">
      {nodes.map((node) => <Card key={node.id}>
        <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">{node.name}<Badge tone={node.online ? 'success' : 'muted'}>{node.online ? '在线' : '离线'}</Badge></CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{node.id === 'console' ? '主控测试节点' : node.kind === 'legacy' ? '旧版路由节点' : '外部测试节点'} · 版本 {node.version || '未知'}</p>
          <p className="text-muted-foreground">最近在线：{node.lastSeen ? formatLastSeen(node.lastSeen) : '尚未连接'}</p>
          <div className="flex flex-wrap gap-2">{node.capabilities.map((cap) => <Badge key={cap} tone="muted">{cap}</Badge>)}</div>
        </CardContent>
      </Card>)}
    </div>
    {open && <TestNodesDialog nodes={nodes} onClose={close} onChanged={load} />}
  </main>;
}
