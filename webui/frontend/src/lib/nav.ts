import { Globe, LayoutDashboard, Monitor, Radar, ScrollText, ShieldCheck, Server, FlaskConical, ListChecks, History, type LucideIcon } from 'lucide-react';

export type NavItem = {
  to: string;
  label: string;
  /** 该入口在使用链中的角色，侧边栏展开时以弱化小字展示 */
  hint?: string;
  icon: LucideIcon;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '总览',
    items: [{ to: '/workspace', label: '工作台', icon: LayoutDashboard }],
  },
  {
    label: '资源与测试',
    items: [
      { to: '/discovery', label: '网段发现', icon: Radar },
      { to: '/servers', label: '服务器库', icon: Server },
      { to: '/tests', label: '测试任务', icon: ListChecks },
      { to: '/results', label: '测试结果', icon: History },
      { to: '/lb', label: '域名选优', icon: Globe },
      { to: '/test-nodes', label: '测试节点', icon: FlaskConical },
    ],
  },
  {
    label: '部署与运维',
    items: [
      { to: '/instances', label: '实例', icon: Monitor },
      { to: '/nodes', label: '部署节点', icon: Server },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/audit', label: '操作记录', icon: ScrollText },
      { to: '/system', label: '系统设置', icon: ShieldCheck },
    ],
  },
];

/** 命中当前路由的导航项（含分组名），供侧边栏激活态与顶栏页标题共用。 */
export function findActiveNav(pathname: string): { item: NavItem; groupLabel: string } | null {
  if (pathname === '/instances/new') return { item: NAV_GROUPS[2].items[0], groupLabel: NAV_GROUPS[2].label };
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return { item, groupLabel: group.label };
      }
    }
  }
  return null;
}
