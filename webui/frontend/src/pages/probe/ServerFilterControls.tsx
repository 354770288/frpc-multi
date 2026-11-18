import { useMemo } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import type { GroupInfo, ServerFacets, ServerQuery, ServerTagFacet } from '../../lib/types';
import { GroupDot } from './ProbeTableShared';

export function ServerAdvancedFilters({
  query, groups, facets, facetsCurrent, facetsLoading, facetsError,
  tagSearch, tagPage, tagPageSize, tagTotal, tagCandidatesCurrent,
  onTagSearch, onTagPage, open, onOpenChange, onGroupIds,
  onIncludeTagIds, onExcludeTagIds, onTagMode, onSingleGroup, onQuickTag, onRetryFacets,
}: {
  query: ServerQuery;
  groups: GroupInfo[];
  facets: ServerFacets;
  facetsCurrent: boolean;
  facetsLoading: boolean;
  facetsError: string | null;
  tagSearch: string;
  tagPage: number;
  tagPageSize: number;
  tagTotal: number | null;
  tagCandidatesCurrent: boolean;
  onTagSearch: (value: string) => void;
  onTagPage: (page: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGroupIds: (ids: string[]) => void;
  onIncludeTagIds: (ids: string[]) => void;
  onExcludeTagIds: (ids: string[]) => void;
  onTagMode: (mode: 'any' | 'all') => void;
  onSingleGroup: (group: string) => void;
  onQuickTag: (tagId: string | null) => void;
  onRetryFacets: () => void;
}) {
  const selectedGroups = query.groupIds ?? [];
  const includedTags = query.includeTagIds ?? [];
  const excludedTags = query.excludeTagIds ?? [];
  const candidateTags = tagCandidatesCurrent ? facets.tagItems : [];
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id;
  const tag = (id: string) => facets.tagItems.find((item) => item.tagId === id);
  const tagName = (id: string) => {
    const item = tag(id);
    return item ? `${item.category} / ${item.name}` : id;
  };
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  const countLabel = (count: number) => facetsCurrent ? `(${count})` : '(…)';
  const hasFilters = query.group !== undefined || selectedGroups.length > 0 || query.tagId !== undefined || includedTags.length > 0 || excludedTags.length > 0 || query.label !== undefined;

  return <div className="border-b px-4 py-2 text-xs">
    <details open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none font-medium">高级分组与标签筛选</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">分组（多选为并集）</legend>
          {groups.filter((group): group is GroupInfo & { id: string } => typeof group.id === 'string' && group.id.length > 0).map((group) => {
            const count = facets.groups.find((facet) => facet.group === group.name)?.count ?? 0;
            return <label key={group.id} className="flex items-center gap-2">
              <input aria-label={`选择分组 ${group.name}`} type="checkbox" checked={selectedGroups.includes(group.id!)} onChange={() => onGroupIds(toggle(selectedGroups, group.id!))} />
              <GroupDot color={group.color} />{group.name} {countLabel(count)}
            </label>;
          })}
          {!groups.some((group) => group.id) && <span className="text-muted-foreground">暂无可用的稳定分组 ID</span>}
          {query.group !== undefined && <span className="text-muted-foreground">单一分组筛选与多选互斥；选择多项会清除单一分组。</span>}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">包含标签</legend>
          <Input aria-label="搜索标签候选" className="h-8" value={tagSearch} onChange={(event) => onTagSearch(event.target.value)} placeholder="搜索标签名称" />
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{tagCandidatesCurrent && tagTotal !== null
              ? tagTotal === 0 ? '当前搜索没有标签候选（0）' : `显示 ${(tagPage - 1) * tagPageSize + 1}–${Math.min(tagPage * tagPageSize, tagTotal)} / ${tagTotal} 个标签`
              : tagCandidatesCurrent ? '标签总数暂不可用' : facetsError ? `标签候选读取失败：${facetsError}` : '正在加载标签候选…'}</span>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={!tagCandidatesCurrent || facetsLoading || tagPage <= 1} aria-label="上一页标签候选" onClick={() => onTagPage(tagPage - 1)}>上一页</Button>
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={!tagCandidatesCurrent || facetsLoading || tagTotal === null || tagPage * tagPageSize >= tagTotal} aria-label="下一页标签候选" onClick={() => onTagPage(tagPage + 1)}>下一页</Button>
            </div>
          </div>
          <label className="mb-1 flex items-center gap-2">匹配方式
            <select aria-label="包含标签匹配" className="rounded border bg-background px-2 py-1" value={query.tagMode ?? 'any'} onChange={(event) => onTagMode(event.target.value as 'any' | 'all')}>
              <option value="any">任意一个</option><option value="all">全部</option>
            </select>
          </label>
          {candidateTags.map((item) => <label key={item.tagId} className="flex items-center gap-2">
            <input aria-label={`包含标签 ${item.category} / ${item.name}`} type="checkbox" checked={includedTags.includes(item.tagId)} onChange={() => {
              const next = toggle(includedTags, item.tagId);
              onIncludeTagIds(next);
              if (next.includes(item.tagId)) onExcludeTagIds(excludedTags.filter((id) => id !== item.tagId));
            }} />
            {item.category} / {item.name} {countLabel(item.count)}
          </label>)}
          {!candidateTags.length && tagCandidatesCurrent && <span className="text-muted-foreground">当前页没有标签候选</span>}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">排除标签</legend>
          {candidateTags.map((item) => <label key={item.tagId} className="flex items-center gap-2">
            <input aria-label={`排除标签 ${item.category} / ${item.name}`} type="checkbox" checked={excludedTags.includes(item.tagId)} onChange={() => {
              const next = toggle(excludedTags, item.tagId);
              onExcludeTagIds(next);
              if (next.includes(item.tagId)) onIncludeTagIds(includedTags.filter((id) => id !== item.tagId));
            }} />
            {item.category} / {item.name} {countLabel(item.count)}
          </label>)}
          {!candidateTags.length && tagCandidatesCurrent && <span className="text-muted-foreground">当前页没有标签候选</span>}
        </fieldset>
      </div>
      {facetsLoading && <p role="status" className="mt-2 text-[11px] text-muted-foreground">{facetsCurrent ? '正在加载当前标签候选页…' : '正在更新当前筛选条件下的分组和标签计数…'}</p>}
      {facetsError && <div role="alert" className="mt-2 flex items-center gap-2 text-[11px] text-destructive"><span>筛选计数读取失败：{facetsError}</span><Button size="sm" variant="outline" onClick={onRetryFacets}>重试计数</Button></div>}
    </details>
    {hasFilters && <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="当前筛选">
      <span className="text-[11px] text-muted-foreground">当前筛选：</span>
      {query.group !== undefined && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onSingleGroup('all')} aria-label={`移除单一分组 ${query.group || '未分组'}`}>分组 {query.group || '未分组'} ×</Button>}
      {selectedGroups.map((id) => <Button key={id} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onGroupIds(selectedGroups.filter((value) => value !== id))} aria-label={`移除分组 ${groupName(id)}`}>分组 {groupName(id)} ×</Button>)}
      {query.tagId && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onQuickTag(null)} aria-label={`移除快捷标签 ${tagName(query.tagId)}`}>快捷标签 {tagName(query.tagId)} ×</Button>}
      {includedTags.map((id) => <Button key={`include-${id}`} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onIncludeTagIds(includedTags.filter((value) => value !== id))} aria-label={`移除包含标签 ${tagName(id)}`}>包含 {tagName(id)} ×</Button>)}
      {excludedTags.map((id) => <Button key={`exclude-${id}`} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onExcludeTagIds(excludedTags.filter((value) => value !== id))} aria-label={`移除排除标签 ${tagName(id)}`}>排除 {tagName(id)} ×</Button>)}
      {query.label !== undefined && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onQuickTag(null)} aria-label="移除旧标签筛选">旧标签 {query.label || '未标记'} ×</Button>}
    </div>}
  </div>;
}

