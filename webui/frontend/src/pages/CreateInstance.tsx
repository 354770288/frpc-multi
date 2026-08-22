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
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, nodesApi } from '../lib/api';
import { shortNodeUuid } from '../lib/format';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '../components/ui/toggle-group';
import { lbApi } from '../lib/api';
import type { LbDomain } from '../lib/types';
import { EmptyState } from '../components/EmptyState';
import { ProxyList } from '../components/ProxyList';
import { useConsole } from '../context/ConsoleContext';
import {
  emptyFrpcConfig,
  parseFrpcConfig,
  serializeFrpcConfig,
  validateFrpcDraft,
  type FrpcConfigDraft,
  type ProxyDraft
} from '../lib/proxyToml';
import type { InstanceRef, Node } from '../lib/types';

const INSTANCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

type EditorMode = 'structured' | 'raw';

export function CreateInstance() {
  const { instances, nodes, workspaceNodeId, refreshAll } = useConsole();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialNodeId = workspaceNodeId === 'all' ? undefined : workspaceNodeId;
  const defaultName = useMemo(() => nextClientName(instances), [instances]);
  // 穿透测试页联动：/create?server=<ip>&port=<port> 预填 frps 地址
  const initialConfigText = useMemo(() => {
    const draft = emptyFrpcConfig();
    const server = searchParams.get('server')?.trim();
    const port = searchParams.get('port')?.trim();
    if (server) draft.serverAddr = server;
    if (server && port && /^\d+$/.test(port)) draft.serverPort = port;
    return serializeFrpcConfig(draft);
  }, [searchParams]);
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

  // 负载均衡候选域名（地址来源切换）
  const [addrSource, setAddrSource] = useState<'manual' | 'lb'>('manual');
  const [lbDomains, setLbDomains] = useState<LbDomain[]>([]);
  useEffect(() => {
    lbApi.domains()
      .then((list) => setLbDomains(list.filter((domain) => domain.enabled)))
      .catch(() => { /* 未配置 Cloudflare 时静默，手动输入不受影响 */ });
  }, []);

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
  const selectedLbDomain = useMemo(
    () => lbDomains.find((domain) => domain.name === structured.serverAddr) || null,
    [lbDomains, structured.serverAddr]
  );
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
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/workspace')}
          className="mb-4 -ml-3 text-muted-foreground"
        >
          <ArrowLeft data-icon="inline-start" />
          返回节点工作台
        </Button>

        <EmptyState
          title="还没有可用节点"
          actions={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => navigate('/nodes')}>
                <Plus size={13} />
                添加节点
              </Button>
              <Button variant="outline" onClick={() => navigate('/workspace')}>返回节点工作台</Button>
            </div>
          }
        />
      </main>
    );
  }

  async function create() {
    if (nameError) {
      toast.error(nameError);
      return;
    }
    if (nodeError) {
      toast.error(nodeError);
      return;
    }
    if (structuredErrors.length) {
      toast.error(structuredErrors[0]);
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
      toast.success('实例创建成功');
      await refreshAll();
      navigate(`/instances/${nodeId}/${encodeURIComponent(name.trim())}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/workspace')}
        className="mb-4 -ml-3 text-muted-foreground"
      >
        <ArrowLeft data-icon="inline-start" />
        返回节点工作台
      </Button>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            创建 frpc 实例
          </h2>
        </div>
        {validationCount === 0 ? (
          <Badge tone="success">校验通过</Badge>
        ) : (
          <Badge tone="warning">
            {validationCount} 项待完善
          </Badge>
        )}
      </div>

      <Tabs value={mode} onValueChange={(value) => setMode(value as EditorMode)} className="mb-4">
        <TabsList>
          <TabsTrigger value="structured">结构化</TabsTrigger>
          <TabsTrigger value="raw">原始 TOML</TabsTrigger>
        </TabsList>
      </Tabs>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          {mode === 'structured' ? (
            <>
              <FormSection title={<SectionTitle icon={<Server size={14} />} title="1. 基本信息" />}>
                <div className="flex flex-col gap-4">
                  <Field label="节点">
                    <Select
                      value={String(nodeId)}
                      onValueChange={(value) => {
                        setNodeId(Number(value));
                        setNodeDirty(true);
                      }}
                    >
                      <SelectTrigger aria-label="节点" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="0">请选择节点</SelectItem>
                          {nodes.map((node) => (
                            <SelectItem key={node.id} value={String(node.id)}>
                              {node.name} ({nodeLabel(node)})
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  {selectedNode && (
                    <div className="rounded-lg border border-border bg-muted p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-semibold text-foreground">
                          {selectedNode.name}
                        </span>
                        <Badge tone={nodeIsOnline(selectedNode) ? 'success' : 'danger'}>
                          {nodeLabel(selectedNode)}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        uuid {shortNodeUuid(selectedNode.uuid, 8)} · {selectedNode.lastSeenAt ? `最近 ${formatLastSeen(selectedNode.lastSeenAt)}` : '未连接'}
                      </div>
                    </div>
                  )}
                  {nodeError && <ErrorLine>{nodeError}</ErrorLine>}
                  <Field label="实例名">
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
                    <Field label="显示名称">
                      <Input
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="家里 NAS"
                      />
                    </Field>
                    <Field label="备注描述">
                      <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="家中 NAS，SSH + 文件下载"
                      />
                    </Field>
                  </div>
                </div>
              </FormSection>

              <FormSection title={<SectionTitle icon={<Network size={14} />} title="2. frps 连接" />}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">地址来源</span>
                  <ToggleGroup
                    type="single"
                    value={addrSource}
                    onValueChange={(value) => {
                      if (value) setAddrSource(value as 'manual' | 'lb');
                    }}
                  >
                    <ToggleGroupItem value="manual" className="text-xs">手动输入</ToggleGroupItem>
                    <ToggleGroupItem value="lb" className="text-xs" disabled={!lbDomains.length}
                      title={lbDomains.length ? undefined : '暂无负载均衡域名'}>负载均衡域名</ToggleGroupItem>
                  </ToggleGroup>
                  {!lbDomains.length && (
                    <span className="text-[11px] text-muted-foreground">
                      还没有候选域名，<Link to="/lb" className="text-primary underline underline-offset-2">去负载均衡创建 →</Link>
                    </span>
                  )}
                  {addrSource === 'lb' && selectedLbDomain && (
                    selectedLbDomain.poolSize > 0 ? (
                      <Badge tone="success">
                        {selectedLbDomain.name} · 池 {selectedLbDomain.poolSize} 台
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        {selectedLbDomain.name} · 空池，<Link to="/probe" className="underline underline-offset-2">去服务器库入组 →</Link>
                      </Badge>
                    )
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px] gap-4">
                  {addrSource === 'manual' ? (
                    <Field label="服务器地址">
                      <Input
                        value={structured.serverAddr}
                        onChange={(event) => updateStructured({ serverAddr: event.target.value })}
                        placeholder="frps.example.com"
                        aria-invalid={!structured.serverAddr.trim()}
                      />
                    </Field>
                  ) : (
                    <Field label="候选域名（DNS 轮询负载均衡）">
                      <Select
                        value={lbDomains.some((d) => d.name === structured.serverAddr) ? structured.serverAddr : ''}
                        onValueChange={(value) => updateStructured({ serverAddr: value })}
                      >
                        <SelectTrigger aria-invalid={!structured.serverAddr.trim()}>
                          <SelectValue placeholder="选择候选域名" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {lbDomains.map((domain) => (
                              <SelectItem key={domain.id} value={domain.name}>
                                {domain.name}（池 {domain.poolSize} 台）
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                  <Field label="端口">
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
              </FormSection>

              <FormSection title={<SectionTitle icon={<FileCode2 size={14} />} title="3. 代理规则" />}>
                  <ProxyList
                    proxies={structured.proxies}
                    onChange={updateProxies}
                    emptyHint="还没有代理。点击「新增代理」开始配置内网穿透。"
                  />
              </FormSection>
            </>
          ) : (
            <FormSection
              title={<SectionTitle icon={<FileCode2 size={14} />} title="原始 TOML" />}
            >
              <Textarea
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                spellCheck={false}
                className="min-h-[480px]"
              />
            </FormSection>
          )}

          <FormSection title={<SectionTitle icon={<Settings2 size={14} />} title="4. 启动选项" />}>
            <div className="flex flex-col gap-2">
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                label="启用该实例"
              />
              <Toggle
                checked={enabled && startAfterCreate}
                disabled={!enabled}
                onChange={setStartAfterCreate}
                label="创建后立即启动"
              />
            </div>
          </FormSection>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <FormSection title={<SectionTitle icon={<Rocket size={14} />} title="创建摘要" />}>
            <div className="flex flex-col gap-3 text-[12px]">
              <SummaryRow label="目标节点">
                <span className="font-medium text-foreground">
                  {selectedNode ? selectedNode.name : '未选择'}
                </span>
                {selectedNode && (
                  <Badge tone={nodeIsOnline(selectedNode) ? 'success' : 'danger'}>
                    {nodeLabel(selectedNode)}
                  </Badge>
                )}
              </SummaryRow>
              <SummaryRow label="frps">
                <span className="font-mono text-[11px] text-foreground">
                  {structured.serverAddr.trim() || '未填写'}:{structured.serverPort.trim() || '7000'}
                </span>
              </SummaryRow>
              <SummaryRow label="代理数量">
                <span className="font-mono text-foreground">{structured.proxies.length}</span>
              </SummaryRow>
              <SummaryRow label="远端端口">
                <span className="font-mono text-[11px] text-foreground">
                  {remotePorts.length ? remotePorts.join(', ') : '无'}
                </span>
              </SummaryRow>
              <SummaryRow label="将执行">
                <span className="text-right text-foreground">
                  {enabled
                    ? startAfterCreate
                      ? '写入配置并启动实例'
                      : '写入配置，暂不启动'
                    : '仅保存配置，不启用实例'}
                </span>
              </SummaryRow>
            </div>
          </FormSection>

          <FormSection title="校验结果">
            <div role="status" aria-live="polite">
              {structuredErrors.length === 0 && !nameError && !nodeError ? (
                <div className="flex items-start gap-2 text-[12px] text-primary">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>可创建</span>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {nameError && (
                    <li className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-[12px] text-destructive">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nameError}</span>
                    </li>
                  )}
                  {nodeError && (
                    <li className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-[12px] text-destructive">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nodeError}</span>
                    </li>
                  )}
                  {structuredErrors.map((message, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 p-2 rounded-md bg-secondary text-[12px] text-secondary-foreground"
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </FormSection>

          <Button variant="default" onClick={create} disabled={!canSubmit || submitting} className="w-full">
            <Plus size={13} />
            {submitting ? '创建中…' : '创建实例'}
          </Button>
        </aside>
      </section>
    </main>
  );
}

function FormSection({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden rounded-lg border border-border py-0 shadow-sm ring-0">
      <CardHeader className="rounded-t-none border-b bg-muted/50 px-4 py-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-4">{children}</CardContent>
    </Card>
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
      <span className="text-primary">{icon}</span>
      {title}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-5 text-muted-foreground">{hint}</p>}
    </div>
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
    <div className="flex items-start justify-between gap-3 border-b border-border pb-2 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
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

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mt-2 inline-flex items-start gap-1.5 text-[11px] text-destructive">
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
      <Switch
        checked={checked}
        onCheckedChange={(next) => !disabled && onChange(next)}
        disabled={disabled}
        aria-label={label}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
