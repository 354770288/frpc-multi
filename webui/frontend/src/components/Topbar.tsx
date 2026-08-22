import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  Github,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  X,
  ChevronDown,
} from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useTheme, type Theme } from '../hooks/useTheme';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './ui/input-group';
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

const NAV_ITEMS = [
  { to: '/workspace', label: '工作台' },
  { to: '/nodes', label: '节点' },
  { to: '/probe', label: '服务器库' },
  { to: '/lb', label: '负载均衡' },
  { to: '/audit', label: '审计' },
] as const;

export function Topbar() {
  const {
    auth,
    workspaceSearch,
    setWorkspaceSearch,
    setWorkspaceNodeId,
  } = useConsole();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [searchValue, setSearchValue] = useState(workspaceSearch);

  useEffect(() => {
    setSearchValue(workspaceSearch);
  }, [workspaceSearch]);

  function applySearch(value: string) {
    setSearchValue(value);
    setWorkspaceSearch(value);
    if (value.trim()) setWorkspaceNodeId('all');
    navigate('/workspace');
  }

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b bg-card/90 px-4 backdrop-blur sm:px-6">
      <Link
        to="/workspace"
        className="flex min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-[236px]"
        aria-label="返回节点工作台"
      >
        <div className="grid h-[34px] w-[34px] place-items-center rounded-lg bg-primary text-[14px] font-black text-primary-foreground">
          F
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">frpc 多实例管理</div>
          <div className="hidden text-[11px] text-muted-foreground sm:block">
            节点工作台
          </div>
        </div>
      </Link>

      <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'rounded-md px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <InputGroup className="hidden w-[clamp(220px,30vw,420px)] md:flex">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={searchValue}
            onFocus={() => navigate('/workspace')}
            onChange={(event) => applySearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchValue) applySearch('');
            }}
            aria-label="搜索节点工作台实例"
            placeholder="搜索工作台实例、节点、配置路径"
          />
          {searchValue && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => applySearch('')} aria-label="清除工作台搜索">
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href="https://github.com/354770288/frpc-multi"
            target="_blank"
            rel="noreferrer"
            aria-label="打开 GitHub 项目仓库"
          >
            <Github size={16} />
          </a>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 pl-1">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                {(auth.username || 'admin').slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden text-[12px] sm:inline">{auth.username || 'admin'}</span>
              <ChevronDown size={12} className="hidden sm:block" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            <DropdownMenuLabel className="text-xs">
              <div className="font-semibold">{auth.username || 'admin'}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/system')} className="text-xs">
              <Settings size={13} />
              账号与安全
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              外观
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              <DropdownMenuRadioItem value="light" className="text-xs">
                <Sun size={13} />
                浅色
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" className="text-xs">
                <Moon size={13} />
                深色
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" className="text-xs">
                <Monitor size={13} />
                跟随系统
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/logout')} className="text-xs">
              <LogOut size={13} />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
