"use client";

import type { McpToolPermissionState } from "@/lib/mcp-config";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

type McpToolPermissionsPanelProps = {
  rules: McpToolPermissionState[];
  disabled?: boolean;
  onChange: (ruleId: string, enabled: boolean) => void;
  className?: string;
};

/**
 * 统一工具权限面板：provider 声明规则，实例页复用此组件。
 */
export function McpToolPermissionsPanel({
  rules,
  disabled,
  onChange,
  className,
}: McpToolPermissionsPanelProps) {
  if (!rules.length) return null;

  return (
    <section className={className ?? "space-y-2"}>
      <h2 className="text-sm font-medium">工具权限</h2>
      <p className="text-xs text-muted-foreground">
        关闭后对应工具不会出现在 Agent 的 tools/list 中，也无法调用。
      </p>
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{rule.label}</span>
                <code className="text-[10px] text-muted-foreground">{rule.id}</code>
                {!rule.defaultEnabled ? (
                  <Badge variant="secondary" className="text-[10px]">
                    默认关
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{rule.description}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {rule.tools.join(", ")}
              </p>
            </div>
            <Switch
              checked={rule.enabled}
              disabled={disabled}
              onCheckedChange={(on) => onChange(rule.id, on)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
