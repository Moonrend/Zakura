"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import type { AgentDetail, AgentListItem } from "@/lib/agents";
import { fetchAgent, fetchAgents } from "@/lib/agents";
import { invalidateApiCache } from "@/lib/api";

type AgentDetailContextValue = {
  id: string;
  agent: AgentDetail | null;
  list: AgentListItem[];
  loading: boolean;
  /** 重新拉取当前 agent；默认同时刷新列表（供切换器） */
  refresh: (opts?: { list?: boolean }) => Promise<AgentDetail | null>;
  /** 本地合并更新，避免整页重拉 */
  patchAgent: (patch: Partial<AgentDetail>) => void;
};

const AgentDetailContext = createContext<AgentDetailContextValue | null>(null);

export function AgentDetailProvider({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [list, setList] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    async (opts?: { list?: boolean }) => {
      const withList = opts?.list !== false;
      setLoading(true);
      try {
        invalidateApiCache(`/api/agents/${id}`);
        if (withList) invalidateApiCache("/api/agents");
        const [detail, rows] = await Promise.all([
          fetchAgent(id),
          withList ? fetchAgents() : Promise.resolve(null),
        ]);
        setAgent(detail);
        if (rows) setList(rows);
        return detail;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    setAgent(null);
    void refresh({ list: true });
  }, [id, refresh]);

  const patchAgent = useCallback((patch: Partial<AgentDetail>) => {
    setAgent((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo(
    () => ({ id, agent, list, loading, refresh, patchAgent }),
    [id, agent, list, loading, refresh, patchAgent],
  );

  return (
    <AgentDetailContext.Provider value={value}>{children}</AgentDetailContext.Provider>
  );
}

export function useAgentDetail(): AgentDetailContextValue {
  const ctx = useContext(AgentDetailContext);
  if (!ctx) throw new Error("useAgentDetail must be used within AgentDetailProvider");
  return ctx;
}
