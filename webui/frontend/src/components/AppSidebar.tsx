import { Link, useLocation } from 'react-router-dom';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar';
import { NAV_GROUPS, findActiveNav } from '../lib/nav';

export function AppSidebar() {
  const { pathname } = useLocation();
  const activeTo = findActiveNav(pathname)?.item.to ?? null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="frpc 多实例管理">
              <Link to="/workspace" aria-label="返回工作台">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-primary text-sm font-black text-sidebar-primary-foreground">
                  F
                </div>
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">frpc 多实例管理</span>
                  <span className="truncate text-[11px] text-sidebar-foreground/60">
                    frps 资源 · 部署接入
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
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={item.to === activeTo}
                      tooltip={item.label}
                      className="h-auto min-h-9 py-1.5"
                    >
                      <Link to={item.to}>
                        <item.icon />
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
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
