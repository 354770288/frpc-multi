import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  FileCode2,
  Network,
  Plus,
  Rocket,
  Server,
  XCircle,
} from 'lucide-react';
import { Link, useBlocker, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, lbApi, nodesApi } from '../lib/api';
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
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { EmptyState } from '../components/EmptyState';
import { ConfirmOverlay } from '../components/Overlay';
import { PageHeader, PageShell } from '../components/PageHeader';
import { ProxyList } from '../components/ProxyList';
import { useConsole } from '../context/ConsoleContext';
import {
  canEditFullConfigStructurally,
  emptyFrpcConfig,
  parseFrpcConfig,
  serializeFrpcConfig,
  validateFrpcDraft,
  type FrpcConfigDraft,
  type ProxyDraft,
} from '../lib/proxyToml';
import type { InstanceDetail, InstanceRef, LbDomain, Node } from '../lib/types';

const INSTANCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

type EditorMode = 'structured' | 'raw';

export function CreateInstance() {
  const { instances, nodes, workspaceNodeId, refreshAll } = useConsole();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialNodeId = workspaceNodeId === 'all' ? undefined : workspaceNodeId;
  const cloneNodeParam = searchParams.get('cloneNode');
  const cloneNameParam = searchParams.get('cloneName')?.trim() || '';
  const defaultName = useMemo(() => nextClientName(instances), [instances]);

  const initialConfigText = useMemo(() => {
    const draft = emptyFrpcConfig();
    const server = searchParams.get('server')?.trim();
    const port = searchParams.get('port')?.trim();
    if (server) draft.serverAddr = server;
    if (server && port && /^\d+$/.test(port)) draft.serverPort = port;
    return serializeFrpcConfig(draft);
  }, [searchParams]);

  const resolvedInitialNodeId = useMemo(() => {
    const cloneNid = cloneNodeParam ? Number(cloneNodeParam) : NaN;
    if (Number.isFinite(cloneNid) && nodes.some((n) => n.id === cloneNid)) return cloneNid;
    return initialNodeId && nodes.some((node) => node.id === initialNodeId)
      ? initialNodeId
      : nodes.find((node) => node.online || node.status === 'online')?.id || nodes[0]?.id || 0;
  }, [cloneNodeParam, initialNodeId, nodes]);

  const [name, setName] = useState(defaultName);
  const [nameDirty, setNameDirty] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [configText, setConfigText] = useState(initialConfigText);
  const [baselineConfigText, setBaselineConfigText] = useState(initialConfigText);
  const [mode, setMode] = useState<EditorMode>('structured');
  const [submitting, setSubmitting] = useState(false);
  const [cloningLoading, setCloningLoading] = useState(false);
  const [nodeId, setNodeId] = useState<number>(resolvedInitialNodeId);
  const [nodeDirty, setNodeDirty] = useState(false);

  const draftDirty =
    nameDirty || nodeDirty || !!displayName || !!description || configText !== baselineConfigText || !enabled;
  const blocker = useBlocker(draftDirty && !submitting);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draftDirty]);

  const structuredSafe = canEditFullConfigStructurally(configText);
  useEffect(() => {
    if (!structuredSafe && mode === 'structured') setMode('raw');
  }, [structuredSafe, mode]);

  const [addrSource, setAddrSource] = useState<'manual' | 'lb'>('manual');
  const [lbDomains, setLbDomains] = useState<LbDomain[]>([]);
  useEffect(() => {
    lbApi
      .domains()
      .then((list) => setLbDomains(list.filter((domain) => domain.enabled)))
      .catch(() => {});
  }, []);

  // 支持一键克隆现有实例配置
  useEffect(() => {
    if (!cloneNameParam) return;
    const sourceNodeId = Number(cloneNodeParam || 0);
    let cancelled = false;
    setCloningLoading(true);
    Promise.all([
      sourceNodeId > 0
        ? nodesApi.instances.get(sourceNodeId, cloneNameParam).catch(() => null)
        : api<InstanceDetail>(`/api/instances/${encodeURIComponent(cloneNameParam)}`).catch(() => null),
      sourceNodeId > 0
        ? nodesApi.instances.getConfig(sourceNodeId, cloneNameParam)
        : api<{ configText: string }>(`/api/instances/${encodeURIComponent(cloneNameParam)}/config`),
    ])
      .then(([detail, cfg]) => {
        if (cancelled) return;
        if (detail?.displayName) setDisplayName(`${detail.displayName}-副本`);
        if (detail?.description) setDescription(detail.description);
        if (cfg?.configText) {
          setConfigText(cfg.configText);
          setBaselineConfigText(cfg.configText);
          setMode(canEditFullConfigStructurally(cfg.configText) ? 'structured' : 'raw');
        }
        toast.success(`已从实例 ${cloneNameParam} 载入配置草稿`);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : '克隆源实例读取失败');
      })
      .finally(() => {
        if (!cancelled) setCloningLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cloneNameParam, cloneNodeParam]);

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
    [lbDomains, structured.serverAddr],
  );

  // 若克隆或预填地址刚好匹配某个优选域名，自动切换到候选域名模式显示
  useEffect(() => {
    if (structured.serverAddr && lbDomains.some((d) => d.name === structured.serverAddr)) {
      setAddrSource('lb');
    }
  }, [lbDomains, structured.serverAddr]);

  const structuredErrors = useMemo(() => validateFrpcDraft(structured), [structured]);
  const selectedNode = useMemo(() => nodes.find((node) => node.id === nodeId) || null, [nodeId, nodes]);
  const remotePorts = useMemo(() => {
    const ports = structured.proxies.map((proxy) => proxy.remotePort.trim()).filter(Boolean);
    return Array.from(new Set(ports));
  }, [structured.proxies]);

  function updateStructured(patch: Partial<FrpcConfigDraft>) {
    if (!structuredSafe) {
      setMode('raw');
      toast.error('当前 TOML 含有无法由结构化表单保留的内容，请使用原始文本编辑');
      return;
    }
    const next = { ...structured, ...patch };
    setConfigText(serializeFrpcConfig(next));
  }

  function updateProxies(proxies: ProxyDraft[]) {
    updateStructured({ proxies });
  }

  const nameError =
    name.trim() === ''
      ? '请填写实例名'
      : INSTANCE_NAME_RE.test(name.trim())
        ? instances.some((item) => item.nodeId === nodeId && item.name === name.trim())
          ? '该实例名已存在'
          : null
        : '只能包含小写字母、数字和短横线，长度 3-40，且不能以短横线开头或结尾';
  const nodeError = nodes.length > 0 && !nodeId ? '请选择节点' : null;
  const validationErrors = mode === 'structured' ? structuredErrors : [];
  const validationCount = validationErrors.length + (nameError ? 1 : 0) + (nodeError ? 1 : 0);
  const canSubmit = !submitting && !cloningLoading && !nodeError && !nameError && validationErrors.length === 0 && !!configText.trim();

  if (nodes.length === 0) {
    return (
      <PageShell>
        <PageHeader
          back={
            <Button variant="ghost" size="sm" onClick={() => navigate('/instances')} className="-ml-2 text-muted-foreground">
              <ArrowLeft data-icon="inline-start" />返回实例列表
            </Button>
          }
          title="创建 frpc 实例"
        />
        <EmptyState
          title="还没有可用节点"
          actions={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => navigate('/nodes')}>
                <Plus size={13} />添加节点
              </Button>
              <Button variant="outline" onClick={() => navigate('/instances')}>返回实例列表</Button>
            </div>
          }
        />
      </PageShell>
    );
  }

  async function create(startImmediately: boolean) {
    if (nameError) {
      toast.error(nameError);
      return;
    }
    if (nodeError) {
      toast.error(nodeError);
      return;
    }
    if (validationErrors.length) {
      toast.error(validationErrors[0]);
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
        startAfterCreate: enabled && startImmediately,
      };
      if (nodeId > 0) {
        await nodesApi.instances.create(nodeId, payload);
      } else {
        await api('/api/instances', {
          method: 'POST',
          body: JSON.stringify(payload),
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
    <PageShell maxWidth="full" className="max-w-[1550px]">
      <PageHeader
        back={
          <Button variant="ghost" size="sm" onClick={() => navigate('/instances')} className="-ml-2 h-7 text-xs text-muted-foreground">
            <ArrowLeft className="size-3.5" data-icon="inline-start" />返回实例列表
          </Button>
        }
        title={cloneNameParam ? `克隆创建实例（源：${cloneNameParam}）` : '创建 frpc 实例'}
        badge={
          validationCount === 0 ? (
            <Badge tone="success">校验通过</Badge>
          ) : (
            <Badge tone="warning">{validationCount} 项待完善</Badge>
          )
        }
        description="一屏配置部署节点、frps 连接（支持绑定优选域名）与代理规则，右侧实时预览 TOML 并一键创建"
        actions={
          <Tabs value={mode} onValueChange={(value) => setMode(value as EditorMode)}>
            <TabsList>
              <TabsTrigger value="structured" disabled={!structuredSafe} className="text-xs">
                结构化表单
              </TabsTrigger>
              <TabsTrigger value="raw" className="text-xs">
                原始 TOML
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {!structuredSafe && (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          配置含有结构化编辑无法保留的内容，已切换为原始 TOML 编辑。
        </p>
      )}

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_390px] lg:items-start">
        <div className="flex flex-col gap-5">
          {/* 1. 基本信息 */}
          <FormSection title={<SectionTitle icon={<Server size={14} />} title="1. 部署节点与实例标识" />}>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                  {nodeError && <ErrorLine>{nodeError}</ErrorLine>}
                </Field>

                <Field label="实例名">
                  <Input
                    value={name}
                    aria-label="实例名"
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameDirty(true);
                    }}
                    placeholder="client-001"
                    aria-invalid={!!nameError}
                  />
                  {nameError && <ErrorLine>{nameError}</ErrorLine>}
                </Field>
              </div>

              {selectedNode && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{selectedNode.name}</span>
                    <Badge tone={nodeIsOnline(selectedNode) ? 'success' : 'danger'}>
                      {nodeLabel(selectedNode)}
                    </Badge>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    uuid {shortNodeUuid(selectedNode.uuid, 8)} · {selectedNode.lastSeenAt ? `最近 ${formatLastSeen(selectedNode.lastSeenAt)}` : '未连接'}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="显示名称">
                  <Input
                    value={displayName}
                    aria-label="显示名称"
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="如：家里 NAS / 深圳 ERP"
                  />
                </Field>
                <Field label="备注描述">
                  <Input
                    value={description}
                    aria-label="备注描述"
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="如：SSH + Web 业务转发"
                  />
                </Field>
              </div>
            </div>
          </FormSection>

          {mode === 'structured' ? (
            <>
              {/* 2. frps 连接 */}
              <FormSection title={<SectionTitle icon={<Network size={14} />} title="2. frps 服务端连接" />}>
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
                    <ToggleGroupItem
                      value="lb"
                      className="text-xs"
                      disabled={!lbDomains.length}
                      title={lbDomains.length ? undefined : '暂无候选域名'}
                    >
                      优选域名
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {!lbDomains.length && (
                    <span className="text-[11px] text-muted-foreground">
                      还没有优选域名，<Link to="/lb" className="text-primary underline underline-offset-2">去域名选优创建 →</Link>
                    </span>
                  )}
                  {addrSource === 'lb' && selectedLbDomain && (
                    selectedLbDomain.poolSize > 0 ? (
                      <Badge tone="success">
                        {selectedLbDomain.name} · 候选池 {selectedLbDomain.poolSize} 台
                        {selectedLbDomain.currentIp ? ` · 当前 ${selectedLbDomain.currentIp}` : ''}
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        {selectedLbDomain.name} · 空池，<Link to="/lb" className="underline underline-offset-2">去配置候选 →</Link>
                      </Badge>
                    )
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_140px]">
                  {addrSource === 'manual' ? (
                    <Field label="服务器地址">
                      <Input
                        value={structured.serverAddr}
                        aria-label="服务器地址"
                        onChange={(event) => updateStructured({ serverAddr: event.target.value })}
                        placeholder="frps.example.com"
                        aria-invalid={!structured.serverAddr.trim()}
                      />
                    </Field>
                  ) : (
                    <Field label="优选域名（故障与 GFW 屏蔽自动切换）">
                      <Select
                        value={lbDomains.some((d) => d.name === structured.serverAddr) ? structured.serverAddr : ''}
                        onValueChange={(value) => updateStructured({ serverAddr: value })}
                      >
                        <SelectTrigger aria-label="候选域名" aria-invalid={!structured.serverAddr.trim()}>
                          <SelectValue placeholder="选择优选域名" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {lbDomains.map((domain) => (
                              <SelectItem key={domain.id} value={domain.name}>
                                {domain.name}（池 {domain.poolSize} 台{domain.currentIp ? ` · ${domain.currentIp}` : ''}）
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
                      aria-label="端口"
                      onChange={(event) => updateStructured({ serverPort: event.target.value })}
                      placeholder="7000"
                      inputMode="numeric"
                    />
                  </Field>
                </div>

                <div className="mt-4">
                  <Field label="认证密钥 (auth.token)">
                    <Input
                      type="password"
                      value={structured.authToken}
                      aria-label="认证密钥"
                      onChange={(event) => updateStructured({ authToken: event.target.value })}
                      placeholder="留空表示 frps 端未启用 token 认证"
                      autoComplete="off"
                    />
                  </Field>
                </div>
              </FormSection>

              {/* 3. 代理规则 */}
              <FormSection title={<SectionTitle icon={<FileCode2 size={14} />} title="3. 穿透代理规则 ([[proxies]])" />}>
                <ProxyList
                  proxies={structured.proxies}
                  onChange={updateProxies}
                  emptyHint="还没有代理。点击「新增代理」添加内网穿透映射（也可以创建空代理实例后续再配）。"
                />
              </FormSection>
            </>
          ) : (
            <FormSection title={<SectionTitle icon={<FileCode2 size={14} />} title="2. 原始 TOML 配置" />}>
              <Textarea
                value={configText}
                aria-label="原始 TOML 配置"
                onChange={(event) => setConfigText(event.target.value)}
                spellCheck={false}
                className="min-h-[420px] font-mono text-xs"
              />
            </FormSection>
          )}
        </div>

        {/* 右侧粘性预览与提交区 */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          <FormSection title={<SectionTitle icon={<Rocket size={14} />} title="创建摘要与启动策略" />}>
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
              <SummaryRow label="实例名">
                <span className="font-mono text-foreground">{name.trim() || '未填写'}</span>
              </SummaryRow>
              <SummaryRow label="frps 目标">
                <span className="font-mono text-[11px] text-foreground">
                  {structured.serverAddr.trim() || '未填写'}:{structured.serverPort.trim() || '7000'}
                </span>
              </SummaryRow>
              <SummaryRow label="代理 / 远端端口">
                <span className="font-mono text-[11px] text-foreground">
                  {structured.proxies.length} 条{remotePorts.length ? ` · :${remotePorts.join(', :')}` : ''}
                </span>
              </SummaryRow>

              <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
                <Toggle
                  checked={enabled}
                  onChange={setEnabled}
                  label="启用该实例"
                  hint="停用状态下仅保存配置，不会拉起 Docker 容器"
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="实时校验">
            <div role="status" aria-live="polite">
              {validationErrors.length === 0 && !nameError && !nodeError ? (
                <div className="flex items-start gap-2 text-[12px] text-primary">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>配置完整合法，可立即创建</span>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {nameError && (
                    <li className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-[12px] text-destructive">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nameError}</span>
                    </li>
                  )}
                  {nodeError && (
                    <li className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-[12px] text-destructive">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nodeError}</span>
                    </li>
                  )}
                  {validationErrors.map((message, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 rounded-md bg-secondary p-2 text-[12px] text-secondary-foreground"
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </FormSection>

          <FormSection title={<SectionTitle icon={<Code2 size={14} />} title="TOML 实时预览" />}>
            <pre className="max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap">
              {configText}
            </pre>
          </FormSection>

          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="outline" onClick={() => void create(false)} disabled={!canSubmit}>
              仅创建
            </Button>
            <Button onClick={() => void create(true)} disabled={!canSubmit || !enabled}>
              <Plus size={14} data-icon="inline-start" />
              {submitting ? '创建中…' : '创建并启动'}
            </Button>
          </div>
        </aside>
      </section>

      {blocker.state === 'blocked' && (
        <ConfirmOverlay
          title="离开未保存的实例配置"
          description="当前实例草稿尚未保存，离开后填写内容会丢失。"
          confirmLabel="放弃草稿并离开"
          variant="destructive"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      )}
    </PageShell>
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
    <Card className="gap-0 overflow-hidden rounded-xl border border-border py-0 shadow-2xs ring-0">
      <CardHeader className="rounded-t-none border-b bg-muted/35 px-4 py-3">
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
  children,
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
    <div className="inline-flex items-start gap-1.5 text-[11px] text-destructive">
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
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
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
