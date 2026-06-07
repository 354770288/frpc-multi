import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  Network,
  Plus,
  Rocket,
  Server,
  Settings2,
  XCircle
} from 'lucide-react';
import { api, nodesApi } from '../lib/api';
import { shortNodeUuid } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input, Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { ProxyList } from '../components/ProxyList';
import {
  emptyFrpcConfig,
  parseFrpcConfig,
  serializeFrpcConfig,
  validateFrpcDraft,
  type FrpcConfigDraft,
  type ProxyDraft
} from '../lib/proxyToml';
import type { InstanceRef, Node, ToastKind } from '../lib/types';

const INSTANCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

type EditorMode = 'structured' | 'raw';

export function CreateInstance({
  toast,
  instances,
  nodes,
  initialNodeId,
  onCreated,
  onManageNodes,
  onCancel
}: {
  toast: (kind: ToastKind, text: string) => void;
  instances: InstanceRef[];
  nodes: Node[];
  initialNodeId?: number;
  onCreated: (name: string, nodeId: number) => void;
  onManageNodes: () => void;
  onCancel: () => void;
}) {
  const defaultName = useMemo(() => nextClientName(instances), [instances]);
  const initialConfigText = useMemo(() => serializeFrpcConfig(emptyFrpcConfig()), []);
  const resolvedInitialNodeId = useMemo(
    () =>
      initialNodeId && nodes.some((node) => node.id === initialNodeId)
        ? initialNodeId
        : nodes.find((node) => node.online || node.status === 'online')?.id || nodes[0]?.id || 0,
    [initialNodeId, nodes]
  );

  const [name, setName] = useState(defaultName);
  const [nameDirty, setNameDirty] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [startAfterCreate, setStartAfterCreate] = useState(true);
  const [configText, setConfigText] = useState(initialConfigText);
  const [mode, setMode] = useState<EditorMode>('structured');
  const [submitting, setSubmitting] = useState(false);
  const [nodeId, setNodeId] = useState<number>(resolvedInitialNodeId);
  const [nodeDirty, setNodeDirty] = useState(false);

  // Re-sync the suggested name once the instance list arrives (the user
  // hasn't typed yet — let the default catch up to the real instances).
  useEffect(() => {
    if (!nameDirty) setName(nextClientName(instances));
  }, [instances, nameDirty]);

  useEffect(() => {
    if (!nodeDirty) {
      setNodeId(resolvedInitialNodeId);
      return;
    }
    if (nodeId && !nodes.some((node) => node.id === nodeId)) {
      setNodeId(resolvedInitialNodeId);
      setNodeDirty(false);
    }
  }, [nodeDirty, nodeId, nodes, resolvedInitialNodeId]);

  const structured = useMemo(() => parseFrpcConfig(configText), [configText]);
  const structuredErrors = useMemo(() => validateFrpcDraft(structured), [structured]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === nodeId) || null,
    [nodeId, nodes]
  );
  const remotePorts = useMemo(() => {
    const ports = structured.proxies
      .map((proxy) => proxy.remotePort.trim())
      .filter(Boolean);
    return Array.from(new Set(ports));
  }, [structured.proxies]);

  function updateStructured(patch: Partial<FrpcConfigDraft>) {
    const next = { ...structured, ...patch };
    setConfigText(serializeFrpcConfig(next));
  }

  function updateProxies(proxies: ProxyDraft[]) {
    updateStructured({ proxies });
  }

  const nameError = name.trim() === ''
    ? '请填写实例名'
    : INSTANCE_NAME_RE.test(name.trim())
      ? instances.some((item) => item.nodeId === nodeId && item.name === name.trim())
        ? '该实例名已存在'
        : null
      : '只能包含小写字母、数字和短横线，长度 3-40，且不能以短横线开头或结尾';
  const nodeError = nodes.length > 0 && !nodeId ? '请选择节点' : null;
  const validationCount = structuredErrors.length + (nameError ? 1 : 0) + (nodeError ? 1 : 0);

  const canSubmit = !submitting && !nodeError && !nameError && structuredErrors.length === 0;

  if (nodes.length === 0) {
    return (
      <main className="px-6 py-6 max-w-[1600px]">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
        >
          <ArrowLeft size={13} />
          返回节点工作台
        </button>

        <section className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center">
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
            还没有可用节点
          </h2>
          <p className="mx-auto mt-2 max-w-[520px] text-[12px] leading-6 text-[var(--color-fg-muted)]">
            创建实例前需要先添加 Agent 节点。节点接入后，回到工作台选择节点再创建实例，创建页会自动预选该节点。
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onManageNodes}>
              <Plus size={13} />
              添加节点
            </Button>
            <Button onClick={onCancel}>返回节点工作台</Button>
          </div>
        </section>
      </main>
    );
  }

  async function create() {
    if (nameError) {
      toast('error', nameError);
      return;
    }
    if (nodeError) {
      toast('error', nodeError);
      return;
    }
    if (structuredErrors.length) {
      toast('error', structuredErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        displayName,
        description,
        configText,
        enabled,
        startAfterCreate: enabled && startAfterCreate
      };
      if (nodeId > 0) {
        await nodesApi.instances.create(nodeId, payload);
      } else {
        await api('/api/instances', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      toast('success', '实例创建成功');
      onCreated(name.trim(), nodeId);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <button
        onClick={onCancel}
        className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
      >
        <ArrowLeft size={13} />
        返回节点工作台
      </button>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
            创建 frpc 实例
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            依次确认目标节点、frps 连接、代理规则和启动行为。
          </p>
        </div>
        {validationCount === 0 ? (
          <Badge tone="success">校验通过</Badge>
        ) : (
          <Badge tone="warning">
            {validationCount} 项待完善
          </Badge>
        )}
      </div>

      <div className="mb-4 flex items-center gap-1 border-b border-[var(--color-border)]">
        <TabButton active={mode === 'structured'} onClick={() => setMode('structured')}>
          结构化
        </TabButton>
        <TabButton active={mode === 'raw'} onClick={() => setMode('raw')}>
          原始 TOML
        </TabButton>
        <span className="ml-auto text-[11px] text-[var(--color-fg-muted)] pb-2">
          {mode === 'structured'
            ? '按常用字段生成 frpc.toml，适合标准配置'
            : '高级模式；摘要和校验会按当前 TOML 重新解析'}
        </span>
      </div>

      {mode === 'raw' && (
        <div className="mb-4 rounded-lg border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] p-3 text-[12px] leading-5 text-[var(--color-warning)]">
          原始 TOML 模式适合高级配置。切回结构化模式后，只会保留本页面识别的 server/auth/proxies 常用字段。
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          {mode === 'structured' ? (
            <>
              <Panel title={<SectionTitle icon={<Server size={14} />} title="1. 基本信息" />}>
                <div className="flex flex-col gap-4">
                  <Field label="节点" hint="实例会创建到选中的 Agent 节点">
                    <select
                      value={nodeId}
                      onChange={(event) => {
                        setNodeId(Number(event.target.value));
                        setNodeDirty(true);
                      }}
                      className="w-full h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
                    >
                      <option value={0}>请选择节点</option>
                      {nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.name} ({nodeLabel(node)})
                        </option>
                      ))}
                    </select>
                  </Field>
                  {selectedNode && (
                    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-semibold text-[var(--color-fg)]">
                          {selectedNode.name}
                        </span>
                        <Badge tone={nodeIsOnline(selectedNode) ? 'success' : 'danger'}>
                          {nodeLabel(selectedNode)}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-muted)]">
                        uuid {shortNodeUuid(selectedNode.uuid, 8)} · {selectedNode.lastSeenAt ? `最近 ${formatLastSeen(selectedNode.lastSeenAt)}` : '未连接'}
                      </div>
                    </div>
                  )}
                  {nodeError && <ErrorLine>{nodeError}</ErrorLine>}
                  <Field
                    label="实例名"
                    hint="只能包含小写字母、数字和短横线；默认会自动递增 client-NNN"
                  >
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameDirty(true);
                      }}
                      placeholder="client-001"
                      aria-invalid={!!nameError}
                    />
                  </Field>
                  {nameError && (
                    <ErrorLine>{nameError}</ErrorLine>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="显示名称" hint="可选，仅用于界面展示">
                      <Input
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="家里 NAS"
                      />
                    </Field>
                    <Field label="备注描述" hint="可选，方便区分用途">
                      <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="家中 NAS，SSH + 文件下载"
                      />
                    </Field>
                  </div>
                </div>
              </Panel>

              <Panel title={<SectionTitle icon={<Network size={14} />} title="2. frps 连接" />}>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px] gap-4">
                  <Field label="服务器地址" hint="必填，frps 主机名或 IP">
                    <Input
                      value={structured.serverAddr}
                      onChange={(event) => updateStructured({ serverAddr: event.target.value })}
                      placeholder="frps.example.com"
                      aria-invalid={!structured.serverAddr.trim()}
                    />
                  </Field>
                  <Field label="端口" hint="可选，默认 7000">
                    <Input
                      value={structured.serverPort}
                      onChange={(event) => updateStructured({ serverPort: event.target.value })}
                      placeholder="7000"
                      inputMode="numeric"
                    />
                  </Field>
                </div>
                <div className="mt-4">
                  <Field
                    label="认证密钥 (auth.token)"
                    hint="可选，未填则在 TOML 中注释整个 [auth] 段"
                  >
                    <Input
                      type="password"
                      value={structured.authToken}
                      onChange={(event) => updateStructured({ authToken: event.target.value })}
                      placeholder="留空表示 frps 端未启用 token 认证"
                      autoComplete="off"
                    />
                  </Field>
                </div>
              </Panel>

              <Panel title={<SectionTitle icon={<FileCode2 size={14} />} title="3. 代理规则" />}>
                <ProxyList
                  proxies={structured.proxies}
                  onChange={updateProxies}
                  toast={toast}
                  emptyHint="还没有代理。点击「新增代理」开始配置内网穿透。"
                />
              </Panel>
            </>
          ) : (
            <Panel
              title={<SectionTitle icon={<FileCode2 size={14} />} title="原始 TOML" />}
              actions={
                <span className="text-[11px] text-[var(--color-fg-muted)]">
                  高级模式
                </span>
              }
            >
              <Textarea
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                spellCheck={false}
                className="min-h-[480px]"
              />
            </Panel>
          )}

          <Panel title={<SectionTitle icon={<Settings2 size={14} />} title="4. 启动选项" />}>
            <div className="flex flex-col gap-2">
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                label="启用该实例"
                hint="关闭时仅保留配置，不写入 compose.generated.yaml，也不会被启动"
              />
              <Toggle
                checked={enabled && startAfterCreate}
                disabled={!enabled}
                onChange={setStartAfterCreate}
                label="创建后立即启动"
                hint={enabled ? '勾选则在写入后自动 docker compose up' : '需要先启用该实例'}
              />
            </div>
          </Panel>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Panel title={<SectionTitle icon={<Rocket size={14} />} title="创建摘要" />}>
            <div className="flex flex-col gap-3 text-[12px]">
              <SummaryRow label="目标节点">
                <span className="font-medium text-[var(--color-fg)]">
                  {selectedNode ? selectedNode.name : '未选择'}
                </span>
                {selectedNode && (
                  <Badge tone={nodeIsOnline(selectedNode) ? 'success' : 'danger'}>
                    {nodeLabel(selectedNode)}
                  </Badge>
                )}
              </SummaryRow>
              <SummaryRow label="frps">
                <span className="font-mono text-[11px] text-[var(--color-fg)]">
                  {structured.serverAddr.trim() || '未填写'}:{structured.serverPort.trim() || '7000'}
                </span>
              </SummaryRow>
              <SummaryRow label="代理数量">
                <span className="font-mono text-[var(--color-fg)]">{structured.proxies.length}</span>
              </SummaryRow>
              <SummaryRow label="远端端口">
                <span className="font-mono text-[11px] text-[var(--color-fg)]">
                  {remotePorts.length ? remotePorts.join(', ') : '无'}
                </span>
              </SummaryRow>
              <SummaryRow label="将执行">
                <span className="text-right text-[var(--color-fg)]">
                  {enabled
                    ? startAfterCreate
                      ? '写入配置并启动实例'
                      : '写入配置，暂不启动'
                    : '仅保存配置，不启用实例'}
                </span>
              </SummaryRow>
            </div>
          </Panel>

          <Panel title="校验结果">
            <div role="status" aria-live="polite">
              {structuredErrors.length === 0 && !nameError && !nodeError ? (
                <div className="flex items-start gap-2 text-[12px] text-[var(--color-success)]">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>可创建</span>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {nameError && (
                    <li className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nameError}</span>
                    </li>
                  )}
                  {nodeError && (
                    <li className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nodeError}</span>
                    </li>
                  )}
                  {structuredErrors.map((message, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-warning-soft)] text-[12px] text-[var(--color-warning)]"
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel title="创建后自动完成">
            <ul className="flex flex-col gap-2.5 text-[12px] text-[var(--color-fg-muted)]">
              <ChecklistItem>
                写入 <code className="font-mono text-[11px] text-[var(--color-fg)]">instances/{name || '<name>'}/frpc.toml</code>
              </ChecklistItem>
              <ChecklistItem>写入 meta.json</ChecklistItem>
              <ChecklistItem>重新生成 compose.generated.yaml</ChecklistItem>
              {enabled && startAfterCreate && <ChecklistItem>docker compose up -d 启动该实例</ChecklistItem>}
            </ul>
          </Panel>

          <Button variant="primary" onClick={create} disabled={!canSubmit || submitting} className="w-full">
            <Plus size={13} />
            {submitting ? '创建中…' : '创建实例'}
          </Button>
        </aside>
      </section>
    </main>
  );
}

