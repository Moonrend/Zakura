"use client";

import { SettingsHeader } from "@/components/settings-shell";
import { PlatformHeadscalePanel } from "@/components/platform-headscale-panel";
import { PlatformTransactionalEmailPanel } from "@/components/platform-transactional-email-panel";
import { PlatformSkillTokenPanel } from "@/components/skills/platform-skill-token-panel";
import { PlatformConnectorProvisionPanel } from "@/components/connections/platform-connector-provision";

/** SaaS-only — stripped from OSS builds. */
export default function AdminPlatformPage() {
  return (
    <div className="space-y-5">
      <SettingsHeader
        title="平台服务"
        description="平台级基础设施配置"
      />
      <PlatformHeadscalePanel />
      <PlatformTransactionalEmailPanel />
      <PlatformSkillTokenPanel />
      <PlatformConnectorProvisionPanel />
    </div>
  );
}
