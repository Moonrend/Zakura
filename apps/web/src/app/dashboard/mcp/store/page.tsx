"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SettingsHeader } from "@/components/settings-shell";
import { McpOfficialStorePanel } from "@/components/mcp/official-store-panel";
import { McpStorePanel } from "@/components/mcp/store-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

type StoreTab = "official" | "community";

function McpStorePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab: StoreTab =
    searchParams.get("tab") === "community" ? "community" : "official";

  const setTab = useCallback(
    (next: string | number | null) => {
      const value = next === "community" ? "community" : "official";
      router.replace(
        value === "official"
          ? "/dashboard/mcp/store"
          : "/dashboard/mcp/store?tab=community",
      );
    },
    [router],
  );

  return (
    <div className="space-y-5">
      <SettingsHeader title="MCP 商店" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="w-full justify-start sm:max-w-md">
          <TabsTrigger value="official">官方远程 MCP</TabsTrigger>
          <TabsTrigger value="community">社区 Registry</TabsTrigger>
        </TabsList>
        <TabsContent value="official" className="mt-5">
          <McpOfficialStorePanel />
        </TabsContent>
        <TabsContent value="community" className="mt-5">
          <McpStorePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function McpStorePage() {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
      <McpStorePageInner />
    </Suspense>
  );
}
