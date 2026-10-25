export const SPACE_SUBNAV = [
  { href: "platforms", label: "消息平台" },
  { href: "connect", label: "接入" },
  { href: "acp", label: "ACP Agent" },
  { href: "projects", label: "项目" },
  { href: "skills", label: "技能" },
  { href: "computer", label: "工作区" },
  { href: "disks", label: "数据盘" },
  { href: "computers", label: "其他电脑" },
  { href: "mcp", label: "MCP" },
  { href: "web", label: "网页" },
  { href: "approvals", label: "工具审批" },
  { href: "automation", label: "自动化" },
  { href: "tool-calls", label: "调用记录" },
] as const;

export type SpaceSubnavHref = (typeof SPACE_SUBNAV)[number]["href"];
