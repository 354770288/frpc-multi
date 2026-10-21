import { useState } from 'react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import type { TestNode } from '../../lib/types';
import { Overlay, ConfirmOverlay } from '../../components/Overlay';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/field';
import { formatLastSeen } from '../../lib/format';

export function TestNodesDialog({
  nodes,
  onClose,
  onChanged,
}: {
  nodes: TestNode[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<(TestNode & { token: string }) | null>(null);
  const [deleting, setDeleting] = useState<TestNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const copy = (value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => toast.success('已复制'))
      .catch(() => toast.error('复制失败，请手动复制'));
  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      setCreated(await probeApi.createTestNode(name.trim()));
      setName('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy || !deleting) return;
    setBusy(true);
    setError('');
    try {
      await probeApi.deleteTestNode(deleting.id);
      setDeleting(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay title="测试节点" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-5 text-muted-foreground">
          主控与外部节点均使用独立来源。节点主动领取自己的发现、路由、连通性和速率任务；离线期间排队等待。
        </p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="test-node-name">新增节点名称</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="test-node-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
              <Button disabled={busy || !name.trim()} onClick={create}>
                生成 Token
              </Button>
            </div>
          </Field>
        </FieldGroup>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {created && (
          <section className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-xs font-medium">
              {created.name} · Token 与完整安装命令仅本次显示，请立即保存
            </p>
            <code className="break-all text-xs">{created.token}</code>
            <Button size="sm" variant="outline" onClick={() => copy(created.token)}>
              复制 Token
            </Button>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {created.installCommand}
            </pre>
            <Button size="sm" variant="outline" onClick={() => copy(created.installCommand)}>
              复制安装命令
            </Button>
          </section>
        )}
        <div className="flex max-h-96 flex-col gap-3 overflow-auto">
          {nodes.map((node) => (
            <section key={node.id} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{node.name}</strong>
                <Badge tone={node.online ? 'success' : 'muted'}>
                  {node.online ? '在线' : '离线'}
                </Badge>
                <Badge tone="muted">
                  {node.kind} · {node.version || '版本未知'}
                </Badge>
                {node.id !== 'console' && (
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setDeleting(node)}
                  >
                    删除
                  </Button>
                )}
              </div>
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                ID: {node.id} · {node.tokenMasked} · 最近在线{' '}
                {node.lastSeen ? formatLastSeen(node.lastSeen) : '尚未连接'}
              </p>
              <div className="flex flex-wrap gap-1">
                {node.capabilities.map((cap) => (
                  <Badge key={cap} tone="muted">
                    {cap}
                  </Badge>
                ))}
              </div>
              {node.kind === 'legacy' && (
                <p className="text-xs text-muted-foreground">
                  旧版仅支持路由。使用下方命令升级已部署节点，保留现有 Token
                  配置；升级后可运行完整测试。
                </p>
              )}
              {node.id !== 'console' && (
                <details>
                  <summary className="cursor-pointer text-xs">升级已部署节点</summary>
                  <p className="my-2 text-xs text-muted-foreground">
                    此命令用于已部署节点升级。首次安装需使用创建节点时保存的完整 Token 命令；Token
                    只显示一次。
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-[11px]">
                    {node.installCommand}
                  </pre>
                  <Button size="sm" variant="outline" onClick={() => copy(node.installCommand)}>
                    复制命令
                  </Button>
                </details>
              )}
            </section>
          ))}
        </div>
      </div>
      {deleting && (
        <ConfirmOverlay
          title={`删除测试节点 ${deleting.name}`}
          description="Token 即时失效，该节点待执行任务停止，历史观测保留。"
          confirmLabel={busy ? '删除中…' : '删除'}
          variant="destructive"
          onCancel={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </Overlay>
  );
}
