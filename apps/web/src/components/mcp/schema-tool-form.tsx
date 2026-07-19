"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  format?: string;
  minimum?: number;
  maximum?: number;
};

function primaryType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== "null") ?? schema.type[0] ?? "string";
  }
  return schema.type ?? (schema.properties ? "object" : schema.enum ? "string" : "string");
}

function guessWidget(name: string, schema: JsonSchema): string {
  const t = primaryType(schema);
  const format = schema.format ?? "";
  const lower = name.toLowerCase();
  if (schema.enum?.length) return "enum";
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "array" || t === "object") return "json";
  if (format === "uri" || format === "url" || lower.includes("url")) return "url";
  if (
    format === "password" ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key")
  ) {
    return "password";
  }
  if (
    format === "textarea" ||
    lower.includes("content") ||
    lower.includes("body") ||
    lower.includes("prompt") ||
    lower.includes("query") ||
    (typeof schema.description === "string" && schema.description.length > 80)
  ) {
    return "textarea";
  }
  if (lower.includes("path") || lower.includes("file") || lower.includes("dir")) return "path";
  return "string";
}

export function SchemaToolForm({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown> | JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const normalized = schema as JsonSchema;
  const properties = useMemo(
    () => normalized.properties ?? {},
    [normalized.properties],
  );
  const required = new Set(normalized.required ?? []);

  const entries = Object.entries(properties);
  if (!entries.length) {
    return (
      <div className="space-y-1.5">
        <Label>参数（JSON）</Label>
        <Textarea
          className="font-mono text-xs"
          rows={6}
          value={JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value || "{}") as Record<string, unknown>;
              onChange(parsed);
            } catch {
              /* keep typing */
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map(([name, field]) => {
        const widget = guessWidget(name, field);
        const label = field.title || name;
        const current = value[name];
        const isRequired = required.has(name);

        return (
          <div key={name} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label>
                {label}
                {isRequired ? <span className="text-destructive"> *</span> : null}
              </Label>
              <span className="text-[10px] text-muted-foreground">{widget}</span>
            </div>
            {field.description ? (
              <p className="text-[11px] text-muted-foreground">{field.description}</p>
            ) : null}

            {widget === "boolean" ? (
              <Switch
                checked={Boolean(current)}
                onCheckedChange={(v) => onChange({ ...value, [name]: v })}
              />
            ) : null}

            {widget === "enum" ? (
              <Select
                value={current != null ? String(current) : ""}
                onValueChange={(v) => {
                  if (v != null) onChange({ ...value, [name]: v });
                }}
                items={(field.enum ?? []).map((opt) => ({
                  value: String(opt),
                  label: String(opt),
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择…" />
                </SelectTrigger>
                <SelectContent>
                  {(field.enum ?? []).map((opt) => (
                    <SelectItem key={String(opt)} value={String(opt)}>
                      {String(opt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {widget === "number" ? (
              <Input
                type="number"
                value={current == null ? "" : String(current)}
                min={field.minimum}
                max={field.maximum}
                onChange={(e) => {
                  const n = e.target.value === "" ? undefined : Number(e.target.value);
                  onChange({ ...value, [name]: n });
                }}
              />
            ) : null}

            {widget === "textarea" || widget === "json" ? (
              <Textarea
                className={widget === "json" ? "font-mono text-xs" : "text-sm"}
                rows={widget === "json" ? 5 : 3}
                value={
                  widget === "json"
                    ? typeof current === "string"
                      ? current
                      : JSON.stringify(current ?? (widget === "json" ? [] : ""), null, 2)
                    : current == null
                      ? ""
                      : String(current)
                }
                onChange={(e) => {
                  if (widget === "json") {
                    try {
                      onChange({ ...value, [name]: JSON.parse(e.target.value || "null") });
                    } catch {
                      onChange({ ...value, [name]: e.target.value });
                    }
                  } else {
                    onChange({ ...value, [name]: e.target.value });
                  }
                }}
              />
            ) : null}

            {widget === "string" ||
            widget === "url" ||
            widget === "password" ||
            widget === "path" ? (
              <Input
                type={widget === "password" ? "password" : widget === "url" ? "url" : "text"}
                placeholder={
                  widget === "path"
                    ? "/data/…"
                    : widget === "url"
                      ? "https://…"
                      : undefined
                }
                value={current == null ? "" : String(current)}
                onChange={(e) => onChange({ ...value, [name]: e.target.value })}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Seed defaults from JSON Schema */
export function defaultsFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const s = schema as JsonSchema;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(s.properties ?? {})) {
    if (field.default !== undefined) out[name] = field.default;
    else if (primaryType(field) === "boolean") out[name] = false;
    else if (primaryType(field) === "array") out[name] = [];
    else if (primaryType(field) === "object") out[name] = {};
  }
  return out;
}