function nextClientName(instances: InstanceRef[]): string {
  const numbers: number[] = [];
  for (const item of instances) {
    const match = /^client-(\d{1,6})$/.exec(item.name);
    if (match) numbers.push(Number(match[1]));
  }
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  return `client-${String(next).padStart(3, '0')}`;
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[var(--color-accent)]">{icon}</span>
      {title}
    </span>
  );
}

function SummaryRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] pb-2 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-[var(--color-fg-muted)]">{label}</span>
      <span className="flex min-w-0 flex-wrap justify-end gap-1.5 text-right">{children}</span>
    </div>
  );
}

function nodeIsOnline(node: Node): boolean {
  return node.online || node.status === 'online';
}

function nodeLabel(node: Node): string {
  if (nodeIsOnline(node)) return '在线';
  if (node.status === 'pending') return '待接入';
  if (node.status === 'offline') return '离线';
  if (node.status === 'error') return '异常';
  return '未知';
}

function formatLastSeen(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const diff = Date.now() - timestamp;
  if (diff < 0) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 -mb-px border-b-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-t-sm ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
          : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
  );
}

function ChecklistItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2
        size={13}
        className="mt-0.5 shrink-0 text-[var(--color-success)]"
      />
      <span>{children}</span>
    </li>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mt-2 inline-flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
      <XCircle size={11} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`mt-0.5 relative inline-flex w-9 h-5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
        }`}
      >
        <span
          className={`absolute top-0.5 inline-block w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-[var(--color-fg)]">{label}</span>
        {hint && <span className="text-[11px] text-[var(--color-fg-muted)]">{hint}</span>}
      </span>
    </label>
  );
}
