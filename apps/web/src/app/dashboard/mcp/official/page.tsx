"use client";

import { SettingsHeader } from "@/components/settings-shell";
import { McpOfficialStorePanel } from "@/components/mcp/official-store-panel";

export default function McpOfficialStorePage() {
  return (
    <div className="space-y-5">
      <SettingsHeader title="官方商店" />
      <McpOfficialStorePanel />
    </div>
  );
}
