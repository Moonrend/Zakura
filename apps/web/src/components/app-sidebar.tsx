"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  Brain,
  Cable,
  ChevronRight,
  CloudDownload,
  Globe,
  KeyRound,
  LogOut,
  Monitor,
  Network,
  Plug,
  Server,
  Settings2,
  Shield,
  Store,
  Star,
  Wrench,
  HardDrive,
  Building2,
  Users,
  ShieldCheck,
} from "lucide-react";
import { api, setSession } from "@/lib/api";
import { AGENT_SUBNAV } from "@/lib/agents";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type IconComp = React.ComponentType<{ className?: string }>;

type SubNavItem = {
  href: string;
  label: string;
  icon: IconComp;
  /** 自定义高亮；默认 pathname === href || startsWith(href/) */
  isActive?: (pathname: string) => boolean;
};

type NavEntry = {
  id: string;
  href: string;
  label: string;
  icon: IconComp;
  /** 父项高亮（含其子路由） */
  isActive?: (pathname: string) => boolean;
  /** 有子项时自动渲染展开按钮 */
  children?: SubNavItem[];
};

const AGENT_ICONS: Record<string, IconComp> = {
  general: Settings2,
  computer: Monitor,
  web: Globe,
  memory: Brain,
  mcp: Cable,
  connect: Plug,
  "tool-calls": Wrench,
};

const RESERVED_AGENT_SEGMENTS = new Set(["new"]);

function parseAgentId(pathname: string): string | null {
  const m = pathname.match(/^\/dashboard\/agents\/([^/]+)/);
  if (!m) return null;
  if (RESERVED_AGENT_SEGMENTS.has(m[1])) return null;
  return m[1];
}

function defaultActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function mcpServerActive(pathname: string) {
  if (pathname === "/dashboard/mcp") return true;
  if (!pathname.startsWith("/dashboard/mcp/")) return false;
  const seg = pathname.slice("/dashboard/mcp/".length).split("/")[0];
  return seg !== "store" && seg !== "import" && seg !== "official";
}

