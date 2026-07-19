"use client";

import { SettingsHeader } from "@/components/settings-shell";
import { McpImportPanel } from "@/components/mcp/import-panel";

export default function McpImportPage() {
  return (
    <div className="space-y-5">
      <SettingsHeader title="导入" />
      <McpImportPanel />
    </div>
  );
}
