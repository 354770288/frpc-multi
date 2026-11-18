import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FlaskConical, SlidersHorizontal } from 'lucide-react';
import { probeApi } from '../../lib/api';
import { PageHeader, PageShell } from '../../components/PageHeader';
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
    <PageShell maxWidth="full" className="max-w-[1600px]">
      <PageHeader
        title="测试任务"
        description="持久化追踪所有探测批次与主备故障接管进度，支持单任务跳过或失败重试"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => { void loadConfig(); setConfigOpen(true); }}>
              <SlidersHorizontal className="size-3.5" data-icon="inline-start" />测试设置
            </Button>
            <Button size="sm" onClick={() => navigate('/tests/new')}>
              <FlaskConical className="size-3.5" data-icon="inline-start" />新建测试
            </Button>
          </>
        }
      />

      {nodeError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {nodeError}
        </p>
      )}

      <ProbeJobsPanel nodes={nodes} focusJobId={routeJobId || ''} revision={0} onChanged={() => {}} />

      {configOpen && (
        <ConfigDialog
          config={config}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => { setConfig(next); setConfigOpen(false); }}
        />
      )}
    </PageShell>
  );
}