export function ServerTagCloud({
  tags, active, candidatesCurrent, candidateLoading, candidateError,
  tagSearch, tagPage, tagPageSize, tagTotal, onToggle, onManage, onOpenAdvanced,
}: {
  tags: ServerTagFacet[];
  active: string | null;
  candidatesCurrent: boolean;
  candidateLoading: boolean;
  candidateError: string | null;
  tagSearch: string;
  tagPage: number;
  tagPageSize: number;
  tagTotal: number | null;
  onToggle: (tagId: string | null) => void;
  onManage: () => void;
  onOpenAdvanced: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ServerTagFacet[]>();
    if (candidatesCurrent) for (const tag of tags) map.set(tag.category, [...(map.get(tag.category) ?? []), tag]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
  }, [tags, candidatesCurrent]);
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
    {!candidatesCurrent && <span role={candidateError ? 'alert' : 'status'} className={cn('text-[11px]', candidateError ? 'text-destructive' : 'text-muted-foreground')}>
      {candidateError ? `标签候选读取失败：${candidateError}` : '正在加载标签候选…'}
    </span>}
    {candidatesCurrent && !groups.length && <span className="text-[11px] text-muted-foreground">当前标签搜索没有候选</span>}
    {groups.map(([category, items]) => <div key={category} className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{category}</span>
      {items.map((item) => <Button key={item.tagId} size="sm" variant={active === item.tagId ? 'default' : 'outline'} className="h-6 rounded-full px-2 text-[11px]" aria-label={`${category} ${item.name} ${candidatesCurrent ? item.count : '…'}`} aria-pressed={active === item.tagId} onClick={() => onToggle(active === item.tagId ? null : item.tagId)}>
        {item.name}<span className="ml-1 opacity-70">{candidatesCurrent ? item.count : '…'}</span>
      </Button>)}
    </div>)}
    {candidatesCurrent && <span className="text-[11px] text-muted-foreground">{tagTotal === null ? '候选总数暂不可用' : `${tagSearch ? `搜索“${tagSearch}” · ` : ''}第 ${tagPage} / ${Math.max(1, Math.ceil(tagTotal / tagPageSize))} 页 · ${tagTotal} 个候选`}</span>}
    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onOpenAdvanced}>搜索/翻页标签候选</Button>
    {active && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onToggle(null)}>清除标签筛选</Button>}
    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onManage}>管理分类标签</Button>
  </div>;
}
