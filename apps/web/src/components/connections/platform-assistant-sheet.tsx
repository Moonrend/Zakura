"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  createCloudSession,
  eventsToTimeline,
  getCloudSession,
  listCloudSessions,
  sendCloudMessage,
  subscribeCloudEvents,
  type TimelineItem,
} from "@/lib/cloud-agent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const PLATFORM_PROMPT =
  "你是 reCloud 平台配置助手。帮助用户搜索与安装连接、配置凭据、绑定 Agent，以及选择 Runner。回答简洁，操作前先确认关键参数。";

function isPlatformAssistant(agent: AgentListItem): boolean {
  if (agent.slug === "platform") return true;
  const cfg = agent.config ?? {};
  if (cfg.platformAssistant === true) return true;
  const cloud = cfg.cloud;
  if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
    return (cloud as Record<string, unknown>).platformAssistant === true;
  }
  return false;
}

async function ensurePlatformAgent(): Promise<AgentListItem | null> {
  const agents = await fetchAgents();
  const existing = agents.find((a) => a.slug === "platform") ?? agents.find(isPlatformAssistant);
  if (existing) return existing;

  try {
    const created = await api<AgentListItem>("/api/agents", {
      method: "POST",
      json: {
        name: "platform",
        createApiKey: false,
        config: {
          platformAssistant: true,
          cloud: {
            platformAssistant: true,
            systemPrompt: PLATFORM_PROMPT,
          },
        },
      },
    });
    try {
      await api(`/api/agents/${created.id}`, {
        method: "PATCH",
        json: { name: "平台助手" },
      });
      return { ...created, name: "平台助手" };
    } catch {
      return created;
    }
  } catch {
    return null;
  }
}

function timelineText(item: TimelineItem): string | null {
  if (item.kind === "user" || item.kind === "assistant") return item.content;
  if (item.kind === "error") return item.message;
  if (item.kind === "status" && item.detail) return item.detail;
  return null;
}

export function PlatformAssistantSheet() {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<AgentListItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const lastSeq = useRef(0);
  const unsub = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setMissing(false);
    try {
      const found = await ensurePlatformAgent();
      if (!found) {
        setAgent(null);
        setMissing(true);
        return;
      }
      setAgent(found);

      const listed = await listCloudSessions(found.id);
      let sid = listed.sessions[0]?.id ?? null;
      if (!sid) {
        const created = await createCloudSession(found.id, "平台配置");
        sid = created.id;
      }
      setSessionId(sid);

      const snap = await getCloudSession(found.id, sid, 0);
      lastSeq.current = snap.session.lastSeq ?? 0;
      setItems(eventsToTimeline(snap.events));

      unsub.current?.();
      unsub.current = subscribeCloudEvents(found.id, sid, lastSeq.current, {
        onEvent: (ev) => {
          if (typeof ev.seq === "number" && ev.seq > lastSeq.current) {
            lastSeq.current = ev.seq;
          }
          // ponytail: 全量重拉；消息量大时改为增量 apply
          void getCloudSession(found.id, sid!, 0).then((s) => {
            lastSeq.current = s.session.lastSeq ?? lastSeq.current;
            setItems(eventsToTimeline(s.events));
          });
        },
        onError: (message) => toast.error(message),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setMissing(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      unsub.current?.();
      unsub.current = null;
      return;
    }
    void bootstrap();
    return () => {
      unsub.current?.();
      unsub.current = null;
    };
  }, [open, bootstrap]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [items]);

  async function send() {
    if (!agent || !sessionId || !draft.trim() || sending) return;
    const content = draft.trim();
    setDraft("");
    setSending(true);
    setItems((prev) => [
      ...prev,
      { kind: "user", id: `local-${Date.now()}`, content, seq: lastSeq.current + 1 },
    ]);
    try {
      await sendCloudMessage(agent.id, sessionId, content);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="icon"
        className="fixed right-5 bottom-5 z-40 size-10 rounded-full shadow-md"
        aria-label="打开平台助手"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="size-4" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
          <SheetHeader className="border-b border-border">
            <SheetTitle>平台助手</SheetTitle>
            <SheetDescription>安装连接、配凭据、绑 Agent</SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col">
            {loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : missing || !agent ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                请先在系统中创建平台助手 Agent
              </div>
            ) : (
              <>
                <div
                  ref={scroller}
                  className="scrollbar-subtle flex-1 space-y-3 overflow-y-auto px-4 py-3"
                >
                  {items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      例如：帮我安装官方 MCP，或配置某个连接器凭据。
                    </p>
                  ) : (
                    items.map((item) => {
                      const text = timelineText(item);
                      if (!text) return null;
                      const mine = item.kind === "user";
                      return (
                        <div
                          key={item.id}
                          className={cn("flex", mine ? "justify-end" : "justify-start")}
                        >
                          <div
                            className={cn(
                              "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                              mine
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-foreground",
                              item.kind === "error" && "bg-destructive/10 text-destructive",
                            )}
                          >
                            {text}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <form
                  className="flex items-center gap-2 border-t border-border p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="描述你想做的配置…"
                    disabled={sending}
                    className="flex-1"
                  />
                  <Button type="submit" size="icon" disabled={sending || !draft.trim()}>
                    {sending ? <Loader2 className="animate-spin" /> : <Send />}
                  </Button>
                </form>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
