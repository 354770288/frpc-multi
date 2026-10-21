import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { lbApi, probeApi } from '../../lib/api';
import type { LbSelection, LbSelectionConfig, TestNode } from '../../lib/types';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { formatLastSeen } from '../../lib/format';

export const SELECTION_REASONS: Record<LbSelection['reason'], string> = {
  console_observation: '按主控已有穿透与速率观测选优',
  no_healthy_candidates: '没有健康候选，等待健康检查恢复',
  keep_healthy_current: '当前 IP 健康，但其指定来源观测缺失或过期，保留当前指向',
  node_observation: '按指定节点有效观测选优',
  healthy_ip_order: '指定来源观测缺失或过期，按健康 IP 顺序选择',
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
  const [config, setConfig] = useState<LbSelectionConfig | null>(null);
  const [age, setAge] = useState('24');
  const [nodeId, setNodeId] = useState('console');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.all([probeApi.testNodes(), lbApi.selectionConfig()])
      .then(([list, value]) => {
        if (cancelled) return;
        setNodes(list.items);
        setConfig(value);
        setNodeId(value.nodeId);
        setAge(String(value.maxAgeHours));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '选优配置加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const eligible = (node: TestNode) =>
    node.id === 'console' ||
    ['connectivity', 'speed'].every((cap) => node.capabilities.includes(cap));
  const save = async () => {
    if (!/^\d+$/.test(age) || Number(age) < 1 || Number(age) > 168) {
      setError('观测有效期需为 1–168 小时的整数');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const value = await lbApi.saveSelectionConfig({
        nodeId,
        maxAgeHours: Number(age),
        healthSource: 'console',
      });
      setConfig(value);
      toast.success('全局选优来源已保存');
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
        <CardTitle>全局选优来源</CardTitle>
        <CardDescription>所有域名共享一个稳定国内观测节点；主控持续负责健康检查。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="lb-observation-node">穿透 / 速率观测节点</FieldLabel>
            <Select value={nodeId} onValueChange={setNodeId} disabled={busy || !config}>
              <SelectTrigger id="lb-observation-node">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id} disabled={!eligible(node)}>
                      {node.name}
                      {!eligible(node) ? ' · 需升级' : node.online ? ' · 在线' : ' · 离线'}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
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
          建议选择稳定国内节点，默认使用最近 24
          小时手动或扫描后触发的测量。切换来源和保存配置只读取观测；过期或缺失时保留健康的当前
          IP，或按健康 IP 排序。
        </p>
        {config && (
          <p className="text-xs text-muted-foreground">
            当前保存：{nodes.find((node) => node.id === config.nodeId)?.name || config.nodeId} ·{' '}
            {config.maxAgeHours}h · 健康检查：主控
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button onClick={save} disabled={busy || !config}>
          {busy ? '保存中…' : '保存全局选优配置'}
        </Button>
      </CardContent>
    </Card>
  );
}
