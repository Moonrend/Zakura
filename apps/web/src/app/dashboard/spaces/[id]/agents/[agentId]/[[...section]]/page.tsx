"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import OverviewPage from "@/app/dashboard/agents/[id]/overview/page";
import SettingsPage from "@/app/dashboard/agents/[id]/settings/page";
import MemoryPage from "@/app/dashboard/agents/[id]/memory/page";
import SkillsPage from "@/app/dashboard/agents/[id]/skills/page";
import SkillsAddPage from "@/app/dashboard/agents/[id]/skills/add/page";
import ApprovalsPage from "@/app/dashboard/agents/[id]/approvals/page";
import WebPage from "@/app/dashboard/agents/[id]/web/page";

const PAGES: Record<string, React.ComponentType> = {
  overview: OverviewPage,
  settings: SettingsPage,
  general: SettingsPage,
  memory: MemoryPage,
  skills: SkillsPage,
  "skills/add": SkillsAddPage,
  approvals: ApprovalsPage,
  web: WebPage,
};

export default function SpaceAgentSectionPage() {
  const params = useParams<{ id: string; agentId: string; section?: string[] }>();
  const key = (params.section ?? ["overview"]).join("/") || "overview";
  const Page = PAGES[key];
  if (!Page) {
    return (
      <div className="space-y-2 p-2">
        <p className="text-sm text-muted-foreground">没有这个页面。</p>
        <Link href={`/dashboard/spaces/${params.id}/agents/${params.agentId}/overview`} className="text-sm underline">
          返回概况
        </Link>
      </div>
    );
  }
  return <Page />;
}
