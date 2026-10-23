import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RotateCcw, Save, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, nodesApi } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { ProxyList } from '../components/ProxyList';
import { canEditProxiesStructurally, parseProxies, rewriteProxies, splitTomlAtProxies, type ProxyDraft } from '../lib/proxyToml';
import { ConfirmOverlay } from '../components/Overlay';
import { useConsole } from '../context/ConsoleContext';
import type { InstanceRef, ValidationData } from '../lib/types';

export function ConfigEditorPanel({
  instance,
  embedded = false,
  onSaved,
}: {
  instance: InstanceRef;
  embedded?: boolean;
  onSaved?: () => void;
}) {
  const [configText, setConfigText] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validationText,setValidationText] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'structured' | 'raw'>('structured');
  const [resetPending,setResetPending] = useState(false);
  const validationId=useRef(0);
  const loadId=useRef(0);
  const name = instance.name;
  const ik = `${instance.nodeId}:${instance.name}`;

  useEffect(() => {
    const id=++loadId.current;
    const req = instance.nodeId > 0
      ? nodesApi.instances.getConfig(instance.nodeId, instance.name)
      : api<{ configText: string; validation: ValidationData }>(`/api/instances/${instance.name}/config`);
    req.then((d) => { if(id!==loadId.current)return; setConfigText(d.configText); setOriginalText(d.configText); setValidation(d.validation);setValidationText(d.configText);setMode(canEditProxiesStructurally(d.configText) ? 'structured' : 'raw'); })
      .catch((err) => { if(id!==loadId.current)return; setConfigText(''); setOriginalText(''); setValidation(null); toast.error(err instanceof Error ? err.message : '配置加载失败'); });
    return () => { loadId.current++; };
  }, [ik]);

  useEffect(() => {
    const id=++validationId.current;
    if (configText === originalText) { setValidating(false);return; }
    setValidation(null);setValidating(true);
    const h = window.setTimeout(async () => {
      try {
        const r = instance.nodeId > 0
          ? await nodesApi.instances.validateConfig(instance.nodeId, instance.name, configText)
          : await api<ValidationData>(`/api/instances/${instance.name}/config/validate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: configText });
        if(id===validationId.current){setValidation(r);setValidationText(configText);}
      } catch (err) { if(id===validationId.current)toast.error(err instanceof Error ? err.message : '配置校验失败'); }
      finally { if(id===validationId.current)setValidating(false); }
    }, 500);
    return () => { validationId.current++;window.clearTimeout(h); };
  }, [ik, configText, originalText]);

  const dirty = configText !== originalText;
  const validationCurrent=!!validation && validationText===configText;
  const blocker=useBlocker(dirty && !saving);
  useEffect(() => {
    const onBeforeUnload=(event:BeforeUnloadEvent)=>{if(!dirty)return;event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',onBeforeUnload);
    return ()=>window.removeEventListener('beforeunload',onBeforeUnload);
  },[dirty]);
  const structuredSafe=canEditProxiesStructurally(configText);
  useEffect(()=>{ if(!structuredSafe && mode==='structured')setMode('raw'); },[structuredSafe,mode]);
  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = validation?.summary;
  let sb: { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string };
  if (validating) sb = { tone: 'muted', label: '校验中…' };
  else if (validationCurrent && errors.length) sb = { tone: 'danger', label: `${errors.length} 个错误` };
  else if (dirty) sb = { tone: 'warning', label: '未保存' };
  else sb = { tone: 'success', label: '已同步' };

  async function save(restartAfterSave: boolean) {
    if (!dirty || !validationCurrent || validating || validation?.errors.length || saving) return;
    const snapshot=configText;
    setSaving(true);
    try {
      if (instance.nodeId > 0) await nodesApi.instances.updateConfig(instance.nodeId, instance.name, { configText:snapshot, restartAfterSave });
      else await api(`/api/instances/${instance.name}/config`, { method: 'PUT', body: JSON.stringify({ configText:snapshot, restartAfterSave }) });
      setOriginalText(snapshot);
      toast.success(restartAfterSave ? '已保存并重启容器' : '已保存');
      onSaved?.();
    } catch (err) { toast.error(err instanceof Error ? err.message : '保存失败'); }
    finally { setSaving(false); }
  }
  async function reset() {
    try {
      const d = await api<{ configText: string }>(`/api/config/default?name=${encodeURIComponent(instance.name)}`);
      setConfigText(d.configText);
      toast.info('已载入默认配置，未保存前不会写入磁盘');
    } catch (err) { toast.error(err instanceof Error ? err.message : '载入默认配置失败'); }
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={()=>setResetPending(true)} disabled={saving}><RotateCcw size={13} />重置为默认</Button>
      <Button size="sm" variant="outline" onClick={()=>void save(false)} disabled={!dirty || saving || validating || !validationCurrent || !!errors.length}><Save size={13} />保存</Button>
      <Button size="sm" onClick={()=>void save(true)} disabled={!dirty || saving || validating || !validationCurrent || !!errors.length}>{saving ? '保存中…' : '保存并重启'}</Button>
    </div>
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold">编辑配置</h2>
        <span className="text-xs text-muted-foreground font-mono">{name} / frpc.toml</span>
        <Badge tone={sb.tone}>{sb.label}</Badge>
      </div>
      {!structuredSafe && <p role="status" className="mb-3 rounded-md border border-warning/40 p-3 text-sm text-warning">此配置包含结构化编辑尚未覆盖的字段或注释。请在原始 TOML 中编辑，原文会完整保留。</p>}
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'structured' | 'raw')}>
        <div className="flex items-center gap-1 border-b mb-4">
          <TabsList className="border-0 bg-transparent p-0">
            <TabsTrigger value="structured" disabled={!structuredSafe} className="data-[state=active]:bg-transparent text-xs">代理（结构化）</TabsTrigger>
            <TabsTrigger value="raw" className="data-[state=active]:bg-transparent text-xs">原始 TOML</TabsTrigger>
          </TabsList>
          <span className="ml-auto text-[11px] text-muted-foreground">{mode === 'structured' ? '结构化编辑只影响 [[proxies]] 段' : '完整文本模式'}</span>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <TabsContent value="structured" className="mt-0">
            <Card><CardHeader className="flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm">代理列表</CardTitle>{header}</CardHeader><CardContent><SpEditor configText={configText} onChange={setConfigText} /></CardContent></Card>
          </TabsContent>
          <TabsContent value="raw" className="mt-0">
            <Card><CardHeader className="flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm">配置内容</CardTitle>{header}</CardHeader><CardContent><Textarea value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} className="min-h-[420px]" /></CardContent></Card>
          </TabsContent>
          <aside className="space-y-4">
            <Card><CardHeader><CardTitle className="text-sm">校验结果</CardTitle></CardHeader><CardContent role="status" aria-live="polite">
              {!validation ? <p className="text-xs text-muted-foreground">等待校验…</p>
                : errors.length === 0 && warnings.length === 0 ? <div className="flex items-start gap-2 text-xs text-primary"><CheckCircle2 size={14} className="mt-0.5 shrink-0" /><span>配置合法，可保存</span></div>
                : <div className="space-y-2">{errors.map((e, i) => <div key={`e${i}`} className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-xs text-destructive"><XCircle size={13} className="mt-0.5 shrink-0" /><span>{e}</span></div>)}{warnings.map((w, i) => <div key={`w${i}`} className="flex items-start gap-2 p-2 rounded-md bg-warning/10 text-xs text-warning dark:bg-warning/15"><AlertTriangle size={13} className="mt-0.5 shrink-0" /><span>{w}</span></div>)}</div>}
            </CardContent></Card>
            {summary && <Card><CardHeader><CardTitle className="text-sm">配置摘要</CardTitle></CardHeader><CardContent><dl className="space-y-2 text-xs">{S('服务端', summary.serverAddr, true)}{S('端口', summary.serverPort, true)}{S('认证方式', summary.authMethod)}{S('代理数量', summary.proxyCount)}</dl></CardContent></Card>}
          </aside>
        </div>
      </Tabs>
      {resetPending && <ConfirmOverlay title="重置为默认配置" description="将默认内容载入当前草稿。保存前不会写入磁盘。" confirmLabel="载入默认草稿" onCancel={()=>setResetPending(false)} onConfirm={()=>{setResetPending(false);void reset();}} />}
      {blocker.state==='blocked' && <ConfirmOverlay title="离开未保存的配置" description="当前修改尚未保存，离开后草稿将丢失。" confirmLabel="放弃草稿并离开" variant="destructive" onCancel={()=>blocker.reset()} onConfirm={()=>blocker.proceed()} />}
    </div>
  );
}
function S(l: string, v?: string | number | null, m = false) { return <div className="flex items-baseline justify-between gap-3"><dt className="text-muted-foreground">{l}</dt><dd className={`font-medium ${m ? 'font-mono tabular-nums' : ''}`}>{v ?? '—'}</dd></div>; }
function SpEditor({ configText, onChange }: { configText: string; onChange: (n: string) => void }) {
  const drafts = useMemo(() => { const { proxiesBody } = splitTomlAtProxies(configText); return parseProxies(proxiesBody); }, [configText]);
  return <div className="flex flex-col gap-3"><ProxyList proxies={drafts} onChange={(n) => onChange(rewriteProxies(configText, n))} /></div>;
}
