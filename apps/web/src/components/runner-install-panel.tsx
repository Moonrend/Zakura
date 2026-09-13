"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import type { RunnerInstallPackage } from "@/lib/runners";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function CopyBlock({
  value,
  compact,
  label,
}: {
  value: string;
  compact?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value.trim()) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyText(value).then(() => {
              setCopied(true);
              toast.success("已复制");
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {label ?? "复制"}
        </Button>
      </div>
      <pre
        className={`overflow-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all ${
          compact ? "max-h-40" : "max-h-72"
        }`}
      >
        {value}
      </pre>
    </div>
  );
}

type TabId = "unix" | "windows";

export function RunnerInstallPanel({
  install,
  compact,
}: {
  install: RunnerInstallPackage;
  compact?: boolean;
}) {
  const [tab, setTab] = useState<TabId>("unix");
  const installCurl =
    install.installCurl?.trim() ||
    (install.installShUrl
      ? `curl -fsSL ${JSON.stringify(install.installShUrl)} | sh`
      : "");
  const ps1 = install.installPs1Url
    ? `irm ${JSON.stringify(install.installPs1Url)} | iex`
    : "";

  return (
    <div className="space-y-3">
      {install.needsReinstall ? (
        <p className="text-xs text-destructive">旧协议节点，请按下方脚本重装 Go 代理。</p>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v === "unix" || v === "windows") setTab(v);
        }}
      >
        <TabsList
          variant="line"
          className="scrollbar-subtle scrollbar-x-compact scrollbar-edge-pad -mx-1 w-[calc(100%+0.5rem)] justify-start overflow-x-auto px-1"
        >
          <TabsTrigger value="unix">Linux / macOS</TabsTrigger>
          <TabsTrigger value="windows">Windows</TabsTrigger>
        </TabsList>

        <TabsContent value="unix" className="mt-3 space-y-2">
          <CopyBlock value={installCurl} compact={compact} label="复制" />
        </TabsContent>

        <TabsContent value="windows" className="mt-3 space-y-2">
          <CopyBlock value={ps1} compact={compact} label="复制" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
