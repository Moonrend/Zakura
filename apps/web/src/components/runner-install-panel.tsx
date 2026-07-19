"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Download } from "lucide-react";
import type { RunnerInstallPackage } from "@/lib/runners";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

type TabId = "curl" | "compose" | "docker";

export function RunnerInstallPanel({
  install,
  compact,
}: {
  install: RunnerInstallPackage;
  compact?: boolean;
}) {
  const [tab, setTab] = useState<TabId>("curl");
  const installCurl =
    install.installCurl?.trim() ||
    (install.bootstrapUrl
      ? `curl -fsSL ${JSON.stringify(install.bootstrapUrl)} | sudo bash`
      : "");
  const dockerRun = install.dockerRun?.trim() || "";
  const compose = install.compose?.trim() || "";

  return (
    <div className="space-y-3">
      {install.enableTailscale && install.tsHostname ? (
        <p className="text-xs text-muted-foreground font-mono">{install.tsHostname}</p>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v === "curl" || v === "compose" || v === "docker") setTab(v);
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="curl">一键安装</TabsTrigger>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="docker">Docker run</TabsTrigger>
        </TabsList>

        <TabsContent value="curl" className="mt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            在目标主机执行，将自动拉取并启动对应配置（含 Tailscale 开关状态）。
          </p>
          <CopyBlock value={installCurl} compact={compact} label="复制" />
        </TabsContent>

        <TabsContent value="compose" className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {compose ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadText("docker-compose.yml", compose)}
              >
                <Download className="size-3.5" />
                下载
              </Button>
            ) : null}
          </div>
          <CopyBlock value={compose} compact={compact} label="复制" />
          <CopyBlock
            value={`mkdir -p /var/zakura/${install.slug} && cd /var/zakura/${install.slug} && docker compose up -d`}
            compact
            label="复制启动"
          />
        </TabsContent>

        <TabsContent value="docker" className="mt-3 space-y-2">
          <CopyBlock value={dockerRun} compact={compact} label="复制" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
