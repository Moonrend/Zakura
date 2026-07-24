"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  agentId: string | null;
};

export function StepConnect({ agentId }: Props) {
  const [mcpUrl, setMcpUrl] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) {
      setLoading(false);
      return;
    }
    void api<{ mcpAgentUrl: string }>(`/api/agents/${agentId}`)
      .then((a) => setMcpUrl(a.mcpAgentUrl))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (!agentId) {
    return <p className="text-sm text-muted-foreground">请先创建 Agent。</p>;
  }
  if (loading) return <Skeleton className="h-16 w-full rounded-lg" />;

  return (
    <div className="mx-auto max-w-md space-y-3">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-[11px]">
          {mcpUrl}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(mcpUrl);
            toast.success("已复制");
          }}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
