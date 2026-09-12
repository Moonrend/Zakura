"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchField } from "@/components/ui/search-field";
import {
  searchCloudSessions,
  type CloudSearchHit,
  type CloudSession,
} from "@/lib/cloud-agent";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";

export function SessionSearchDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  sessions,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string | null;
  agentName?: string | null;
  sessions: CloudSession[];
  onPick: (hit: CloudSearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CloudSearchHit[] | null>(null);
  const searching = q.trim().length > 0;
  const localHits = useFuzzySearch(sessions, q, {
    keys: ["title"],
    emptyReturnsAll: false,
    limit: 20,
  });

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchCloudSessions(query, agentId ?? undefined, 80)
        .then((r) => setHits(r.results))
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, q, agentId]);

  const merged = useMemo<CloudSearchHit[] | null>(() => {
    if (!searching) return null;
    const local: CloudSearchHit[] = localHits.map((s) => ({
      ...s,
      snippet: null,
      agentName: agentName ?? null,
      agentSlug: null,
    }));
    if (hits === null) return local;
    const seen = new Set(hits.map((h) => h.id));
    return [...hits, ...local.filter((h) => !seen.has(h.id))];
  }, [searching, localHits, hits, agentName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(86vh,40rem)] w-full min-w-0 flex-col gap-3 overflow-hidden shadow-none sm:max-w-xl"
        showCloseButton
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-base">搜索对话</DialogTitle>
        </DialogHeader>
        <SearchField
          className="min-w-0 shrink-0"
          value={q}
          onValueChange={setQ}
          placeholder="匹配标题和消息内容"
          autoFocus
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {!searching ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              输入关键词，匹配当前 Agent 的标题和正文。
            </p>
          ) : merged === null || (merged.length === 0 && hits === null) ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              搜索中…
            </div>
          ) : merged.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">无匹配对话</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-0.5 pb-1">
              {merged.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => {
                    onPick(hit);
                    onOpenChange(false);
                  }}
                  className="flex min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-fluid hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span>
                    {hit.project ? (
                      <span className="max-w-[7rem] shrink-0 truncate text-[11px] text-muted-foreground">
                        {hit.project}
                      </span>
                    ) : null}
                    {hit.agentName && hit.agentId !== agentId ? (
                      <span className="max-w-[6rem] shrink-0 truncate text-[10px] text-muted-foreground">
                        {hit.agentName}
                      </span>
                    ) : null}
                  </span>
                  {hit.snippet ? (
                    <span className="line-clamp-3 break-words whitespace-pre-wrap text-xs text-muted-foreground">
                      {hit.snippet}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
