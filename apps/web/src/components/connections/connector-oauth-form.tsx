"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export type ConnectorOauthField = {
  key: string;
  label: string;
  type: "text" | "secret" | "url" | "textarea" | "select" | "boolean";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
};

export type ConnectorOauthFormProps = {
  title?: string;
  description?: string;
  fields: ConnectorOauthField[];
  configuredFields: string[];
  draft: Record<string, string>;
  onDraftChange: (next: Record<string, string>) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  redirectUri?: string;
  docsUrl?: string;
  canManage: boolean;
  lockedHint?: string;
  saving?: boolean;
  onSave: () => void;
  enableLabel?: string;
  enableHint?: string;
};

/** 连接器配置表单：OAuth、静态令牌和自定义字段共用 */
export function ConnectorOauthForm({
  title = "OAuth 客户端",
  description,
  fields,
  configuredFields,
  draft,
  onDraftChange,
  enabled,
  onEnabledChange,
  redirectUri,
  docsUrl,
  canManage,
  lockedHint,
  saving,
  onSave,
  enableLabel = "启用",
  enableHint,
}: ConnectorOauthFormProps) {
  return (
    <section className="space-y-5 rounded-xl border border-border bg-card p-5">
      <header>
        <h2 className="text-sm font-medium">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </header>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{enableLabel}</div>
          {enableHint ? (
            <p className="text-xs text-muted-foreground">{enableHint}</p>
          ) : null}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={!canManage}
        />
      </div>

      <div className="space-y-4">
        {fields.map((field) => (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={`cred-${field.key}`}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            {field.type === "boolean" ? (
              <Switch
                id={`cred-${field.key}`}
                checked={draft[field.key] === "true"}
                onCheckedChange={(checked) =>
                  onDraftChange({ ...draft, [field.key]: String(checked) })
                }
                disabled={!canManage}
              />
            ) : field.type === "select" ? (
              <select
                id={`cred-${field.key}`}
                value={draft[field.key] ?? field.defaultValue ?? ""}
                onChange={(event) =>
                  onDraftChange({ ...draft, [field.key]: event.target.value })
                }
                disabled={!canManage}
                className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">请选择</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <Textarea
                id={`cred-${field.key}`}
                value={draft[field.key] ?? ""}
                onChange={(event) =>
                  onDraftChange({ ...draft, [field.key]: event.target.value })
                }
                placeholder={
                  configuredFields.includes(field.key)
                    ? "已保存；留空保持原值"
                    : field.placeholder ?? field.defaultValue
                }
                autoComplete="off"
                disabled={!canManage}
              />
            ) : (
              <Input
                id={`cred-${field.key}`}
                type={field.type === "secret" ? "password" : "text"}
                value={draft[field.key] ?? ""}
                onChange={(event) =>
                  onDraftChange({ ...draft, [field.key]: event.target.value })
                }
                placeholder={
                  configuredFields.includes(field.key)
                    ? "已保存；留空保持原值"
                    : field.placeholder ?? field.defaultValue
                }
                autoComplete="off"
                disabled={!canManage}
              />
            )}
            {field.help ? (
              <p className="text-[11px] leading-4 text-muted-foreground">{field.help}</p>
            ) : null}
          </div>
        ))}

        {redirectUri ? (
          <div className="space-y-1.5">
            <Label>OAuth 回调 URI</Label>
            <code className="block break-all rounded-md bg-muted/50 px-2.5 py-2 text-xs">
              {redirectUri}
            </code>
          </div>
        ) : null}

        {docsUrl ? (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            打开厂商控制台
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        {!canManage ? (
          <p className="text-xs text-muted-foreground">
            {lockedHint ?? "仅管理员可修改"}
          </p>
        ) : (
          <span />
        )}
        <Button onClick={onSave} disabled={saving || !canManage}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          保存
        </Button>
      </div>
    </section>
  );
}