function NavFlyout({
  entry,
  pathname,
  parentActive,
}: {
  entry: NavEntry;
  pathname: string;
  parentActive: boolean;
}) {
  const Icon = entry.icon;
  const children = entry.children ?? [];

  return (
    <DropdownMenu modal={false}>
      <SidebarMenuButton
        isActive={parentActive}
        className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
        render={
          <DropdownMenuTrigger openOnHover delay={80} closeDelay={180} />
        }
      >
        <Icon />
        <span>{entry.label}</span>
      </SidebarMenuButton>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={10}
        className="min-w-44 w-auto"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{entry.label}</DropdownMenuLabel>
          <DropdownMenuItem render={<Link href={entry.href} />}>
            <Icon />
            <span>{entry.label === "Agents" ? "全部 Agents" : "概览"}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {children.length > 0 ? <DropdownMenuSeparator /> : null}
        {children.length > 0 ? (
          <DropdownMenuGroup>
            {children.map((child) => {
              const ChildIcon = child.icon;
              const active = child.isActive
                ? child.isActive(pathname)
                : defaultActive(pathname, child.href);
              return (
                <DropdownMenuItem
                  key={child.href}
                  render={<Link href={child.href} />}
                  className={cn(active && "bg-accent")}
                >
                  <ChildIcon />
                  <span>{child.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExpandableNavItem({
  entry,
  pathname,
  expanded,
  onToggle,
}: {
  entry: NavEntry;
  pathname: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const Icon = entry.icon;
  const children = entry.children ?? [];
  const hasChildren = children.length > 0;
  const parentActive = entry.isActive
    ? entry.isActive(pathname)
    : defaultActive(pathname, entry.href);

  if (collapsed && hasChildren) {
    return (
      <SidebarMenuItem>
        <NavFlyout entry={entry} pathname={pathname} parentActive={parentActive} />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={parentActive}
        tooltip={entry.label}
        render={<Link href={entry.href} />}
      >
        <Icon />
        <span>{entry.label}</span>
      </SidebarMenuButton>

      {hasChildren ? (
        <SidebarMenuAction
          showOnHover={false}
          aria-label={expanded ? `收起 ${entry.label}` : `展开 ${entry.label}`}
          aria-expanded={expanded}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight
            className={cn(
              "transition-transform duration-200 ease-out-soft",
              expanded && "rotate-90",
            )}
          />
        </SidebarMenuAction>
      ) : null}

      {hasChildren && expanded ? (
        <SidebarMenuSub>
          {children.map((child) => {
            const ChildIcon = child.icon;
            const active = child.isActive
              ? child.isActive(pathname)
              : defaultActive(pathname, child.href);
            return (
              <SidebarMenuSubItem key={child.href}>
                <SidebarMenuSubButton
                  isActive={active}
                  data-active={active || undefined}
                  render={<Link href={child.href} />}
                >
                  <ChildIcon />
                  <span>{child.label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

function useAutoExpand(keysInSection: string[]) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sectionKey = keysInSection.slice().sort().join("|");

  useEffect(() => {
    if (!sectionKey) return;
    const keys = sectionKey.split("|").filter(Boolean);
    setExpanded((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of keys) {
        if (!next[key]) {
          next[key] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sectionKey]);

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function isOpen(id: string) {
    return Boolean(expanded[id]);
  }

  return { isOpen, toggle };
}

export function AppSidebar({
  tenant,
  multiTenant = false,
  isPlatformAdmin = false,
}: {
  tenant: string;
  multiTenant?: boolean;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const agentId = parseAgentId(pathname);
  const [tenantList, setTenantList] = useState<
    Array<{ tenant: { id: string; name: string }; role: string }>
  >([]);
  const [currentTenantId, setCurrentTenantId] = useState("");

  useEffect(() => {
    if (!multiTenant) return;
    void (async () => {
      try {
        const res = await api<{
          currentTenantId: string;
          tenants: Array<{ tenant: { id: string; name: string }; role: string }>;
        }>("/api/tenants");
        setTenantList(res.tenants);
        setCurrentTenantId(res.currentTenantId);
      } catch {
        /* ignore */
      }
    })();
  }, [tenant, multiTenant]);

  async function switchTenant(tenantId: string) {
    if (tenantId === currentTenantId) return;
    try {
      const res = await api<{ session: string; tenant: { onboardingCompleted?: boolean } }>(
        "/api/auth/switch-tenant",
        { method: "POST", json: { tenantId } },
      );
      setSession(res.session);
      window.location.href =
        res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents";
    } catch (err) {
      console.error(err);
    }
  }

  const agentChildren = useMemo<SubNavItem[]>(() => {
    if (!agentId) return [];
    return AGENT_SUBNAV.map((item) => ({
      href: `/dashboard/agents/${agentId}/${item.href}`,
      label: item.label,
      icon: AGENT_ICONS[item.href] ?? Settings2,
      isActive: (path: string) =>
        path === `/dashboard/agents/${agentId}/${item.href}` ||
        path.endsWith(`/${item.href}`),
    }));
  }, [agentId]);

  const agentNav: NavEntry = {
    id: "agents",
    href: "/dashboard/agents",
    label: "Agents",
    icon: Bot,
    isActive: (path) =>
      path === "/dashboard/agents" || path.startsWith("/dashboard/agents/"),
    children: agentChildren,
  };

  const platformNav: NavEntry[] = [
    {
      id: "web",
      href: "/dashboard/web",
      label: "网页",
      icon: Globe,
      isActive: (path) =>
        path === "/dashboard/web" || path.startsWith("/dashboard/web/"),
    },
    {
      id: "memory",
      href: "/dashboard/memory",
      label: "记忆",
      icon: Brain,
    },
    {
      id: "runners",
      href: "/dashboard/runners",
      label: "Runners",
      icon: HardDrive,
      isActive: (path) =>
        path === "/dashboard/runners" || path.startsWith("/dashboard/runners/"),
    },
    {
      id: "network",
      href: "/dashboard/network",
      label: "网络",
      icon: Network,
      isActive: (path) =>
        path === "/dashboard/network" || path.startsWith("/dashboard/network/"),
      children: [
        {
          href: "/dashboard/network",
          label: "概览",
          icon: Network,
          isActive: (path) => path === "/dashboard/network",
        },
        {
          href: "/dashboard/network/mesh",
          label: "组网",
          icon: Cable,
        },
        {
          href: "/dashboard/network/exposure",
          label: "端口暴露",
          icon: Globe,
        },
        {
          href: "/dashboard/network/active",
          label: "活跃暴露",
          icon: Activity,
        },
        {
          href: "/dashboard/network/security",
          label: "安全策略",
          icon: Shield,
        },
      ],
    },
    {
      id: "mcp",
      href: "/dashboard/mcp",
      label: "MCP",
      icon: Cable,
      isActive: (path) =>
        path === "/dashboard/mcp" || path.startsWith("/dashboard/mcp/"),
      children: [
        {
          href: "/dashboard/mcp",
          label: "服务器",
          icon: Server,
          isActive: mcpServerActive,
        },
        {
          href: "/dashboard/mcp/official",
          label: "官方商店",
          icon: Star,
        },
        {
          href: "/dashboard/mcp/store",
          label: "社区商店",
          icon: Store,
        },
        {
          href: "/dashboard/mcp/import",
          label: "导入",
          icon: CloudDownload,
        },
      ],
    },    {
      id: "tool-calls",
      href: "/dashboard/tool-calls",
      label: "调用追踪",
      icon: Activity,
    },
    {
      id: "policies",
      href: "/dashboard/policies",
      label: "策略",
      icon: Shield,
    },
    {
      id: "keys",
      href: "/dashboard/keys",
      label: "Keys",
      icon: KeyRound,
    },
    {
      id: "settings-tenant",
      href: "/dashboard/settings/tenant",
      label: "租户",
      icon: Building2,
      children: [
        {
          href: "/dashboard/settings/tenant",
          label: "设置",
          icon: Settings2,
        },
        {
          href: "/dashboard/settings/oauth-apps",
          label: "OAuth 应用",
          icon: KeyRound,
        },
        // Members / multi-tenant switcher are SaaS-only
        ...(multiTenant
          ? [
              {
                href: "/dashboard/settings/members",
                label: "成员",
                icon: Users,
              } satisfies SubNavItem,
              {
                href: "/dashboard/settings/tenants",
                label: "切换 / 新建",
                icon: Building2,
              } satisfies SubNavItem,
            ]
          : []),
      ],
    },
  ];

  if (multiTenant && isPlatformAdmin) {
    platformNav.push({
      id: "admin",
      href: "/dashboard/admin",
      label: "超管",
      icon: ShieldCheck,
    });
  }

  const autoExpandKeys = useMemo(() => {
    const keys: string[] = [];
    if (agentId && agentNav.children?.length) keys.push(agentNav.id);
    for (const entry of platformNav) {
      if (!entry.children?.length) continue;
      const inSection = entry.isActive
        ? entry.isActive(pathname)
        : defaultActive(pathname, entry.href);
      if (inSection) keys.push(entry.id);
    }
    return keys;
  }, [pathname, agentId, agentNav.children?.length]);

  const { isOpen, toggle } = useAutoExpand(autoExpandKeys);

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-1 border-b border-sidebar-border px-3 py-3">
        <div className="min-w-0 px-1 group-data-[collapsible=icon]:px-0">
          <div className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:text-center">
            Zakura
          </div>
          {multiTenant ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="mt-0.5 flex w-full min-w-0 items-center gap-1 truncate text-left text-[11px] text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:hidden">
                <span className="truncate">{tenant || "—"}</span>
                <ChevronRight className="size-3 shrink-0 rotate-90 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>切换租户</DropdownMenuLabel>
                  {tenantList.map((item) => (
                    <DropdownMenuItem
                      key={item.tenant.id}
                      onClick={() => void switchTenant(item.tenant.id)}
                    >
                      <span className="truncate">{item.tenant.name}</span>
                      {item.tenant.id === currentTenantId ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">当前</span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/dashboard/settings/tenants")}>
                  管理租户…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="truncate text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
              {tenant || "—"}
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Agent</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <ExpandableNavItem
                entry={agentNav}
                pathname={pathname}
                expanded={isOpen(agentNav.id)}
                onToggle={() => toggle(agentNav.id)}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>平台</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {platformNav.map((entry) => (
                <ExpandableNavItem
                  key={entry.id}
                  entry={entry}
                  pathname={pathname}
                  expanded={isOpen(entry.id)}
                  onToggle={() => toggle(entry.id)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-start group-data-[collapsible=icon]:size-7 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:px-0"
            onClick={() => {
              setSession(null);
              router.replace("/login");
            }}
          >
            <LogOut />
            <span className="group-data-[collapsible=icon]:hidden">退出</span>
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
