import { Link, useLocation } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar';
import { useConsole } from '../context/ConsoleContext';
import { NAV_GROUPS, findActiveNav } from '../lib/nav';
import { cn } from '../lib/utils';

export function AppSidebar() {
  const { pathname } = useLocation();
  const { navBadges } = useConsole();
  const activeTo = findActiveNav(pathname)?.item.to ?? null;

  function badgeFor(to: string): { count: number; className: string; title: string } | null {
    if (to === '/workspace' && navBadges.anomalies > 0) {
      return {
        count: navBadges.anomalies,
        className: 'bg-destructive/15 text-destructive font-semibold',
        title: `${navBadges.anomalies} 项待关注异常`,
      };
    }
    if (to === '/tests' && navBadges.activeJobs > 0) {
      return {
        count: navBadges.activeJobs,
        className: 'bg-primary/15 text-primary font-semibold',
        title: `${navBadges.activeJobs} 个测试批次运行中`,
      };
    }
    if (to === '/instances' && navBadges.errorInstances > 0) {
      return {
        count: navBadges.errorInstances,
        className: 'bg-destructive/15 text-destructive font-semibold',
        title: `${navBadges.errorInstances} 个实例异常`,
      };
    }
    if (to === '/nodes' && navBadges.offlineNodes > 0) {
      return {
        count: navBadges.offlineNodes,
        className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold',
        title: `${navBadges.offlineNodes} 个部署节点离线`,
      };
    }
    return null;
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="frpc 多实例管理">
              <Link to="/workspace" aria-label="返回工作台">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs">
                  <Boxes className="size-4" />
                </div>
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold tracking-tight">frpc 多实例管理</span>
                  <span className="truncate text-[11px] text-sidebar-foreground/60">
                    资源探测 · 域名选优 · 实例编排
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const badge = badgeFor(item.to);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={item.to === activeTo}
                        tooltip={item.label}
                        className="h-9"
                      >
                        <Link to={item.to}>
                          <item.icon className="size-4" />
                          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
                            <span>{item.label}</span>
                            {item.hint && (
                              <span className="truncate text-[11px] font-normal text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">
                                {item.hint}
                              </span>
                            )}
                          </span>
                        </Link>
                      </SidebarMenuButton>
                      {badge && (
                        <SidebarMenuBadge
                          title={badge.title}
                          className={cn('rounded-full px-1.5 text-[10px] tabular-nums', badge.className)}
                        >
                          {badge.count > 99 ? '99+' : badge.count}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
