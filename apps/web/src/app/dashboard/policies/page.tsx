"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

type Policy = {
  id: string;
  name: string;
  instanceIds?: string[];
  toolAllowlist?: string[] | null;
  toolDenylist?: string[] | null;
  includeBuiltin?: boolean;
};

type InstanceRow = { id: string; name: string; slug: string };

export default function PoliciesPage() {
  const { confirm } = useConfirmDialog();
  const [rows, setRows] = useState<Policy[]>([]);
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [name, setName] = useState("");
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [includeBuiltin, setIncludeBuiltin] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{
      policies: Policy[];
      instances: InstanceRow[];
    }>("/api/mcp/policies/bootstrap");
    setRows(res.policies);
    setInstances(res.instances);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName("");
    setInstanceIds([]);
    setAllow("");
    setDeny("");
    setIncludeBuiltin(false);
    setOpen(true);
  }

  function openEdit(row: Policy) {
    setEditing(row);
    setName(row.name);
    setInstanceIds(row.instanceIds ?? []);
    setAllow((row.toolAllowlist ?? []).join(", "));
    setDeny((row.toolDenylist ?? []).join(", "));
    setIncludeBuiltin(row.includeBuiltin ?? false);
    setOpen(true);
  }

  function parseList(s: string) {
    return s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="策略"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus />
            新建
          </Button>
        }
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>关联 Agent</TableHead>
            <TableHead>允许</TableHead>
            <TableHead>拒绝</TableHead>
            <TableHead>内置</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-xs">{row.name}</TableCell>
              <TableCell className="text-xs">
                {!(row.instanceIds ?? []).length
                  ? "全部"
                  : (row.instanceIds ?? [])
                      .map((id) => instances.find((i) => i.id === id)?.slug ?? id.slice(0, 6))
                      .join(", ")}
              </TableCell>
              <TableCell className="max-w-[120px] truncate text-xs">
                {(row.toolAllowlist ?? []).join(", ") || "—"}
              </TableCell>
              <TableCell className="max-w-[120px] truncate text-xs">
                {(row.toolDenylist ?? []).join(", ") || "—"}
              </TableCell>
              <TableCell>
                <Badge variant={row.includeBuiltin ? "success" : "secondary"}>
                  {row.includeBuiltin ? "开" : "关"}
                </Badge>
              </TableCell>
              <TableCell>
                <TableActions>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={async () => {
                      if (!(await confirm({ title: "删除此策略？", confirmLabel: "删除" }))) return;
                      await api(`/api/mcp/policies/${row.id}`, { method: "DELETE" });
                      toast.success("已删除");
                      await load();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </TableActions>
              </TableCell>
            </TableRow>
          ))}
          {!rows.length ? (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                暂无策略
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "编辑策略" : "新建策略"}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const allowlist = parseList(allow);
              const denylist = parseList(deny);
              const payload = {
                name,
                policy: {
                  instanceIds,
                  toolAllowlist: allowlist.length ? allowlist : null,
                  toolDenylist: denylist.length ? denylist : null,
                  includeBuiltin,
                },
              };
              try {
                if (editing) {
                  await api(`/api/mcp/policies/${editing.id}`, {
                    method: "PUT",
                    json: payload,
                  });
                } else {
                  await api("/api/mcp/policies", { method: "POST", json: payload });
                }
                toast.success("已保存");
                setOpen(false);
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例如：只读策略" />
            </div>
            <div className="space-y-1.5">
              <Label>关联 Agent（留空=全部）</Label>
              <Input
                value={instanceIds.join(",")}
                onChange={(e) =>
                  setInstanceIds(
                    e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  )
                }
                placeholder={instances.map((i) => i.id).slice(0, 2).join(",") || "instance id"}
              />
            </div>
            <div className="space-y-1.5">
              <Label>允许的工具</Label>
              <Input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="tool_a, tool_b" />
            </div>
            <div className="space-y-1.5">
              <Label>拒绝的工具</Label>
              <Input value={deny} onChange={(e) => setDeny(e.target.value)} />
            </div>
            <div className="flex items-center justify-between">
              <Label>内置工具</Label>
              <Switch checked={includeBuiltin} onCheckedChange={setIncludeBuiltin} />
            </div>
            <DialogFooter>
              <Button type="submit" className="w-full">
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
