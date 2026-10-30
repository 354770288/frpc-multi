import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { batchTagDialogTitle, canRemoveLegacyLabels } from './serverBulkUi';
import { editableTags, isReadOnlyTag } from '../../lib/geoip';
import type { ManagedTag, TagCategory } from '../../lib/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';

async function loadCatalog() {
  const [categoryResult, tagResult] = await Promise.all([probeApi.tagCategories(), probeApi.tags()]);
  return { categories: categoryResult.items, tags: tagResult.items };
}

export function TagManagementDialog({ open, onOpenChange, onChanged }: {
  open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => void;
}) {
  const [categories, setCategories] = useState<TagCategory[]>([]);
  const [tags, setTags] = useState<ManagedTag[]>([]);
  const [categoryName, setCategoryName] = useState('');
  const [tagName, setTagName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [renameCategories, setRenameCategories] = useState<Record<string, string>>({});
  const [renameTags, setRenameTags] = useState<Record<string, string>>({});
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const data = await loadCatalog();
    setCategories(data.categories); setTags(data.tags);
    const manual = data.categories.filter((item) => !isReadOnlyTag(item));
    setCategoryId((current) => manual.some((item) => item.id === current) ? current : manual[0]?.id ?? '');
  };
  useEffect(() => { if (open) void refresh().catch((error) => toast.error(error instanceof Error ? error.message : '标签加载失败')); }, [open]);
  const manualCategories = categories.filter((item) => !isReadOnlyTag(item));
  const manualTags = editableTags(tags, categories);
  const grouped = useMemo(() => categories.map((category) => ({ category, items: tags.filter((tag) => tag.categoryId === category.id) })), [categories, tags]);
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); await refresh(); onChanged(); toast.success(message); }
    catch (error) { toast.error(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const addCategory = () => { if (!categoryName.trim()) return; void run(() => probeApi.createTagCategory(categoryName.trim()), '分类已创建').then(() => setCategoryName('')); };
  const addTag = () => { if (!manualCategories.some((item) => item.id === categoryId) || !tagName.trim()) return; void run(() => probeApi.createTag(categoryId, tagName.trim()), '标签已创建').then(() => setTagName('')); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>分类标签管理</DialogTitle><DialogDescription>手动标签支持移动、合并和重命名；自动归属地与 ASN 标签由本地数据库维护，仅供查看和筛选。</DialogDescription></DialogHeader>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="flex flex-col gap-3">
          <Label>创建分类</Label>
          <div className="flex gap-2"><Input aria-label="新分类名称" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：线路" /><Button onClick={addCategory} disabled={busy || !categoryName.trim()}><FolderPlus />创建</Button></div>
          <Label className="mt-2">创建标签</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger aria-label="标签所属分类"><SelectValue placeholder="选择分类" /></SelectTrigger>
            <SelectContent><SelectGroup>{manualCategories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <div className="flex gap-2"><Input aria-label="新标签名称" value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="标签名称" onKeyDown={(event) => { if (event.key === 'Enter') addTag(); }} /><Button onClick={addTag} disabled={busy || !categoryId || !tagName.trim()}><Plus />添加</Button></div>
        </section>
        <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
          {grouped.map(({ category, items }) => <section key={category.id} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2"><Input disabled={isReadOnlyTag(category)} aria-label={`${category.name}分类名称`} value={renameCategories[category.id] ?? category.name} onChange={(event) => setRenameCategories((current) => ({ ...current, [category.id]: event.target.value }))} /><Button size="icon-sm" variant="outline" aria-label={`重命名分类 ${category.name}`} disabled={busy || isReadOnlyTag(category) || !(renameCategories[category.id] ?? category.name).trim() || (renameCategories[category.id] ?? category.name) === category.name} onClick={() => void run(() => probeApi.renameTagCategory(category.id, renameCategories[category.id].trim()), '分类已重命名')}><Pencil /></Button></div>
            {isReadOnlyTag(category) && <Badge tone="muted">自动 · 只读</Badge>}
            {items.map((tag) => isReadOnlyTag(tag, categories, tag.categoryId) ? <div key={tag.id} className="flex items-center gap-2"><Badge variant="outline">{tag.name}</Badge><span className="text-xs text-muted-foreground">自动 · 只读 · {tag.serverCount} 台</span></div> : <div key={tag.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.8fr)_auto_auto] items-center gap-1.5">
              <Input aria-label={`${tag.name}标签名称`} value={renameTags[tag.id] ?? tag.name} onChange={(event) => setRenameTags((current) => ({ ...current, [tag.id]: event.target.value }))} />
              <Select value={moveTargets[tag.id] ?? tag.categoryId} onValueChange={(value) => setMoveTargets((current) => ({ ...current, [tag.id]: value }))}>
                <SelectTrigger aria-label={`移动 ${tag.name} 到分类`}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{manualCategories.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
              <Button size="icon-sm" variant="outline" aria-label={`保存标签 ${tag.name}`} disabled={busy || ((renameTags[tag.id] ?? tag.name) === tag.name && (moveTargets[tag.id] ?? tag.categoryId) === tag.categoryId)} onClick={() => void run(() => probeApi.updateTag(tag.id, { name: (renameTags[tag.id] ?? tag.name).trim(), categoryId: moveTargets[tag.id] ?? tag.categoryId }), '标签已更新')}><Pencil /></Button>
              <Button size="icon-sm" variant="destructive" aria-label={`删除标签 ${tag.name}`} disabled={busy} onClick={() => void run(() => probeApi.deleteTag(tag.id), '标签已删除')}><Trash2 /></Button>
              <div className="col-span-4 flex items-center gap-2 pl-1"><Badge tone="muted">{tag.serverCount} 台</Badge><Select value={mergeTargets[tag.id] ?? ''} onValueChange={(value) => setMergeTargets((current) => ({ ...current, [tag.id]: value }))}><SelectTrigger size="sm" className="h-7 flex-1" aria-label={`合并 ${tag.name} 到`}><SelectValue placeholder="合并到…" /></SelectTrigger><SelectContent><SelectGroup>{manualTags.filter((item) => item.id !== tag.id).map((item) => <SelectItem key={item.id} value={item.id}>{item.category} / {item.name}</SelectItem>)}</SelectGroup></SelectContent></Select><Button size="sm" variant="outline" disabled={busy || !mergeTargets[tag.id]} onClick={() => void run(() => probeApi.mergeTag(tag.id, mergeTargets[tag.id]), '标签已合并')}><ArrowRightLeft />合并</Button></div>
            </div>)}
            {!items.length && <p className="text-xs text-muted-foreground">此分类还没有标签</p>}
          </section>)}
          {!categories.length && <p className="text-sm text-muted-foreground">先创建一个分类，再添加标签。</p>}
        </div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>完成</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function BatchTagDialog({ open, onOpenChange, ids, count, snapshotMode, onSubmitBulk, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; ids: number[]; count?: number; snapshotMode?: boolean; onSubmitBulk?: (payload: Record<string, unknown>) => Promise<unknown>; onSaved: () => void;
}) {
  const [categories, setCategories] = useState<TagCategory[]>([]);
  const [tags, setTags] = useState<ManagedTag[]>([]);
  const [addIds, setAddIds] = useState<string[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const targetCount = count ?? ids.length;
  useEffect(() => { if (open) void loadCatalog().then((data) => { setCategories(data.categories); setTags(data.tags); setAddIds([]); setRemoveIds([]); }).catch((error) => toast.error(error instanceof Error ? error.message : '标签加载失败')); }, [open]);
  const manualTags = editableTags(tags, categories);
  const editableIds = new Set(manualTags.map((tag) => tag.id));
  const manualCategories = categories.filter((category) => !isReadOnlyTag(category));
  const toggle = (id: string, intent: 'add' | 'remove') => {
    if (!editableIds.has(id)) return;
    const setter = intent === 'add' ? setAddIds : setRemoveIds;
    const other = intent === 'add' ? setRemoveIds : setAddIds;
    setter((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    other((current) => current.filter((value) => value !== id));
  };
  const save = async () => {
    const addTagIds = addIds.filter((id) => editableIds.has(id));
    const removeTagIds = removeIds.filter((id) => editableIds.has(id));
    if (!addTagIds.length && !removeTagIds.length) return;
    setBusy(true);
    try {
      const result = onSubmitBulk
        ? await onSubmitBulk({ addTagIds, removeTagIds: snapshotMode ? [] : removeTagIds })
        : await probeApi.batchUpdateServers(ids, { addTagIds, removeTagIds });
      toast.success(onSubmitBulk ? `分类标签任务已提交（${snapshotMode ? `冻结快照 ${targetCount} 台` : `${targetCount} 台`}）` : `已更新 ${(result as { updated: number }).updated} 台`);
      onSaved();
    }
    catch (error) { toast.error(error instanceof Error ? error.message : '更新失败'); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{batchTagDialogTitle(targetCount)}</DialogTitle><DialogDescription>{snapshotMode ? '选择要添加的标签，操作按标签 ID 应用。' : '选择要添加或移除的标签，操作按标签 ID 应用。'}</DialogDescription></DialogHeader>
    <p className="text-xs text-muted-foreground">自动归属地与 ASN 标签只读，由本地数据库维护。</p>
    <div className="flex flex-col gap-4">{manualCategories.map((category) => <section key={category.id} className="flex flex-col gap-2"><Label>{category.name}</Label><div className="flex flex-wrap gap-2">{manualTags.filter((tag) => tag.categoryId === category.id).map((tag) => <div key={tag.id} className="flex items-center gap-1 rounded-md border px-2 py-1"><span className="text-xs">{tag.name}</span><Button size="sm" variant={addIds.includes(tag.id) ? 'default' : 'outline'} onClick={() => toggle(tag.id, 'add')}>添加</Button>{canRemoveLegacyLabels(!!snapshotMode) && <Button size="sm" variant={removeIds.includes(tag.id) ? 'destructive' : 'outline'} onClick={() => toggle(tag.id, 'remove')}>移除</Button>}</div>)}</div></section>)}{!manualTags.length && <p className="text-sm text-muted-foreground">暂无标签，请先在分类标签管理中创建。</p>}</div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy || (!addIds.length && !removeIds.length)} onClick={save}>保存</Button></DialogFooter>
  </DialogContent></Dialog>;
}
