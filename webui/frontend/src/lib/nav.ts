import {
  CirclePlus,
  Globe,
  LayoutDashboard,
  Monitor,
  Radar,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

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

/**
 * 主导航的唯一来源：分组顺序即使用链方向——
 * frps 资源（服务器库→负载均衡）是供给侧，部署接入（节点→创建实例）是消费侧。
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: '总览',
    items: [{ to: '/workspace', label: '工作台', icon: LayoutDashboard }],
  },
  {
    label: 'frps 资源',
    items: [
      { to: '/probe', label: '服务器库', hint: '穿透测试 → 入池', icon: Radar },
      { to: '/lb', label: '负载均衡', hint: '候选域名', icon: Globe },
    ],
  },
  {
    label: '部署接入',
    items: [
      { to: '/nodes', label: '节点', hint: 'Agent 管理', icon: Monitor },
      { to: '/create', label: '创建实例', icon: CirclePlus },
    ],
  },
  {
    label: '管理',
    items: [
      { to: '/audit', label: '审计日志', icon: ScrollText },
      { to: '/system', label: '账号与安全', icon: ShieldCheck },
    ],
  },
];

/** 命中当前路由的导航项（含分组名），供侧边栏激活态与顶栏页标题共用。 */
export function findActiveNav(pathname: string): { item: NavItem; groupLabel: string } | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return { item, groupLabel: group.label };
      }
    }
  }
  return null;
}
