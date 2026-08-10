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
        description="组网、事务邮件、技能令牌与连接器的平台级配置。"
      />
      <PlatformHeadscalePanel />
      <PlatformTransactionalEmailPanel />
      <PlatformSkillTokenPanel />
      <PlatformConnectorProvisionPanel />
    </div>
  );
}
