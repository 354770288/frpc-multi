import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ClipboardList,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
  ChevronDown,
} from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useTheme, type Theme } from '../hooks/useTheme';
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

        <Button size="sm" onClick={() => navigate('/create')} className="hidden lg:inline-flex">
          <Plus size={14} />
          创建实例
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
              <div className="text-[11px] font-normal text-muted-foreground">系统与审计入口</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/audit')} className="text-xs">
              <ClipboardList size={13} />
              审计日志
            </DropdownMenuItem>
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
            <DropdownMenuItem onClick={() => navigate('/login')} className="text-xs">
              <LogOut size={13} />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
