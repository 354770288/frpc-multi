import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { probeApi } from '../../lib/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { ProbeTestConfig, TestNode } from '../../lib/types';
import { ConfigDialog } from './ProbeDialogs';
import { ProbeJobsPanel } from './ProbeJobsPanel';

export function TestsPage() {
  const navigate = useNavigate();
  const { jobId: routeJobId } = useParams<{ jobId: string }>();
  const nodeRequestRef = useRef(0);
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [nodeError, setNodeError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<ProbeTestConfig | null>(null);

  const loadNodes = useCallback(async () => {
    const request = ++nodeRequestRef.current;
    try {
      const result = await probeApi.testNodes();
      if (request === nodeRequestRef.current) {
        setNodes(result.items);
        setNodeError('');
      }
    } catch (err) {
      if (request === nodeRequestRef.current) {
        setNodeError(err instanceof Error ? err.message : '节点加载失败');
      }
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await probeApi.getConfig());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadNodes();
    void loadConfig();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadNodes();
    }, 10000);
    return () => {
      clearInterval(timer);
      nodeRequestRef.current++;
    };
  }, [loadConfig, loadNodes]);

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">测试任务</h2>
        <Badge tone="muted">frps 验收</Badge>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => navigate('/test-nodes')}>测试节点</Button>
        </div>
      </div>

      {nodeError && <p role="alert" className="mb-3 text-xs text-destructive">{nodeError}</p>}

      <div className="mt-4 space-y-4">
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { void loadConfig(); setConfigOpen(true); }}>测试设置</Button>
          <Button onClick={() => navigate('/tests/new')}>新建测试</Button>
        </div>
        <ProbeJobsPanel nodes={nodes} focusJobId={routeJobId || ''} revision={0} onChanged={() => {}} />
      </div>

      {configOpen && (
        <ConfigDialog
          config={config}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => { setConfig(next); setConfigOpen(false); }}
        />
      )}
    </div>
  );
}
