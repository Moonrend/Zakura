"use client";

import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  SchemaToolForm,
  defaultsFromSchema,
} from "@/components/mcp/schema-tool-form";
import { cn } from "@/lib/utils";

export type McpToolRow = {
  qualifiedName: string;
  description?: string;
  providerId?: string;
  inputSchema?: Record<string, unknown>;
  localName?: string;
  agentScoped?: boolean;
};

export type McpResourceRow = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  providerId?: string;
};

export type McpPromptRow = {
  name: string;
  description?: string;
  title?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  providerId?: string;
};

export type McpResourceTemplateRow = {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  providerId?: string;
};

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-10 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function McpToolsExplorer({
  tools,
  agentId,
  emptyHint = "暂无工具",
}: {
  tools: McpToolRow[];
  agentId?: string;
  emptyHint?: string;
}) {
  const [selected, setSelected] = useState<McpToolRow | null>(null);
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [resultText, setResultText] = useState("");
  const [calling, setCalling] = useState(false);

  function selectTool(t: McpToolRow) {
    setSelected(t);
    setArgs(defaultsFromSchema(t.inputSchema ?? { type: "object", properties: {} }));
    setResultText("");
  }

  async function runTool() {
    if (!selected) return;
    setCalling(true);
    setResultText("");
    try {
      const res = await api<{ ok: boolean; result: unknown }>("/api/mcp/call", {
        method: "POST",
        json: {
          qualifiedName: selected.qualifiedName,
          arguments: args,
          agentId,
        },
      });
      setResultText(JSON.stringify(res.result, null, 2));
      if (!res.ok) toast.error("工具返回错误");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">工具 · {tools.length}</h2>
        <div className="max-h-[520px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((t) => (
                <TableRow
                  key={t.qualifiedName}
                  className={cn(
                    "cursor-pointer",
                    selected?.qualifiedName === t.qualifiedName
                      ? "bg-muted/50"
                      : "hover:bg-muted/30",
                  )}
                  onClick={() => selectTool(t)}
                >
                  <TableCell>
                    <code className="text-[11px]">{t.localName ?? t.qualifiedName}</code>
                    <div className="mt-0.5 max-w-[320px] truncate text-[10px] text-muted-foreground">
                      {t.description}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!tools.length ? <EmptyRow colSpan={1}>{emptyHint}</EmptyRow> : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">工具试用</h2>
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          {selected ? (
            <>
              <div>
                <code className="text-xs">{selected.qualifiedName}</code>
                <p className="mt-1 text-xs text-muted-foreground">{selected.description}</p>
              </div>
              <SchemaToolForm
                schema={selected.inputSchema ?? { type: "object", properties: {} }}
                value={args}
                onChange={setArgs}
              />
              <Button disabled={calling} onClick={() => void runTool()}>
                <Play />
                {calling ? "调用中…" : "运行"}
              </Button>
              {resultText ? (
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {resultText}
                </pre>
              ) : null}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              选择左侧工具，按 schema 生成表单后试用。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function McpResourcesExplorer({
  resources,
  templates = [],
  agentId,
  emptyHint = "暂无资源",
}: {
  resources: McpResourceRow[];
  templates?: McpResourceTemplateRow[];
  agentId?: string;
  emptyHint?: string;
}) {
  const [selected, setSelected] = useState<McpResourceRow | null>(null);
  const [resultText, setResultText] = useState("");
  const [reading, setReading] = useState(false);

  async function readResource(row: McpResourceRow) {
    setSelected(row);
    setReading(true);
    setResultText("");
    try {
      const res = await api<{ ok: boolean; result: unknown }>("/api/mcp/resources/read", {
        method: "POST",
        json: { uri: row.uri, agentId },
      });
      setResultText(JSON.stringify(res.result, null, 2));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Resources · {resources.length}</h2>
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resources.map((r) => (
                  <TableRow
                    key={r.uri}
                    className={cn(
                      "cursor-pointer",
                      selected?.uri === r.uri ? "bg-muted/50" : "hover:bg-muted/30",
                    )}
                    onClick={() => void readResource(r)}
                  >
                    <TableCell>
                      <div className="text-xs font-medium">{r.title || r.name}</div>
                      <code className="mt-0.5 block max-w-[360px] truncate text-[10px] text-muted-foreground">
                        {r.uri}
                      </code>
                      {r.description ? (
                        <div className="mt-0.5 max-w-[360px] truncate text-[10px] text-muted-foreground">
                          {r.description}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {!resources.length ? <EmptyRow colSpan={1}>{emptyHint}</EmptyRow> : null}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">读取内容</h2>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            {selected ? (
              <>
                <div>
                  <div className="text-xs font-medium">{selected.title || selected.name}</div>
                  <code className="mt-1 block break-all text-[11px] text-muted-foreground">
                    {selected.uri}
                  </code>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reading}
                  onClick={() => void readResource(selected)}
                >
                  {reading ? "读取中…" : "重新读取"}
                </Button>
                {resultText ? (
                  <pre className="max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {resultText}
                  </pre>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {reading ? "读取中…" : "选择资源"}
                  </p>
                )}
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                选择资源
              </p>
            )}
          </div>
        </section>
      </div>

      {templates.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Resource Templates · {templates.length}</h2>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>URI Template</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.uriTemplate}>
                    <TableCell>
                      <div className="text-xs font-medium">{t.title || t.name}</div>
                      {t.description ? (
                        <div className="mt-0.5 max-w-[280px] truncate text-[10px] text-muted-foreground">
                          {t.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <code className="break-all text-[11px] text-muted-foreground">
                        {t.uriTemplate}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function McpPromptsExplorer({
  prompts,
  agentId,
  emptyHint = "暂无 Prompts",
}: {
  prompts: McpPromptRow[];
  agentId?: string;
  emptyHint?: string;
}) {
  const [selected, setSelected] = useState<McpPromptRow | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [resultText, setResultText] = useState("");
  const [calling, setCalling] = useState(false);

  const argSchema = useMemo(() => {
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const a of selected?.arguments ?? []) {
      properties[a.name] = {
        type: "string",
        description: a.description,
      };
      if (a.required) required.push(a.name);
    }
    return { type: "object", properties, required };
  }, [selected]);

  function selectPrompt(p: McpPromptRow) {
    setSelected(p);
    const next: Record<string, string> = {};
    for (const a of p.arguments ?? []) next[a.name] = "";
    setArgs(next);
    setResultText("");
  }

  async function runPrompt() {
    if (!selected) return;
    setCalling(true);
    setResultText("");
    try {
      const res = await api<{ ok: boolean; result: unknown }>("/api/mcp/prompts/get", {
        method: "POST",
        json: {
          name: selected.name,
          arguments: args,
          agentId,
        },
      });
      setResultText(JSON.stringify(res.result, null, 2));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Prompts · {prompts.length}</h2>
        <div className="max-h-[520px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prompt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prompts.map((p) => (
                <TableRow
                  key={p.name}
                  className={cn(
                    "cursor-pointer",
                    selected?.name === p.name ? "bg-muted/50" : "hover:bg-muted/30",
                  )}
                  onClick={() => selectPrompt(p)}
                >
                  <TableCell>
                    <code className="text-[11px]">{p.name}</code>
                    <div className="mt-0.5 max-w-[320px] truncate text-[10px] text-muted-foreground">
                      {p.description || p.title}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!prompts.length ? <EmptyRow colSpan={1}>{emptyHint}</EmptyRow> : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">获取 Prompt</h2>
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          {selected ? (
            <>
              <div>
                <code className="text-xs">{selected.name}</code>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selected.description || selected.title}
                </p>
              </div>
              {(selected.arguments?.length ?? 0) > 0 ? (
                <SchemaToolForm
                  schema={argSchema}
                  value={args}
                  onChange={(next) => {
                    const out: Record<string, string> = {};
                    for (const [k, v] of Object.entries(next)) {
                      out[k] = v == null ? "" : String(v);
                    }
                    setArgs(out);
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">该 Prompt 无参数</p>
              )}
              <Button disabled={calling} onClick={() => void runPrompt()}>
                <Play />
                {calling ? "获取中…" : "获取"}
              </Button>
              {resultText ? (
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {resultText}
                </pre>
              ) : null}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              选择左侧 Prompt 填写参数后获取。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/** Prompt 参数补全（completion/complete）简易面板 */
export function McpPromptCompletePanel({
  promptName,
  argumentName,
  agentId,
}: {
  promptName: string;
  argumentName: string;
  agentId?: string;
}) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function runComplete() {
    setBusy(true);
    try {
      const res = await api<{
        ok: boolean;
        result: { completion?: { values?: string[] } };
      }>("/api/mcp/complete", {
        method: "POST",
        json: {
          ref: { type: "ref/prompt", name: promptName },
          argument: { name: argumentName, value },
          agentId,
        },
      });
      setSuggestions(res.result.completion?.values ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <Label className="text-xs">补全 · {argumentName}</Label>
      <div className="flex gap-2">
        <Input
          className="h-8 text-xs"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="输入前缀…"
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void runComplete()}>
          补全
        </Button>
      </div>
      {suggestions.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setValue(s)}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
