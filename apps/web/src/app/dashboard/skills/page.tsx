"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Blocks, Sparkles } from "lucide-react";
import { SettingsHeader } from "@/components/settings-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { listSkills, fetchSkillStores, type SkillRecord, type SkillStoreMeta } from "@/lib/skills";
import { SkillStorePanel } from "@/components/skills/skill-store-panel";
import { SkillRegistryPanel } from "@/components/skills/skill-registry-panel";

export default function SkillsPage() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [stores, setStores] = useState<SkillStoreMeta[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);

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
        const [agentList, storeMeta] = await Promise.all([
          fetchAgents(),
          fetchSkillStores(),
        ]);
        setAgents(agentList);
        setStores(storeMeta.stores);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    void loadSkills();
  }, [loadSkills]);

  const installedCount = skills.length;
  const deployedCount = new Set(skills.flatMap((s) => s.agentIds)).size;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="技能"
        description="技能是写好的操作手册，安装后写入 Agent 工作区 /skills，模型按需读取，也可经 MCP 调用"
      />

      <Tabs defaultValue="store">
        <TabsList variant="line" className="grid w-full max-w-xs grid-cols-2">
          <TabsTrigger value="store">
            <Blocks className="size-4" />
            技能商店
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
        </TabsList>

        <TabsContent value="store" className="mt-4">
          <SkillStorePanel
            agents={agents}
            stores={stores}
            onInstalled={() => void loadSkills()}
          />
        </TabsContent>

        <TabsContent value="installed" className="mt-4 space-y-3">
          {installedCount ? (
            <p className="text-xs text-muted-foreground">
              {installedCount} 个技能，覆盖 {deployedCount} 个 Agent。删除技能会同时从各
              Agent 的工作区移除对应目录。
            </p>
          ) : null}
          <SkillRegistryPanel
            skills={skills}
            agents={agents}
            loading={loading}
            onChanged={() => void loadSkills()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
