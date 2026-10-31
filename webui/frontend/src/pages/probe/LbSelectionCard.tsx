import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { lbApi, probeApi } from '../../lib/api';
import type { LbSelection, LbSelectionConfig, TestNode, TestNodeExecutionPolicy } from '../../lib/types';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { formatLastSeen } from '../../lib/format';

export const SELECTION_REASONS: Record<LbSelection['reason'], string> = {
  preferred_server: '手动固定目标健康，保持当前选择',
  primary_observation: '按最近一次被接受的测量选优',
  console_observation: '按最近一次被接受的测量选优',
  no_healthy_candidates: '没有健康候选，等待健康检查恢复',
  keep_healthy_current: '当前 IP 仍健康；观测缺失或过期时保留当前指向',
  node_observation: '按最近一次被接受的测量选优',
  healthy_ip_order: '观测缺失或过期，按健康 IP 顺序选择',
};
export function SelectionReason({ selection }: { selection: LbSelection }) {
  return (
    <div className="flex max-w-72 flex-col gap-1 text-[11px] text-muted-foreground">
      <p>{SELECTION_REASONS[selection.reason]}</p>
      <p>
        有效候选 {selection.validCandidates} · 最近观测{' '}
        {selection.observedAt ? formatLastSeen(selection.observedAt) : '—'}
      </p>
      <p>观测有效期 {selection.maxAgeHours}h · 健康来源：主控</p>
    </div>
  );
}
export function LbSelectionCard({ onSaved }: { onSaved: () => void }) {
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [policy, setPolicy] = useState<TestNodeExecutionPolicy | null>(null);
  const [config, setConfig] = useState<LbSelectionConfig | null>(null);
  const [age, setAge] = useState('24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.all([probeApi.testNodes(), probeApi.executionPolicy(), lbApi.selectionConfig()])
      .then(([list, savedPolicy, value]) => {
        if (cancelled) return;
        setNodes(list.items);
        setPolicy(savedPolicy);
        setConfig(value);
        setAge(String(value.maxAgeHours));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '选优配置加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const save = async () => {
    if (!/^\d+$/.test(age) || Number(age) < 1 || Number(age) > 168) {
      setError('观测有效期需为 1–168 小时的整数');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const primaryNodeId = policy?.primaryNodeId;
      if (!primaryNodeId) throw new Error('请先在测试节点设置中配置主用测试节点');
      const value = await lbApi.saveSelectionConfig({
        // Retained for older servers; unified result selection follows saved execution policy.
        nodeId: primaryNodeId,
        maxAgeHours: Number(age),
        healthSource: 'console',
      });
      setConfig(value);
      toast.success('结果有效期已保存');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>全局选优结果</CardTitle>
        <CardDescription>结果跟随统一测量投影；主控继续作为实时健康检查来源。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <div className="space-y-1">
            <FieldLabel>执行策略主用节点</FieldLabel>
            <p className="text-sm">{nodes.find((node) => node.id === policy?.primaryNodeId)?.name || policy?.primaryNodeId || '未配置'}</p>
          </div>
          <Field>
            <FieldLabel htmlFor="lb-observation-age">观测有效期（小时，1–168）</FieldLabel>
            <Input
              id="lb-observation-age"
              type="number"
              min={1}
              max={168}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              disabled={busy || !config}
            />
          </Field>
        </FieldGroup>
        <p className="text-xs leading-5 text-muted-foreground">
          选优读取最近 {age || '24'} 小时内被接受的主用或备用测量；执行来源和任务详情可在测试任务与历史记录中查看。观测过期或缺失时保留仍健康的当前 IP，或按健康 IP 顺序选择。
        </p>
        {config && (
          <p className="text-xs text-muted-foreground">
            当前有效期：{config.maxAgeHours}h · 健康检查：主控
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button onClick={save} disabled={busy || !config || !policy?.primaryNodeId}>
          {busy ? '保存中…' : '保存选优配置'}
        </Button>
      </CardContent>
    </Card>
  );
}
