import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { Overlay } from '../../components/Overlay';
import { Input } from '../../components/ui/input';
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '../../components/ui/field';
import { Textarea } from '../../components/ui/textarea';
import { Button } from '../../components/ui/button';
import { Radar } from 'lucide-react';
import type { TestNode, TestNodeExecutionPolicy, ProbeJobDetail } from '../../lib/types';

export function ScanDialog({
  nodes,
  policy,
  policyError,
  nodesError,
  loading,
  onRetry,
  onClose,
  onStarted,
}: {
  nodes: TestNode[];
  policy: TestNodeExecutionPolicy | null;
  policyError: string;
  nodesError: string;
  loading: boolean;
  onRetry: () => void;
  onClose: () => void;
  onStarted: (status: ProbeJobDetail) => void;
}) {
  const [targets, setTargets] = useState('');
  const [exclude, setExclude] = useState('');
  const [sourceUrl, setSourceUrl] = useState(
    () => localStorage.getItem('discover_source_url') || '',
  );
  const [concurrency, setConcurrency] = useState('500');
  const [probeTimeout, setProbeTimeout] = useState('1.5');
  const [autoRoute, setAutoRoute] = useState(
    () => localStorage.getItem('discover_auto_route') === '1',
  );
  const [autoFull, setAutoFull] = useState(false);
  const primaryNode = policy?.primaryNodeId ? nodes.find((node) => node.id === policy.primaryNodeId) : undefined;
  const backupNodes = (policy?.backupNodeIds || []).map((id) => nodes.find((node) => node.id === id)).filter((node): node is TestNode => !!node);
  const policyReady = Boolean(!loading && !nodesError && !policyError && policy?.configured && primaryNode);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (starting || !policyReady) return;
    const url = sourceUrl.trim();
    if (!/^\d+$/.test(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 5000) {
      toast.error('扫描并发需为 1–5000 的整数');
      return;
    }
    if (!Number.isFinite(Number(probeTimeout)) || Number(probeTimeout) <= 0) {
      toast.error('超时需大于 0 秒');
      return;
    }
    if (!targets.trim() && !url) {
      toast.error('请填写目标网段或订阅链接');
      return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      toast.error('订阅链接必须是 http/https 地址');
      return;
    }
    setStarting(true);
    localStorage.setItem('discover_auto_route', autoRoute ? '1' : '0');
    localStorage.setItem('discover_source_url', url);
    try {
      const status = await probeApi.createJob({
        mode: 'discover',
        autoFull,
        targets,
        exclude: exclude.trim() || undefined,
        sourceUrl: url || undefined,
        port: 7000,
        concurrency: concurrency.trim() ? Number(concurrency) : undefined,
        timeout: probeTimeout.trim() ? Number(probeTimeout) : undefined,
        autoRoute,
      });
      toast.success(`扫描已启动（目标 ${status.options.total ?? 0} 个 IP）`);
      onStarted(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启动扫描失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Overlay title="开始扫描（自有网段）" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[11px] leading-4 text-muted-foreground">
          扫描自己有权管理的网段（内网 / 自有 VPS 段），找出开放 frps
          端口的设备；命中自动进入网段发现列表，勾选即可导入服务器库。
          仅做资产发现，请勿扫描未授权网络。
        </p>
        <Field>
          <FieldLabel htmlFor="scan-targets">
            目标网段（CIDR / IP 段 / 单 IP，逗号或换行分隔）
          </FieldLabel>
          <Textarea
            id="scan-targets"
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.254\n172.16.0.1-254'}
            className="max-h-32 font-mono text-xs"
            disabled={starting}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="scan-source-url">
            订阅链接（可选，txt 一行一个网段，下载后与上方目标合并）
          </FieldLabel>
          <Input
            id="scan-source-url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://example.com/subnets.txt"
            disabled={starting}
          />
        </Field>
        <FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="scan-exclude">排除</FieldLabel>
            <Input
              id="scan-exclude"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="10.0.0.1,10.0.9.0/24"
              disabled={starting}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="scan-concurrency">并发</FieldLabel>
            <Input
              id="scan-concurrency"
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              inputMode="numeric"
              disabled={starting}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="scan-timeout">超时（秒）</FieldLabel>
            <Input
              id="scan-timeout"
              value={probeTimeout}
              onChange={(e) => setProbeTimeout(e.target.value)}
              inputMode="decimal"
              disabled={starting}
            />
          </Field>
        </FieldGroup>
        <div className="rounded-md border p-3 text-sm">
          {loading ? <p role="status">正在加载节点与执行策略…</p> : nodesError ? <div className="space-y-2"><p role="alert">节点列表加载失败：{nodesError}</p><Button variant="outline" size="sm" onClick={onRetry}>重试加载</Button></div> : policyError ? <div className="space-y-2"><p role="alert">执行节点策略加载失败：{policyError}</p><Button variant="outline" size="sm" onClick={onRetry}>重试加载策略</Button></div> : policyReady && primaryNode ? <div className="space-y-1">
            <p>主节点：{primaryNode.name}（{primaryNode.online ? '在线' : '离线'}）</p>
            <p>备用节点顺序：{backupNodes.length ? backupNodes.map((node,index)=><span key={node.id}>{index>0?' → ':''}{node.name}（{node.online?'在线':'离线'}）</span>) : '未配置'}</p>
          </div> : <p>尚未配置有效的主节点。</p>}
          {(!loading && !nodesError && (!policyReady || policyError)) && <Link className="mt-2 inline-block underline" to="/test-nodes">前往测试节点设置</Link>}
        </div>
        <p className="text-xs text-muted-foreground">扫描目标服务端口固定为 7000。</p>
        <FieldSet className="gap-2">
          <FieldLegend variant="label">扫描后自动任务</FieldLegend>
          <label className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
            <input
              type="checkbox"
              checked={autoRoute}
              onChange={(e) => setAutoRoute(e.target.checked)}
              disabled={starting}
              className="size-3.5 accent-[var(--primary)]"
            />
            <span className="text-xs">扫描命中后自动路由追踪（各来源独立测 CN2）</span>
          </label>
          <label className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
            <input
              type="checkbox"
              className="size-3.5"
              checked={autoFull}
              onChange={(e) => setAutoFull(e.target.checked)}
              disabled={starting}
            />
            <span className="text-xs">
              命中后自动完整测试（路由 → 连通性 → 速率；仍需手动导入）
            </span>
          </label>
        </FieldSet>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button onClick={start} disabled={starting || !policyReady}>
          <Radar data-icon="inline-start" />
          {starting ? '启动中…' : '开始扫描'}
        </Button>
      </div>
    </Overlay>
  );
}
