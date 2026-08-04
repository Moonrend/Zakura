"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Blocks, Settings2, Sparkles } from "lucide-react";
import { SettingsHeader } from "@/components/settings-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { listSkills, fetchSkillStores, type SkillRecord, type SkillStoreMeta } from "@/lib/skills";
import { SkillStorePanel } from "@/components/skills/skill-store-panel";
import { SkillRegistryPanel } from "@/components/skills/skill-registry-panel";
import { SkillSettingsPanel } from "@/components/skills/skill-settings-panel";

export default function SkillsPage() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [stores, setStores] = useState<SkillStoreMeta[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("store");

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await listSkills());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [agentList, storeMeta] = await Promise.all([fetchAgents(), fetchSkillStores()]);
        setAgents(agentList);
        setStores(storeMeta.stores);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    void loadSkills();
  }, [loadSkills]);

  const installedCount = skills.length;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="技能"
        description="浏览商店、管理已安装技能与自动更新；可在设置中添加 Claude / Codex 市场"
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="grid w-full grid-cols-3 sm:max-w-md">
          <TabsTrigger value="store">
            <Blocks className="size-4" />
            商店
          </TabsTrigger>
          <TabsTrigger value="installed">
            <Sparkles className="size-4" />
            已安装
            {installedCount ? (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {installedCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="size-4" />
            设置
          </TabsTrigger>
        </TabsList>

        <TabsContent value="store" className="mt-4">
          <SkillStorePanel agents={agents} stores={stores} onInstalled={() => void loadSkills()} />
        </TabsContent>

        <TabsContent value="installed" className="mt-4">
          <SkillRegistryPanel
            skills={skills}
            agents={agents}
            loading={loading}
            onChanged={() => void loadSkills()}
          />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <SkillSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
