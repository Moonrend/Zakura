"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlarmClock,
  ArrowLeft,
  ArrowUpCircle,
  Bot,
  Brain,
  Cable,
  ChevronRight,
  Cpu,
  FolderKanban,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Monitor,
  Network,
  Plug,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Users,
  Wrench,
  HardDrive,
  Building2,
  ShieldCheck,
  Route,
  Container,
  Blocks,
} from "lucide-react";
import { api, setSession } from "@/lib/api";
import { AGENT_SUBNAV, fetchAgents, type AgentListItem } from "@/lib/agents";
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
import { ImageUpdateIndicator } from "@/components/image-update-status";
import { BrandMark } from "@/components/brand-mark";
import { ProgressLinear } from "@/components/ui/progress-linear";

type IconComp = React.ComponentType<{ className?: string }>;

type SubNavItem = {
  href: string;
  label: string;
  icon: IconComp;
  isActive?: (pathname: string) => boolean;
  /** Render the image-update count next to this item (see ImageUpdateIndicator). */
  showImageUpdates?: boolean;
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
  overview: LayoutDashboard,
  settings: Settings2,
  computer: Monitor,
  projects: FolderKanban,
  web: Globe,
  memory: Brain,
  skills: Blocks,
  mcp: Cable,
  connect: Plug,
  gateway: Route,
  platforms: MessageSquare,
  automation: AlarmClock,
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
      label: "设备",
      icon: HardDrive,
      isActive: (path) =>
        path === "/dashboard/runners" ||
        (path.startsWith("/dashboard/runners/") &&
          !path.startsWith("/dashboard/runners/upgrades")),
    },
    {
      href: "/dashboard/runners/upgrades",
      label: "升级中心",
      icon: ArrowUpCircle,
      isActive: (path) =>
        path === "/dashboard/runners/upgrades" ||
        path.startsWith("/dashboard/runners/upgrades/"),
      showImageUpdates: true,
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
            <span>概览</span>
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
                  {child.showImageUpdates ? <ImageUpdateIndicator /> : null}
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
                    {child.showImageUpdates ? <ImageUpdateIndicator /> : null}
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

function SidebarUserFooter() {
  const router = useRouter();

  return (
    <SidebarFooter className="border-t border-sidebar-border">
      <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          className="press flex-1 justify-start group-data-[collapsible=icon]:size-7 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:px-0"
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
  );
}

function TenantHeader({
  tenant,
  multiTenant,
}: {
  tenant: string;
  multiTenant: boolean;
}) {
  const router = useRouter();
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

  return (
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
            {/* A navigation item, so render it as a link like every other one
                in this file — a router.push here loses copy-link / new-tab. */}
            <DropdownMenuItem render={<Link href="/dashboard/settings/teams" />}>
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
  );
}

/** Agent 配置独立侧边栏：顶栏返回 + 配置子导航 */
function AgentConfigSidebar({
  agentId,
  pathname,
}: {
  agentId: string;
  pathname: string;
}) {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await fetchAgents();
        if (!cancelled) setAgents(rows);
      } catch {
        if (!cancelled) setAgents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const current = agents.find((a) => a.id === agentId);
  const activeSeg =
    AGENT_SUBNAV.find((s) => pathname.endsWith(`/${s.href}`))?.href ?? "overview";

  const navItems = useMemo(
    () =>
      AGENT_SUBNAV.map((item) => ({
        href: `/dashboard/agents/${agentId}/${item.href}`,
        label: item.label,
        icon: AGENT_ICONS[item.href] ?? Settings2,
        seg: item.href,
      })),
    [agentId],
  );

  function closeMobile() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <>
      <SidebarHeader className="gap-2 border-b border-sidebar-border px-3 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="返回 Agents"
              render={<Link href="/dashboard/agents" onClick={closeMobile} />}
            >
              <ArrowLeft />
              <span>返回</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <div className="min-w-0 px-1 group-data-[collapsible=icon]:hidden">
          <div className="text-[11px] font-medium text-muted-foreground">
            Agent 配置
          </div>
          {loading && !current ? (
            <ProgressLinear indeterminate className="mt-2 max-w-24" />
          ) : agents.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="mt-0.5 flex w-full min-w-0 items-center gap-1 truncate text-left text-sm font-medium hover:text-foreground">
                <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{current?.name ?? "Agent"}</span>
                <ChevronRight className="size-3 shrink-0 rotate-90 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>切换 Agent</DropdownMenuLabel>
                  {agents.map((a) => (
                    <DropdownMenuItem
                      key={a.id}
                      onClick={() => {
                        router.push(`/dashboard/agents/${a.id}/${activeSeg}`);
                        closeMobile();
                      }}
                    >
                      <span className="truncate">{a.name}</span>
                      {a.id === agentId ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">当前</span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  render={<Link href="/dashboard/agents" onClick={closeMobile} />}
                >
                  全部 Agents…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <Bot className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{current?.name ?? "Agent"}</span>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>配置</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href || pathname.endsWith(`/${item.seg}`);
                return (
                  <SidebarMenuItem key={item.seg}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.label}
                      render={<Link href={item.href} onClick={closeMobile} />}
                    >
                      <Icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarUserFooter />
    </>
  );
}

/** 超管后台独立侧边栏：顶栏返回 + 分组导航 */
function AdminSidebar({ pathname }: { pathname: string }) {
  const { isMobile, setOpenMobile } = useSidebar();

  const groups: Array<{ label: string; items: SubNavItem[] }> = [
    {
      label: "总览",
      items: [
        {
          href: "/dashboard/admin",
          label: "概览",
          icon: LayoutDashboard,
          isActive: (path) => path === "/dashboard/admin",
        },
      ],
    },
    {
      label: "账号",
      items: [
        { href: "/dashboard/admin/users", label: "用户", icon: Users },
        { href: "/dashboard/admin/tenants", label: "团队", icon: Building2 },
      ],
    },
    {
      label: "资源",
      items: [
        { href: "/dashboard/admin/runners", label: "共享 Runner", icon: HardDrive },
        { href: "/dashboard/admin/platform", label: "平台服务", icon: Container },
      ],
    },
    {
      label: "配置",
      items: [
        { href: "/dashboard/admin/agent-defaults", label: "Agent 默认", icon: Bot },
        { href: "/dashboard/admin/auth", label: "登录与认证", icon: KeyRound },
      ],
    },
  ];

  function closeMobile() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <>
      <SidebarHeader className="gap-2 border-b border-sidebar-border px-3 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="返回控制台"
              render={<Link href="/dashboard/agents" onClick={closeMobile} />}
            >
              <ArrowLeft />
              <span>返回</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <div className="min-w-0 px-1 group-data-[collapsible=icon]:hidden">
          <div className="text-[11px] font-medium text-muted-foreground">
            超级管理员
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">平台后台</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.isActive
                    ? item.isActive(pathname)
                    : defaultActive(pathname, item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.label}
                        render={<Link href={item.href} onClick={closeMobile} />}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarUserFooter />
    </>
  );
}

function PlatformSidebar({
  tenant,
  multiTenant,
  isPlatformAdmin,
  pathname,
}: {
  tenant: string;
  multiTenant: boolean;
  isPlatformAdmin: boolean;
  pathname: string;
}) {
  const showPlatformServices = !multiTenant || isPlatformAdmin;

  const platformNav = useMemo<NavEntry[]>(() => {
    const nav: NavEntry[] = [
      {
        id: "agents",
        href: "/dashboard/agents",
        label: "Agents",
        icon: Bot,
        isActive: (path) =>
          path === "/dashboard/agents" || path.startsWith("/dashboard/agents/"),
      },
      {
        id: "chat",
        href: "/chat",
        label: "聊天",
        icon: MessageSquare,
        isActive: (path) => path === "/chat" || path.startsWith("/chat/"),
      },
      /* connectors 已移入 agent 内部页面，顶层入口移除 */
      /* skills 已移入 agent 内部页面，顶层入口移除 */
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
      /* mcp 已移入 agent 内部页面，顶层入口移除；
         /dashboard/mcp/* 详情、商店、导入页面仍可通过 agent MCP 页链接访问 */
      {
        id: "models",
        href: "/dashboard/models",
        label: "模型",
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
        id: "tool-calls",
        href: "/dashboard/tool-calls",
        label: "分析",
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
          {
            href: "/dashboard/settings/oauth-clients",
            label: "OAuth 客户端",
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
          ...(multiTenant
            ? [
                {
                  href: "/dashboard/settings/usage",
                  label: "成员用量",
                  icon: Users,
                } satisfies SubNavItem,
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
        label: "Admin",
        icon: ShieldCheck,
      });
    }

    return nav;
  }, [multiTenant, isPlatformAdmin, showPlatformServices]);

  return (
    <>
      <SidebarHeader className="gap-1 border-b border-sidebar-border px-3 py-3">
        <TenantHeader tenant={tenant} multiTenant={multiTenant} />
      </SidebarHeader>

      <SidebarContent>
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

      <SidebarUserFooter />
    </>
  );
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
  const agentId = parseAgentId(pathname);
  const inAdmin =
    multiTenant && isPlatformAdmin && pathname.startsWith("/dashboard/admin");

  return (
    <Sidebar collapsible="icon" variant="inset">
      {agentId ? (
        <AgentConfigSidebar agentId={agentId} pathname={pathname} />
      ) : inAdmin ? (
        <AdminSidebar pathname={pathname} />
      ) : (
        <PlatformSidebar
          tenant={tenant}
          multiTenant={multiTenant}
          isPlatformAdmin={isPlatformAdmin}
          pathname={pathname}
        />
      )}
    </Sidebar>
  );
}
