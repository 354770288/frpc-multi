import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, Save, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, nodesApi } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { ProxyList } from '../components/ProxyList';
import { parseProxies, rewriteProxies, splitTomlAtProxies, type ProxyDraft } from '../lib/proxyToml';
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
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartAfterSave, setRestartAfterSave] = useState(true);
  const [mode, setMode] = useState<'structured' | 'raw'>('structured');
  const name = instance.name;
  const ik = `${instance.nodeId}:${instance.name}`;

  useEffect(() => {
    const req = instance.nodeId > 0
      ? nodesApi.instances.getConfig(instance.nodeId, instance.name)
      : api<{ configText: string; validation: ValidationData }>(`/api/instances/${instance.name}/config`);
    req.then((d) => { setConfigText(d.configText); setOriginalText(d.configText); setValidation(d.validation); })
      .catch((err) => { setConfigText(''); setOriginalText(''); setValidation(null); toast.error(err instanceof Error ? err.message : '配置加载失败'); });
  }, [ik]);

  useEffect(() => {
    if (configText === originalText) return;
    const h = window.setTimeout(async () => {
      setValidating(true);
      try {
        const r = instance.nodeId > 0
          ? await nodesApi.instances.validateConfig(instance.nodeId, instance.name, configText)
          : await api<ValidationData>(`/api/instances/${instance.name}/config/validate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: configText });
        setValidation(r);
      } catch {} finally { setValidating(false); }
    }, 500);
    return () => window.clearTimeout(h);
  }, [ik, configText, originalText]);

  const dirty = configText !== originalText;
  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = validation?.summary;
  let sb: { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string };
  if (validating) sb = { tone: 'muted', label: '校验中…' };
  else if (errors.length) sb = { tone: 'danger', label: `${errors.length} 个错误` };
  else if (dirty) sb = { tone: 'warning', label: '未保存' };
  else sb = { tone: 'success', label: '已同步' };

  async function save() {
    setSaving(true);
    try {
      if (instance.nodeId > 0) await nodesApi.instances.updateConfig(instance.nodeId, instance.name, { configText, restartAfterSave });
      else await api(`/api/instances/${instance.name}/config`, { method: 'PUT', body: JSON.stringify({ configText, restartAfterSave }) });
      setOriginalText(configText);
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
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
        <Switch checked={restartAfterSave} onCheckedChange={setRestartAfterSave} size="sm" />
        保存后重启容器
      </label>
      <Button size="sm" onClick={reset} disabled={saving}><RotateCcw size={13} />重置为默认</Button>
      <Button size="sm" onClick={save} disabled={!dirty || saving || !!errors.length}><Save size={13} />{saving ? '保存中…' : '保存'}</Button>
    </div>
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold">编辑配置</h2>
        <span className="text-xs text-muted-foreground font-mono">{name} / frpc.toml</span>
        <Badge tone={sb.tone}>{sb.label}</Badge>
      </div>
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'structured' | 'raw')}>
        <div className="flex items-center gap-1 border-b mb-4">
          <TabsList className="border-0 bg-transparent p-0">
            <TabsTrigger value="structured" className="data-[state=active]:bg-transparent text-xs">代理（结构化）</TabsTrigger>
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
                : <div className="space-y-2">{errors.map((e, i) => <div key={`e${i}`} className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-xs text-destructive"><XCircle size={13} className="mt-0.5 shrink-0" /><span>{e}</span></div>)}{warnings.map((w, i) => <div key={`w${i}`} className="flex items-start gap-2 p-2 rounded-md bg-secondary text-xs text-secondary-foreground"><AlertTriangle size={13} className="mt-0.5 shrink-0" /><span>{w}</span></div>)}</div>}
            </CardContent></Card>
            {summary && <Card><CardHeader><CardTitle className="text-sm">配置摘要</CardTitle></CardHeader><CardContent><dl className="space-y-2 text-xs">{S('服务端', summary.serverAddr, true)}{S('端口', summary.serverPort, true)}{S('认证方式', summary.authMethod)}{S('代理数量', summary.proxyCount)}</dl></CardContent></Card>}
          </aside>
        </div>
      </Tabs>
    </div>
  );
}
function S(l: string, v?: string | number | null, m = false) { return <div className="flex items-baseline justify-between gap-3"><dt className="text-muted-foreground">{l}</dt><dd className={`font-medium ${m ? 'font-mono tabular-nums' : ''}`}>{v ?? '—'}</dd></div>; }
function SpEditor({ configText, onChange }: { configText: string; onChange: (n: string) => void }) {
  const drafts = useMemo(() => { const { proxiesBody } = splitTomlAtProxies(configText); return parseProxies(proxiesBody); }, [configText]);
  return <div className="flex flex-col gap-3"><ProxyList proxies={drafts} onChange={(n) => onChange(rewriteProxies(configText, n))} /></div>;
}
