"use client";

import { SettingsHeader } from "@/components/settings-shell";
import { McpStorePanel } from "@/components/mcp/store-panel";

export default function McpStorePage() {
  return (
    <div className="space-y-5">
      <SettingsHeader title="社区商店" />
      <McpStorePanel />
    </div>
  );
}
