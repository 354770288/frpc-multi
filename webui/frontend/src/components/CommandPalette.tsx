import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CornerDownLeft,
  FlaskConical,
  Globe,
  Monitor,
  Moon,
  Plus,
  Search,
  Server,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useConsole, instanceKey } from '../context/ConsoleContext';
import { useTheme } from '../hooks/useTheme';
import { NAV_GROUPS } from '../lib/nav';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

type CommandEntry = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  badge?: { text: string; tone: 'success' | 'warning' | 'danger' | 'muted' };
  icon: LucideIcon;
  keywords: string;
  onSelect: () => void;
};

export function CommandPalette() {
  const {
    commandOpen,
    setCommandOpen,
    nodes,
    instances,
    instanceSummaries,
    overviewDomains,
  } = useConsole();
  const navigate = useNavigate();
  const { resolved, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setCommandOpen]);

  useEffect(() => {
    if (commandOpen) {
      setQuery('');
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [commandOpen]);

  const trimmed = query.trim().toLowerCase();

  const entries = useMemo<CommandEntry[]>(() => {
    const items: CommandEntry[] = [];
    const go = (to: string) => {
      setCommandOpen(false);
      navigate(to);
    };

    if (query.trim()) {
      const raw = query.trim();
      items.push({
        id: `search-server:${raw}`,
        group: '快捷检索',
        title: `在服务器库搜索 "${raw}"`,
        subtitle: '按 IP、分组或标签过滤服务器资产',
        icon: Search,
        keywords: raw.toLowerCase(),
        onSelect: () => go(`/servers?q=${encodeURIComponent(raw)}`),
      });
    }

    items.push(
      {
        id: 'action:new-test',
        group: '快捷动作',
        title: '新建测试批次',
        subtitle: '发起连通性 / 速率 / 路由探测任务',
        icon: FlaskConical,
        keywords: '新建测试 测速 连通 路由 new test probe',
        onSelect: () => go('/tests/new'),
      },
      {
        id: 'action:new-instance',
        group: '快捷动作',
        title: '创建 frpc 实例',
        subtitle: '配置远端穿透连接并部署到在线节点',
        icon: Plus,
        keywords: '新建实例 创建实例 frpc create instance',
        onSelect: () => go('/instances/new'),
      },
      {
        id: 'action:toggle-theme',
        group: '快捷动作',
        title: resolved === 'dark' ? '切换为浅色主题' : '切换为深色主题',
        subtitle: '立即切换控制台界面配色',
        icon: resolved === 'dark' ? Sun : Moon,
        keywords: '主题 深色 浅色 暗黑 外观 theme dark light',
        onSelect: () => {
          setTheme(resolved === 'dark' ? 'light' : 'dark');
          setCommandOpen(false);
        },
      },
    );

    for (const group of NAV_GROUPS) {
      for (const nav of group.items) {
        items.push({
          id: `nav:${nav.to}`,
          group: '页面导航',
          title: nav.label,
          subtitle: group.label,
          icon: nav.icon,
          keywords: `${nav.label} ${group.label} ${nav.to}`.toLowerCase(),
          onSelect: () => go(nav.to),
        });
      }
    }

    for (const domain of overviewDomains) {
      items.push({
        id: `domain:${domain.id}`,
        group: '优选域名',
        title: domain.name,
        subtitle: domain.currentIp ? `当前指向 ${domain.currentIp}` : '尚未分配解析 IP',
        badge: domain.enabled
          ? { text: '已启用', tone: 'success' }
          : { text: '已停用', tone: 'muted' },
        icon: Globe,
        keywords: `${domain.name} ${domain.currentIp || ''} ${domain.syncGroup || ''} lb domain`.toLowerCase(),
        onSelect: () => go(`/lb/${domain.id}`),
      });
    }

    for (const inst of instances) {
      const sum = instanceSummaries[instanceKey(inst.nodeId, inst.name)] || inst.summary;
      const ports = sum?.remotePorts?.length ? `:${sum.remotePorts.slice(0, 3).join(', :')}` : '';
      const target = sum?.serverAddr ? `${sum.serverAddr}${ports}` : '';
      items.push({
        id: `instance:${inst.nodeId}:${inst.name}`,
        group: 'frpc 实例',
        title: inst.displayName || inst.name,
        subtitle: [inst.nodeName, inst.displayName && inst.displayName !== inst.name ? inst.name : '', target].filter(Boolean).join(' · '),
        badge: inst.enabled
          ? { text: '已启用', tone: 'success' }
          : { text: '已停用', tone: 'muted' },
        icon: Monitor,
        keywords: `${inst.name} ${inst.displayName || ''} ${inst.nodeName} ${sum?.serverAddr || ''} ${(sum?.remotePorts || []).join(' ')}`.toLowerCase(),
        onSelect: () => go(`/instances/${inst.nodeId}/${encodeURIComponent(inst.name)}`),
      });
    }

    for (const node of nodes) {
      const online = node.online || node.status === 'online';
      items.push({
        id: `node:${node.id}`,
        group: '部署节点',
        title: node.name,
        subtitle: `节点 ID #${node.id}`,
        badge: online ? { text: '在线', tone: 'success' } : { text: '离线', tone: 'warning' },
        icon: Server,
        keywords: `${node.name} node 节点 ${online ? '在线 online' : '离线 offline'}`.toLowerCase(),
        onSelect: () => go('/nodes'),
      });
    }

    if (!trimmed) {
      // 未输入时优先展示页面导航 + 快捷动作 + 前几个域名/实例
      return items.slice(0, 24);
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return items
      .filter((entry) => {
        if (entry.id.startsWith('search-server:')) return true;
        return tokens.every(
          (tok) =>
            entry.title.toLowerCase().includes(tok) ||
            (entry.subtitle?.toLowerCase().includes(tok) ?? false) ||
            entry.keywords.includes(tok),
        );
      })
      .slice(0, 30);
  }, [instances, instanceSummaries, navigate, nodes, overviewDomains, query, resolved, setCommandOpen, setTheme, trimmed]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!entries.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % entries.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + entries.length) % entries.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = entries[activeIndex] ?? entries[0];
      target?.onSelect();
    }
  }

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const grouped = useMemo(() => {
    const groups: { name: string; items: { entry: CommandEntry; flatIndex: number }[] }[] = [];
    const byName = new Map<string, { entry: CommandEntry; flatIndex: number }[]>();
    entries.forEach((entry, idx) => {
      let bucket = byName.get(entry.group);
      if (!bucket) {
        bucket = [];
        byName.set(entry.group, bucket);
        groups.push({ name: entry.group, items: bucket });
      }
      bucket.push({ entry, flatIndex: idx });
    });
    return groups;
  }, [entries]);

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">全局快捷搜索与跳转</DialogTitle>
        <DialogDescription className="sr-only">
          输入关键词检索控制台页面、优选域名、frpc 实例、部署节点或服务器 IP
        </DialogDescription>
        <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="全局快捷搜索输入"
            placeholder="搜索页面、优选域名、实例、端口或输入服务器 IP…"
            className="h-7 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
            ESC
          </kbd>
        </div>

        <div ref={listRef} role="listbox" aria-label="快捷跳转建议" className="max-h-[360px] overflow-y-auto p-1.5">
          {grouped.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              未找到匹配结果
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.name} className="mb-1.5 last:mb-0">
                <div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {group.name}
                </div>
                {group.items.map(({ entry, flatIndex }) => {
                  const Icon = entry.icon;
                  const active = flatIndex === activeIndex;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-cmd-index={flatIndex}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => entry.onSelect()}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                        active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted/60',
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{entry.title}</span>
                          {entry.badge && (
                            <Badge tone={entry.badge.tone} className="h-4 px-1.5 text-[10px]">
                              {entry.badge.text}
                            </Badge>
                          )}
                        </div>
                        {entry.subtitle && (
                          <div className="truncate text-xs text-muted-foreground">{entry.subtitle}</div>
                        )}
                      </div>
                      <ArrowRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t bg-muted/30 px-3.5 py-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>↑↓ 选择</span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeft className="size-3" /> 打开
            </span>
          </div>
          <span>快捷键 ⌘K / Ctrl+K</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
