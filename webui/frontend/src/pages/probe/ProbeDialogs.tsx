import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { manualGeoLabels, readOnlyTagNames } from '../../lib/geoip';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { Overlay } from '../../components/Overlay';
import type { GroupColor, GroupInfo, LabelCount, ProbeServer, ProbeTestConfig } from '../../lib/types';
import { GeoInfo } from './GeoInfo';
import { COLOR_LABELS, GroupDotClass, groupVariant } from './ProbeTableShared';
import { canRemoveLegacyLabels, canSubmitServerBatch, legacyServerBatchPayload } from './serverBulkUi';
import type { useServerImport } from './useServerImport';

export type ServerImportTask = ReturnType<typeof useServerImport>;

export function ServerDialog({ server, groups, onClose, onSaved }: {
  server: ProbeServer | null;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ip, setIp] = useState(server?.ip ?? '');
  const [labels, setLabels] = useState(manualGeoLabels(server?.labels ?? [], server?.manualLabels).join(','));
  const [group, setGroup] = useState(server?.group ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!ip.trim()) { toast.error('请填写服务器地址'); return; }
    setSaving(true);
    try {
      const payload = {
        ip: ip.trim(),
        labels: labels.split(',').map((v) => v.trim()).filter(Boolean),
        group: group.trim(),
      };
      if (server) await probeApi.updateServer(server.id, payload);
      else await probeApi.createServer(payload);
      toast.success(server ? '服务器已更新' : '服务器已添加');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title={server ? '编辑服务器' : '添加服务器'} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">服务器地址（IP 或域名）</Label>
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4 或 frps.example.com" autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          {server?.geo && <GeoInfo geo={server.geo} detailed />}
          <Label className="text-xs">手动标签（可选，多个用逗号分隔）</Label>
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="CN2,家宽" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">业务分组（可选，可输入新分组）</Label>
          <Input
            value={group} onChange={(e) => setGroup(e.target.value)}
            placeholder="例如：生产入口、备用池" list="probe-group-options"
          />
          <datalist id="probe-group-options">
            {groups.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </Overlay>
  );
}

export function ServerImportStatus({ task }: { task: ServerImportTask }) {
  const { job } = task;
  if (!job) return null;
  const terminal = ['done', 'partial', 'failed'].includes(job.state);
  const percent = job.total ? Math.min(100, Math.round(job.processed / job.total * 100)) : (terminal ? 100 : 0);
  const stateLabel: Record<typeof job.state, string> = {
    queued: '排队中', running: '导入中', done: '已完成', partial: '部分完成', failed: '失败',
  };
  return (
    <Card className="mt-4 border-primary/30" aria-label="服务器导入任务">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-medium text-sm">服务器导入 · {stateLabel[job.state]}</div>
          <span className="text-xs text-muted-foreground">{job.processed}/{job.total} 条（{percent}%）</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => task.refreshJob()} disabled={task.submitting || task.retrying}>
              <RefreshCw size={13} />刷新状态
            </Button>
            {terminal && <Button size="sm" variant="ghost" onClick={task.clearJob} disabled={task.unresolvedRequest}>关闭</Button>}
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-label="导入进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>新增 {job.inserted}</span><span>跳过 {job.skipped}</span><span>失败 {job.failed}（可重试 {job.retryableFailed ?? 0}）</span>
          {job.error && <span className="text-destructive">{job.error}</span>}
          {task.error && <span role="alert" className="text-destructive">{task.error}</span>}
          {task.hasPendingSubmission && <span role="status" className="text-warning-foreground">有一项新导入等待确认，请先恢复待提交请求。</span>}
          {task.pendingRetry?.jobId === job.jobId && <span role="status">失败项重试等待确认；重试会复用原幂等键。</span>}
        </div>
        {terminal && !!job.failed && (
          <div className="mt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">失败明细（已载入 {task.failures.length} 条）</span>
              {Number(job.retryableFailed) > 0 && <Button size="sm" variant="outline" onClick={() => task.retryFailed()} disabled={task.retrying || task.hasPendingSubmission || (!!task.pendingRetry && task.pendingRetry.jobId !== job.jobId)}>
                {task.retrying ? '提交重试中…' : task.pendingRetry?.jobId === job.jobId ? '恢复失败项重试' : `重试失败项（${job.retryableFailed}）`}
              </Button>}
              {task.failureCursor !== null && <Button size="sm" variant="ghost" onClick={() => task.loadMoreFailures()} disabled={task.loadingFailures}>{task.loadingFailures ? '加载中…' : '加载更多'}</Button>}
              {task.failureLoadError && <><span role="alert" className="text-xs text-destructive">{task.failureLoadError}</span><Button size="sm" variant="outline" onClick={() => task.retryLoadFailures()} disabled={task.loadingFailures}>{task.loadingFailures ? '正在重试…' : '重试加载失败明细'}</Button></>}
            </div>
            <div className="max-h-52 overflow-auto rounded border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted"><tr><th className="p-2">行</th><th className="p-2">输入</th><th className="p-2">原因</th><th className="p-2">处理</th></tr></thead>
                <tbody>{task.failures.map((failure, index) => <tr key={`${failure.line}-${index}`} className="border-t"><td className="p-2 font-mono">{failure.line}</td><td className="max-w-64 truncate p-2 font-mono" title={failure.input}>{failure.input}</td><td className="p-2">{failure.error}</td><td className="p-2">{failure.retryable ? '可重试' : '永久失败'}</td></tr>)}</tbody>
              </table>
              {!task.failures.length && <div className="p-3 text-xs text-muted-foreground">{task.loadingFailures ? '正在加载失败明细…' : '暂无失败明细'}</div>}
              {task.failures.length > 0 && !(Number(job.retryableFailed) > 0) && <div className="border-t p-3 text-xs text-muted-foreground">这些失败项均不可重试。</div>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ImportDialog({ groups, onClose, onSubmitted, task }: {
  groups: string[];
  onClose: () => void;
  onSubmitted: () => void;
  task: ServerImportTask;
}) {
  const [text, setText] = useState(() => task.pendingRequest?.text ?? '');
  const [group, setGroup] = useState(() => task.pendingRequest?.group ?? '');
  const [sizeError, setSizeError] = useState('');

  const submit = async () => {
    if (!text.trim()) { toast.error('请粘贴要导入的内容'); return; }
    if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) {
      setSizeError('内容超过 16 MiB 上限，请拆分后导入');
      return;
    }
    setSizeError('');
    try {
      await task.submit(text, group);
      toast.success('导入任务已提交，可在任务进度中查看结果');
      onSubmitted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    }
  };

  return (
    <Overlay title="批量导入服务器" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">业务分组（可选）</Label>
          <Select value={group || '__ungrouped__'} onValueChange={(value) => setGroup(value === '__ungrouped__' ? '' : value)} disabled={task.hasPendingSubmission}>
            <SelectTrigger aria-label="导入业务分组"><SelectValue placeholder="选择业务分组" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__ungrouped__">不分组</SelectItem>
                {groups.length
                  ? groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)
                  : <span className="px-3 py-2 text-xs text-muted-foreground">可在业务分组管理中创建</span>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">导入内容</Label>
          <Textarea
            rows={10} value={text} onChange={(e) => setText(e.target.value)} readOnly={task.hasPendingSubmission}
            placeholder={'每行一台：IP 或「IP 标签」\n1.2.3.4\n5.6.7.8 备用入口\n\n也支持 JSON：[{"ip":"1.2.3.4","label":"A","group":"g"}]'}
            className="max-h-56 min-h-36 overflow-y-auto font-mono text-xs"
          />
          {sizeError && <p role="alert" className="text-xs text-destructive">{sizeError}</p>}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">已存在的 IP 自动跳过；JSON 行自带分组时以行内分组优先；支持最多 100,000 项、16 MiB。任务提交后可关闭弹窗，状态会在页面切换和刷新后恢复。</p>
        {task.hasPendingSubmission && <p className="text-xs text-muted-foreground">已恢复待确认的提交；原内容已锁定，重试会沿用原幂等键。</p>}
        {task.hasPendingRetry && <p className="text-xs text-destructive">有失败项重试请求等待确认，请先在任务卡恢复该请求。</p>}
        {task.error && <p role="alert" className="text-xs text-destructive">{task.error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={task.hasPendingSubmission ? () => task.retrySubmit().then(() => { toast.success('导入任务已提交'); onSubmitted(); }).catch(() => {}) : submit} disabled={task.submitting || task.isActive || task.hasPendingRetry}>{task.submitting ? '提交中…' : task.hasPendingSubmission ? '重试提交' : '导入'}</Button>
      </div>
    </Overlay>
  );
}

export function GroupDialog({ groups, groupCounts, onClose, onChanged }: {
  groups: GroupInfo[];
  groupCounts: Map<string, number>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const create = async () => {
    if (!name.trim()) { toast.error('请填写分组名'); return; }
    setBusy(true);
    try {
      await probeApi.createGroup(name.trim());
      setName('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      await probeApi.deleteGroup(target);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const startRename = (target: string) => {
    setRenaming(target);
    setRenameValue(target);
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const next = renameValue.trim();
    if (!next) { toast.error('新分组名不能为空'); return; }
    if (next === renaming) { setRenaming(null); return; }
    setBusy(true);
    try {
      await probeApi.renameGroup(renaming, next);
      toast.success(`分组已重命名：${renaming} → ${next}（服务器/发现记录/负载均衡绑定已同步）`);
      setRenaming(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  const setColor = async (groupName: string, color: GroupColor) => {
    setBusy(true);
    try {
      await probeApi.setGroupColor(groupName, color);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置颜色失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay title="分组管理" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label className="text-xs">新建业务分组</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：生产入口、备用池" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          </div>
          <Button onClick={create} disabled={busy || !name.trim()}><Plus size={13} />创建</Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">已有分组（含服务器正在使用的分组）· 点色点设置颜色</div>
          {groups.length ? (
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {groups.map(({ name: item, color }) => {
                const count = groupCounts.get(item) ?? 0;
                const isRenaming = renaming === item;
                const swatches: GroupColor[] = ['red', 'yellow', 'blue', 'green'];
                return (
                  <div key={item} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                    {isRenaming ? (
                      <>
                        <Input
                          className="h-7 min-w-0 flex-1 text-[12px]" value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void confirmRename(); if (e.key === 'Escape') setRenaming(null); }}
                          autoFocus aria-label={`重命名分组 ${item}`} />
                        <Button size="sm" onClick={confirmRename} disabled={busy || !renameValue.trim()}>确定</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
                      </>
                    ) : (
                      <>
                        <Badge variant={groupVariant(color)} dot className="max-w-36">{item}</Badge>
                        <div className="flex items-center gap-1" role="group" aria-label={`分组 ${item} 颜色`}>
                          <button type="button" onClick={() => void setColor(item, '')} disabled={busy}
                            className={cn('grid size-4 place-items-center rounded-full border border-border text-[9px] text-muted-foreground hover:border-foreground/40', color === '' && 'ring-2 ring-ring/50')}
                            title="无色" aria-label="无色">✕</button>
                          {swatches.map((swatch) => (
                            <button key={swatch} type="button" onClick={() => void setColor(item, swatch)} disabled={busy}
                              className={cn('size-4 rounded-full border border-black/10 dark:border-white/10', GroupDotClass(swatch), color === swatch && 'ring-2 ring-ring/50 ring-offset-1 ring-offset-card')}
                              title={COLOR_LABELS[swatch]} aria-label={`${COLOR_LABELS[swatch]}色`} />
                          ))}
                        </div>
                        <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                          {count > 0 ? `${count} 台` : <span title="按业务用途选择服务器加入分组；测试状态和域名成员分别维护">空分组</span>}
                        </span>
                        <Button size="icon-sm" variant="ghost" onClick={() => startRename(item)} disabled={busy}
                          aria-label={`重命名分组 ${item}`} title="重命名分组（服务器/发现记录/负载均衡绑定同步更新）">
                          <Pencil size={13} />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => void remove(item)} disabled={busy} aria-label={`删除分组 ${item}`} title="删除预创建记录（不影响已归入该分组的服务器）">
                          <Trash2 size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-input p-4 text-center text-xs text-muted-foreground">还没有分组</div>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">业务分组可选，按用途手动维护（如生产入口、备用池）；归属地与 ASN 由自动标签表示。颜色用于快速区分业务分组；重命名会同步更新服务器、发现结果与负载均衡绑定；删除只移除预创建记录。</p>
      </div>
    </Overlay>
  );
}

export function BatchEditDialog({
  kind, ids, count, groups, cloudLabels, applyDiscover, snapshotMode, onSubmitBulk, onClose, onSaved,
}: {
  kind: 'group' | 'label';
  ids: number[];
  count: number;
  groups: string[];
  cloudLabels: LabelCount[];
  applyDiscover?: boolean;
  snapshotMode?: boolean;
  onSubmitBulk?: (payload: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [group, setGroup] = useState('');
  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [removeLabels, setRemoveLabels] = useState<string[]>([]);
  const [attached, setAttached] = useState<LabelCount[]>([]);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [automaticNames, setAutomaticNames] = useState<Set<string>>(new Set());
  const [catalogReady, setCatalogReady] = useState(kind !== 'label');
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    if (kind !== 'label') return;
    let cancelled = false;
    Promise.all([probeApi.tags(), probeApi.tagCategories()]).then(([tags, categories]) => {
      if (!cancelled) { setAutomaticNames(readOnlyTagNames(tags.items, categories.items)); setCatalogReady(true); }
    }).catch((cause) => { if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : '标签目录读取失败'); });
    return () => { cancelled = true; };
  }, [kind]);
  const manualAttached = attached.filter(({ label }) => !automaticNames.has(label));
  const manualCloud = cloudLabels.filter(({ label }) => !automaticNames.has(label));

  const idsKey = ids.join(',');
  useEffect(() => {
    if (snapshotMode && kind === 'label') { setAttached([]); return; }
    if (kind !== 'label' || !idsKey) return;
    let cancelled = false;
    const idList = idsKey.split(',').map(Number).filter(Number.isFinite);
    const preview = applyDiscover ? probeApi.discoverLabelsPreview(idList) : probeApi.serversLabelsPreview(idList);
    preview.then((res) => { if (!cancelled) setAttached(res.labels); }).catch(() => { if (!cancelled) setAttached([]); });
    return () => { cancelled = true; };
  }, [kind, idsKey, applyDiscover, snapshotMode, cloudLabels]);

  const toggleAdd = (label: string) => {
    if (!catalogReady || automaticNames.has(label)) return;
    setAddLabels((current) => current.includes(label)
      ? current.filter((v) => v !== label)
      : [...current, label]);
    setRemoveLabels((current) => current.filter((v) => v !== label));
  };
  const toggleRemove = (label: string) => {
    if (!catalogReady || automaticNames.has(label)) return;
    setRemoveLabels((current) => current.includes(label)
      ? current.filter((v) => v !== label)
      : [...current, label]);
    setAddLabels((current) => current.filter((v) => v !== label));
  };
  const addCustom = () => {
    if (!catalogReady) return;
    const parts = custom.split(',').map((v) => v.trim()).filter((label) => !!label && !automaticNames.has(label));
    if (!parts.length) return;
    setAddLabels((current) => [...current, ...parts.filter((v) => !current.includes(v))]);
    setCustom('');
  };

  const submit = async () => {
    if (kind === 'label' && !catalogReady) return;
    if (!canSubmitServerBatch(ids.length, !!onSubmitBulk, !!applyDiscover)) return;
    if (kind === 'label' && !addLabels.length && (snapshotMode || !removeLabels.length)) {
      toast.error('请至少选择要添加或移除的标签');
      return;
    }
    setSaving(true);
    try {
      if (applyDiscover) {
        const result = await probeApi.discoverUpdateBatch(ids, {
          group: kind === 'group' ? group : undefined,
          addLabels: kind === 'label' ? addLabels : undefined,
          removeLabels: kind === 'label' ? removeLabels : undefined,
        });
        toast.success(`已更新 ${result.updated} 条`);
      } else {
        const changes = legacyServerBatchPayload(kind, group, addLabels, removeLabels, !!snapshotMode);
        const result = onSubmitBulk ? await onSubmitBulk(changes) : await probeApi.batchUpdateServers(ids, changes);
        if (kind === 'group') {
          toast.success(onSubmitBulk ? `业务分组更新任务已提交（${group || '不分组'}）` : `已更新 ${(result as { updated: number }).updated} 台（${group || '不分组'}）`);
        } else {
          toast.success(onSubmitBulk ? '批量标签更新任务已提交' : `已更新 ${(result as { updated: number }).updated} 台`);
        }
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const chipCls = (active: boolean, danger = false) => cn(
    'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
    active
      ? (danger ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground')
      : 'bg-muted text-muted-foreground hover:text-foreground',
  );

  return (
    <Overlay title={kind === 'group'
      ? `更改分组（${count} ${applyDiscover ? '条' : '台'}）`
      : `批量标签（${count} ${applyDiscover ? '条' : '台'}）`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {kind === 'group' ? (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">目标业务分组（可清空）</Label>
            <Select value={group || '__ungrouped__'} onValueChange={(value) => setGroup(value === '__ungrouped__' ? '' : value)}>
              <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="__ungrouped__">不分组</SelectItem>
                  {groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">自动归属地与 ASN 标签只读；此处仅维护手动标签。</p>
            {!catalogReady && !catalogError && <p role="status" className="text-xs text-muted-foreground">正在读取标签目录…</p>}
            {catalogError && <p role="alert" className="text-xs text-destructive">{catalogError}</p>}
            {canRemoveLegacyLabels(!!snapshotMode) && <div className="flex flex-col gap-1.5">
              <Label className="text-xs">已贴标签（点击 = 从所选行移除）</Label>
              {catalogReady && manualAttached.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {manualAttached.map(({ label, count: n }) => (
                    <button key={label} type="button" className={chipCls(removeLabels.includes(label), true)}
                      onClick={() => toggleRemove(label)}>
                      {label}<span className="ml-1 opacity-70">×{n}</span>
                    </button>
                  ))}
                </div>
              ) : <span className="text-[11px] text-muted-foreground">所选行还没有标签</span>}
            </div>}
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">标签云（点击 = 添加到所选行）</Label>
              {catalogReady && manualCloud.length ? (
                <div className="flex max-h-28 flex-wrap items-center gap-1.5 overflow-y-auto">
                  {manualCloud.map(({ label }) => (
                    <button key={label} type="button" className={chipCls(addLabels.includes(label))}
                      onClick={() => toggleAdd(label)}>{label}</button>
                  ))}
                </div>
              ) : <span className="text-[11px] text-muted-foreground">还没有任何标签</span>}
            </div>
            <div className="flex items-center gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)}
                placeholder="手动添加新标签" autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
              <Button variant="outline" size="sm" onClick={addCustom}><Plus size={13} />添加</Button>
            </div>
            {(addLabels.length > 0 || removeLabels.length > 0) && (
              <div className="text-[11px] text-muted-foreground">
                将添加：{addLabels.join('、') || '（无）'}；将移除：{removeLabels.join('、') || '（无）'}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving || (kind === 'label' && !catalogReady)}>{saving ? '更新中…' : '更新'}</Button>
      </div>
    </Overlay>
  );
}

const CONFIG_FIELDS: { key: keyof Omit<ProbeTestConfig, 'hasOverride' | 'running'>; label: string; hint: string; step?: string }[] = [
  { key: 'frpsPort', label: 'frps 服务端口', hint: '候选服务器上 frps 的监听端口' },
  { key: 'basePort', label: '测试端口组起始', hint: '连通性=x，下载=x+1，上传=x+2；frps 侧需放行这三个端口' },
  { key: 'tcpingTimeout', label: 'tcping 超时（秒）', hint: '单次探测超时', step: '0.5' },
  { key: 'tcpingRetries', label: 'tcping 重试次数', hint: '仅超时重试，连接被拒绝直接失败' },
  { key: 'tunnelWait', label: '等待隧道（秒）', hint: 'frpc 建立隧道的上限，日志确认后会提前返回' },
  { key: 'speedDuration', label: '测速时长（秒）', hint: '上下行各测一次的时限' },
  { key: 'connConcurrency', label: '连通性并行数', hint: '无带宽占用，可较高' },
  { key: 'speedConcurrency', label: '速率并行数', hint: '并发会分摊带宽，追求精确设 1' },
];

export function ConfigDialog({ config, onClose, onSaved }: {
  config: ProbeTestConfig | null;
  onClose: () => void;
  onSaved: (next: ProbeTestConfig) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (config) {
      for (const field of CONFIG_FIELDS) initial[field.key] = String(config[field.key]);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const field of CONFIG_FIELDS) {
        if (next[field.key] === undefined) next[field.key] = String(config[field.key]);
      }
      return next;
    });
  }, [config]);

  const submit = async () => {
    setSaving(true);
    try {
      const next = await probeApi.updateConfig(values);
      toast.success('测试配置已保存，下次测试生效');
      onSaved(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title="测试设置" onClose={onClose} wide>
      <div className="flex flex-col gap-3.5">
        {config?.hasOverride && (
          <div className="rounded-md bg-primary/10 px-3 py-2 text-[11px] text-foreground">
            当前部分配置为面板覆盖值（未改回默认时持续生效）。
          </div>
        )}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {CONFIG_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Input
                value={values[field.key] ?? ''}
                type={field.step ? 'number' : 'text'}
                inputMode="numeric"
                step={field.step}
                disabled={saving}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
              <span className="text-[10px] leading-4 text-muted-foreground">{field.hint}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          保存后持久化在 Console 数据库并立即对后续测试生效；容器部署时也无需改环境变量重启。
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving}>保存</Button>
      </div>
    </Overlay>
  );
}

export function ImportSelectedDialog({ ids, count, groups, defaultGroup, onClose, onDone }: {
  ids: number[];
  count: number;
  groups: string[];
  defaultGroup: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [group, setGroup] = useState(defaultGroup);
  const [importing, setImporting] = useState(false);

  const submit = async () => {
    if (!ids.length) return;
    setImporting(true);
    try {
      const result = await probeApi.discoverImport(ids, group);
      toast.success(`导入完成：新增 ${result.inserted} 台，跳过已在库 ${result.skipped} 台`, {
        duration: 6000,
        action: { label: '查看服务器库', onClick: () => navigate('/servers') },
      });
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Overlay title={`导入服务器库（${count} 条）`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">业务分组（可选）{defaultGroup ? '（默认取记录自身分组）' : ''}</Label>
          <Select value={group || '__ungrouped__'} onValueChange={(value) => setGroup(value === '__ungrouped__' ? '' : value)}>
            <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__ungrouped__">不分组</SelectItem>
                {groups.length
                  ? groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)
                  : <div className="px-3 py-2 text-xs text-muted-foreground">还没有分组，先到「分组管理」创建</div>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          只导入未入库的记录；记录上的标签会一并带入。导入后可在服务器库勾选目标并新建测试。
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={importing}>{importing ? '导入中…' : '导入'}</Button>
      </div>
    </Overlay>
  );
}
