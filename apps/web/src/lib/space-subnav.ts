export const SPACE_SUBNAV = [
  { href: "platforms", label: "消息平台" },
  { href: "connect", label: "接入" },
  { href: "acp", label: "ACP Agent" },
  { href: "gateway", label: "AI Gateway" },
  { href: "projects", label: "项目" },
  { href: "computer", label: "电脑" },
  { href: "mcp", label: "MCP" },
  { href: "web", label: "网页" },
  { href: "automation", label: "自动化" },
  { href: "tool-calls", label: "调用记录" },
] as const;

export type SpaceSubnavHref = (typeof SPACE_SUBNAV)[number]["href"];
