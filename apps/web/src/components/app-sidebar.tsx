"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  Brain,
  Cable,
  ChevronRight,
  CloudDownload,
  Cpu,
  Globe,
  KeyRound,
  LogOut,
  MessageSquare,
  Monitor,
  Network,
  Plug,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Store,
  Wrench,
  HardDrive,
  Building2,
  ShieldCheck,
  Route,
  Container,
  Sparkles,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { BrandMark } from "@/components/brand-mark";

type IconComp = React.ComponentType<{ className?: string }>;

type SubNavItem = {
  href: string;
  label: string;
  icon: IconComp;
  isActive?: (pathname: string) => boolean;
};

type NavEntry = {
  id: string;
  href: string;
  label: string;
  icon: IconComp;
  isActive?: (pathname: string) => boolean;
  children?: SubNavItem[];
};

const AGENT_ICONS: Record<string, IconComp> = {
  general: Settings2,
  computer: Monitor,
  web: Globe,
  memory: Brain,
  skills: Sparkles,
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

function mcpStoreActive(pathname: string) {
  return (
    pathname === "/dashboard/mcp/store" ||
    pathname.startsWith("/dashboard/mcp/store/") ||
    pathname === "/dashboard/mcp/official" ||
    pathname.startsWith("/dashboard/mcp/official/")
  );
}

function serverSectionActive(pathname: string) {
  return (
    pathname.startsWith("/dashboard/runners") ||
    pathname.startsWith("/dashboard/network") ||
    pathname.startsWith("/dashboard/platform-services")
  );
}

function advancedSectionActive(pathname: string) {
  return (
    pathname.startsWith("/dashboard/policies") ||
    pathname.startsWith("/dashboard/keys")
  );
}

function buildServerChildren(showPlatformServices: boolean): SubNavItem[] {
  const children: SubNavItem[] = [
    {
      href: "/dashboard/runners",
      label: "Runners",
      icon: HardDrive,
    },
    {
      href: "/dashboard/network",
      label: "网络概览",
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
      label: "网络安全",
      icon: Shield,
    },
  ];
  if (showPlatformServices) {
    children.push({
      href: "/dashboard/platform-services",
      label: "自托管服务",
      icon: Container,
    });
  }
  return children;
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

const ExpandableNavItem = memo(function ExpandableNavItem({
  entry,
  pathname,
}: {
  entry: NavEntry;
  pathname: string;
}) {
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const Icon = entry.icon;
  const children = entry.children ?? [];
  const hasChildren = children.length > 0;
  const parentActive = entry.isActive
    ? entry.isActive(pathname)
    : defaultActive(pathname, entry.href);

  const [open, setOpen] = useState(parentActive);
  useEffect(() => {
    if (parentActive) setOpen(true);
  }, [parentActive]);

  if (!hasChildren) {
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
      </SidebarMenuItem>
    );
  }

  if (collapsed) {
    return (
      <SidebarMenuItem>
        <NavFlyout
          entry={entry}
          pathname={pathname}
          parentActive={parentActive}
        />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="group/collapsible w-full"
      >
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              isActive={parentActive}
              tooltip={entry.label}
            />
          }
        >
          <Icon />
          <span>{entry.label}</span>
          <ChevronRight
            className={cn(
              "ml-auto transition-transform duration-200 ease-out-soft",
              "group-data-[open]/collapsible:rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
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
                    render={<Link href={child.href} />}
                  >
                    <ChildIcon />
                    <span>{child.label}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
});

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

  const showPlatformServices = !multiTenant || isPlatformAdmin;

  const agentNav = useMemo<NavEntry>(
    () => ({
      id: "agents",
      href: "/dashboard/agents",
      label: "Agents",
      icon: Bot,
      isActive: (path) =>
        path === "/dashboard/agents" || path.startsWith("/dashboard/agents/"),
      children: agentChildren,
    }),
    [agentChildren],
  );

  const platformNav = useMemo<NavEntry[]>(() => {
    const nav: NavEntry[] = [
      {
        id: "chat",
        href: "/chat",
        label: "聊天",
        icon: MessageSquare,
        isActive: (path) => path === "/chat" || path.startsWith("/chat/"),
      },
      {
        id: "web",
        href: "/dashboard/web",
        label: "网页",
        icon: Globe,
        isActive: (path) =>
          path === "/dashboard/web" || path.startsWith("/dashboard/web/"),
      },
      {
        id: "server",
        href: "/dashboard/runners",
        label: "服务器",
        icon: Server,
        isActive: serverSectionActive,
        children: buildServerChildren(showPlatformServices),
      },
      {
        id: "memory",
        href: "/dashboard/memory",
        label: "记忆",
        icon: Brain,
      },
      {
        id: "skills",
        href: "/dashboard/skills",
        label: "技能",
        icon: Sparkles,
        isActive: (path) =>
          path === "/dashboard/skills" || path.startsWith("/dashboard/skills/"),
      },
      {
        id: "models",
        href: "/dashboard/models",
        label: "模型路由",
        icon: Cpu,
        isActive: (path) =>
          path === "/dashboard/models" || path.startsWith("/dashboard/models/"),
        children: [
          {
            href: "/dashboard/models",
            label: "模型",
            icon: Route,
            isActive: (path) => path === "/dashboard/models",
          },
          {
            href: "/dashboard/models/upstreams",
            label: "上游",
            icon: Server,
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
            label: "已安装",
            icon: Server,
            isActive: mcpServerActive,
          },
          {
            href: "/dashboard/mcp/store",
            label: "商店",
            icon: Store,
            isActive: mcpStoreActive,
          },
          {
            href: "/dashboard/mcp/import",
            label: "导入",
            icon: CloudDownload,
          },
        ],
      },
      {
        id: "connectors",
        href: "/dashboard/connectors",
        label: "平台连接器",
        icon: Plug,
        isActive: (path) =>
          path === "/dashboard/connectors" ||
          path.startsWith("/dashboard/connectors/"),
      },
      {
        id: "tool-calls",
        href: "/dashboard/tool-calls",
        label: "调用追踪",
        icon: Activity,
      },
      {
        id: "advanced",
        href: "/dashboard/policies",
        label: "高级",
        icon: SlidersHorizontal,
        isActive: advancedSectionActive,
        children: [
          {
            href: "/dashboard/policies",
            label: "策略",
            icon: Shield,
          },
          {
            href: "/dashboard/keys",
            label: "Keys",
            icon: KeyRound,
          },
        ],
      },
      {
        id: "settings",
        href: "/dashboard/settings/team",
        label: "设置",
        icon: Settings2,
        isActive: (path) => path.startsWith("/dashboard/settings/"),
        children: [
          {
            href: "/dashboard/settings/team",
            label: "团队",
            icon: Building2,
          },
          {
            href: "/dashboard/settings/oauth-clients",
            label: "OAuth 客户端",
            icon: KeyRound,
          },
          ...(multiTenant
            ? [
                {
                  href: "/dashboard/settings/teams",
                  label: "所有团队",
                  icon: Building2,
                } satisfies SubNavItem,
              ]
            : []),
        ],
      },
    ];

    if (multiTenant && isPlatformAdmin) {
      nav.push({
        id: "admin",
        href: "/dashboard/admin",
        label: "超管",
        icon: ShieldCheck,
      });
    }

    return nav;
  }, [multiTenant, isPlatformAdmin, showPlatformServices]);

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-1 border-b border-sidebar-border px-3 py-3">
        <div className="min-w-0 px-1 group-data-[collapsible=icon]:px-0">
          <BrandMark
            className="group-data-[collapsible=icon]:justify-center"
            iconClassName="size-6"
          />
          {multiTenant ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="mt-0.5 flex w-full min-w-0 items-center gap-1 truncate text-left text-[11px] text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:hidden">
                <span className="truncate">{tenant || "—"}</span>
                <ChevronRight className="size-3 shrink-0 rotate-90 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>切换团队</DropdownMenuLabel>
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
                <DropdownMenuItem onClick={() => router.push("/dashboard/settings/teams")}>
                  管理团队…
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
              <ExpandableNavItem entry={agentNav} pathname={pathname} />
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
