import { Fragment } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Github,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useTheme, type Theme } from '../hooks/useTheme';
import { findActiveNav } from '../lib/nav';
import { CommandPalette } from './CommandPalette';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { SidebarTrigger } from './ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

type Crumb = { label: string; to?: string };

function buildBreadcrumbs(pathname: string): { groupLabel?: string; ancestors: Crumb[]; current: string } {
  const active = findActiveNav(pathname);
  const groupLabel = active?.groupLabel;

  if (pathname === '/instances/new') {
    return {
      groupLabel: '部署与运维',
      ancestors: [{ label: '实例', to: '/instances' }],
      current: '创建实例',
    };
  }
  const instConfigMatch = pathname.match(/^\/instances\/(\d+)\/([^/]+)\/config$/);
  if (instConfigMatch) {
    const [, nodeId, rawName] = instConfigMatch;
    const decoded = decodeURIComponent(rawName);
    return {
      groupLabel: '部署与运维',
      ancestors: [
        { label: '实例', to: '/instances' },
        { label: decoded, to: `/instances/${nodeId}/${rawName}` },
      ],
      current: '编辑配置',
    };
  }
  const instDetailMatch = pathname.match(/^\/instances\/(\d+)\/([^/]+)$/);
  if (instDetailMatch) {
    const [, , rawName] = instDetailMatch;
    return {
      groupLabel: '部署与运维',
      ancestors: [{ label: '实例', to: '/instances' }],
      current: decodeURIComponent(rawName) || '实例详情',
    };
  }
  if (pathname === '/tests/new') {
    return {
      groupLabel: '资源与测试',
      ancestors: [{ label: '测试任务', to: '/tests' }],
      current: '新建测试',
    };
  }
  if (pathname.startsWith('/tests/') && pathname !== '/tests/') {
    return {
      groupLabel: '资源与测试',
      ancestors: [{ label: '测试任务', to: '/tests' }],
      current: '批次详情',
    };
  }
  if (pathname === '/lb/settings') {
    return {
      groupLabel: '资源与测试',
      ancestors: [{ label: '域名选优', to: '/lb' }],
      current: '域名设置',
    };
  }

  return {
    groupLabel,
    ancestors: [],
    current: active?.item.label ?? (pathname.startsWith('/instances') ? '实例详情' : 'frpc 多实例管理'),
  };
}

export function SiteHeader() {
  const { auth, setCommandOpen } = useConsole();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { theme, resolved, setTheme } = useTheme();
  const { groupLabel, ancestors, current } = buildBreadcrumbs(pathname);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2.5 border-b bg-card/85 px-4 backdrop-blur-md sm:px-6">
        <SidebarTrigger />

        <Separator orientation="vertical" className="hidden h-4 sm:block" />

        <nav aria-label="面包屑导航" className="flex min-w-0 items-center gap-1.5 text-sm">
          {groupLabel && (
            <>
              <span className="hidden text-xs text-muted-foreground md:inline">{groupLabel}</span>
              <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 md:inline" />
            </>
          )}
          {ancestors.map((crumb) => (
            <Fragment key={`${crumb.to || ''}:${crumb.label}`}>
              {crumb.to ? (
                <Link
                  to={crumb.to}
                  className="hidden max-w-36 truncate text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="hidden text-xs text-muted-foreground sm:inline">{crumb.label}</span>
              )}
              <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:inline" />
            </Fragment>
          ))}
          <h1 className="min-w-0 truncate text-sm font-semibold text-foreground" aria-current="page">
            {current}
          </h1>
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCommandOpen(true)}
            aria-label="打开全局快捷搜索"
            className="h-8 gap-2 bg-muted/40 px-2.5 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground sm:w-52 sm:justify-between"
          >
            <span className="inline-flex items-center gap-1.5 truncate">
              <Search className="size-3.5 shrink-0" />
              <span className="hidden sm:inline">快速搜索或跳转…</span>
            </span>
            <kbd className="hidden rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
              ⌘K
            </kbd>
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="切换亮暗主题"
            title={resolved === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>

          <Button variant="ghost" size="icon-sm" asChild>
            <a
              href="https://github.com/354770288/frpc-multi"
              target="_blank"
              rel="noreferrer"
              aria-label="打开 GitHub 项目仓库"
            >
              <Github className="size-4" />
            </a>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2 pl-1">
                <span className="grid size-7 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {(auth.username || 'admin').slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden text-xs font-medium sm:inline">{auth.username || 'admin'}</span>
                <ChevronDown className="hidden size-3 sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              <DropdownMenuLabel className="text-xs">
                <div className="font-semibold">{auth.username || 'admin'}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/system?tab=security')} className="text-xs">
                <Settings className="size-3.5" />
                账号与安全
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                外观
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                <DropdownMenuRadioItem value="light" className="text-xs">
                  <Sun className="size-3.5" />
                  浅色
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark" className="text-xs">
                  <Moon className="size-3.5" />
                  深色
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system" className="text-xs">
                  <Monitor className="size-3.5" />
                  跟随系统
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/logout')} className="text-xs">
                <LogOut className="size-3.5" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <CommandPalette />
    </>
  );
}
