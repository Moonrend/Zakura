"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  ArrowDown,
  Bot,
  Check,
  ChevronsUpDown,
  ExternalLink,
  FileClock,
  FolderOpen,
  LayoutDashboard,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Search,
  Settings2,
  SquarePen,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { CloudAgentEvent, CloudAgentRunOptions } from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SettingsRow, SettingsSaveIndicator } from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, ApiError } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  buildConversationTurns,
  cancelCloudRun,
  compactCloudSession,
  createCloudSession,
  deleteCloudSession,
  getCloudConfig,
  getCloudSession,
  listChatModels,
  listCloudSessions,
  regenerateCloudRun,
  saveCloudConfig,
  searchCloudSessions,
  sendCloudMessage,
  subscribeCloudEvents,
  updateCloudSession,
  SESSION_KIND_LABELS,
  type ChatModelOption,
  type CloudAgentAttachment,
  type CloudAgentSessionKind,
  type CloudSearchHit,
  type CloudSession,
} from "@/lib/cloud-agent";
import { formatSize, fsUploadWithProgress } from "@/lib/agent-fs";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { ChatMessages } from "./chat-messages";
import {
  Composer,
  type ComposerModelItem,
  type ComposerReasoningValue,
  type PendingUpload,
  reasoningItemsFromLevels,
} from "./composer";
import type { ContextWindowInfo } from "./context-window";
import { FilePanel } from "./file-panel";
import { RunLogDrawer } from "./run-log-drawer";

const AGENT_KEY = "zakura_chat_agent";
const DEFAULT_MODEL = "__default__";
const REASONING_KEY = "zakura_chat_reasoning";
const DRAFT_KEY_PREFIX = "zakura_chat_draft";
const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;

/** 侧栏会话类型过滤选项（chat 为默认视图；其余为系统产生的对话记录） */
const KIND_FILTER_OPTIONS: Array<{ value: CloudAgentSessionKind | "all"; label: string }> = [
  { value: "chat", label: SESSION_KIND_LABELS.chat },
  { value: "subagent", label: SESSION_KIND_LABELS.subagent },
  { value: "delegate", label: SESSION_KIND_LABELS.delegate },
  { value: "system", label: SESSION_KIND_LABELS.system },
  { value: "all", label: "全部类型" },
];

function groupSessions(sessions: CloudSession[]): Array<{
  label: string;
  items: CloudSession[];
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = [
    { label: "今天", items: [] as CloudSession[] },
    { label: "昨天", items: [] as CloudSession[] },
    { label: "近 7 天", items: [] as CloudSession[] },
    { label: "更早", items: [] as CloudSession[] },
  ];
  for (const s of sessions) {
    const t = +new Date(s.updatedAt);
    if (t >= startOfDay) groups[0]!.items.push(s);
    else if (t >= startOfDay - 86_400_000) groups[1]!.items.push(s);
    else if (t >= startOfDay - 6 * 86_400_000) groups[2]!.items.push(s);
    else groups[3]!.items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

function eventTextWeight(ev: CloudAgentEvent): number {
  const p = ev.payload as Record<string, unknown>;
  let chars = 40;
  if (typeof p.content === "string") chars += p.content.length;
  if (typeof p.delta === "string") chars += p.delta.length;
  if (typeof p.resultText === "string") chars += Math.min(p.resultText.length, 12_000);
  if (typeof p.arguments === "string") chars += Math.min(p.arguments.length, 4_000);
  if (Array.isArray(p.attachments)) {
    chars += p.attachments.length * 160;
  }
  return chars;
}

function latestCompaction(events: CloudAgentEvent[]) {
  return [...events].reverse().find((ev) => ev.type === "context_compacted") ?? null;
}

function buildContextWindowInfo(
  events: CloudAgentEvent[],
  modelItem: ChatModelOption | undefined,
): ContextWindowInfo {
  const compaction = latestCompaction(events);
  const compactionSeq = compaction?.seq ?? 0;
  const compactionPayload = (compaction?.payload ?? {}) as Record<string, unknown>;
  const summary =
    typeof compactionPayload.summary === "string" ? compactionPayload.summary : "";
  const charsAfterCompaction = events
    .filter((ev) => ev.seq > compactionSeq)
    .reduce((sum, ev) => sum + eventTextWeight(ev), 0);
  const summaryChars = summary ? summary.length + 80 : 0;
  const usedTokens = Math.ceil((charsAfterCompaction + summaryChars) / 4);
  const limitTokens = modelItem?.contextLimit ?? DEFAULT_CONTEXT_LIMIT_TOKENS;
  const beforeChars =
    typeof compactionPayload.beforeChars === "number" ? compactionPayload.beforeChars : 0;
  const afterChars =
    typeof compactionPayload.afterChars === "number" ? compactionPayload.afterChars : 0;
  return {
    usedTokens,
    limitTokens,
    ratio: limitTokens > 0 ? usedTokens / limitTokens : 0,
    messageCount: events.filter(
      (ev) => ev.type === "user_message" || ev.type === "assistant_message",
    ).length,
    toolResultCount: events.filter((ev) => ev.type === "tool_call_result").length,
    summaryCount: events.filter((ev) => ev.type === "context_compacted").length,
    lastSummary: summary || undefined,
    lastCompactedAt: compaction?.createdAt,
    lastSavedTokens:
      beforeChars > afterChars ? Math.ceil((beforeChars - afterChars) / 4) : undefined,
    systemSessionId:
      typeof compactionPayload.systemSessionId === "string"
        ? compactionPayload.systemSessionId
        : undefined,
    source: modelItem?.contextLimit ? "model" : "estimated",
  };
}

export function ChatApp() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** 会话类型过滤：chat=日常对话；subagent/delegate/system=系统产生的对话记录 */
  const [kindFilter, setKindFilter] = useState<CloudAgentSessionKind | "all">("chat");
  const [events, setEvents] = useState<CloudAgentEvent[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [compactingContext, setCompactingContext] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [modelRouteId, setModelRouteId] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<ComposerReasoningValue>(() => {
    if (typeof window === "undefined") return "default";
    const saved = localStorage.getItem(REASONING_KEY);
    if (saved === "none") return "off";
    if (saved === "default" || saved === "off") return saved;
    if (saved?.trim() && saved.length <= 64) return saved as ComposerReasoningValue;
    return "default";
  });
  const [enableTools, setEnableTools] = useState(true);
  const [autoMemory, setAutoMemory] = useState(true);
  const [autoTitle, setAutoTitle] = useState(true);
  const [maxSubagentDepth, setMaxSubagentDepth] = useState("2");
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [hasChatRoute, setHasChatRoute] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<CloudSearchHit[] | null>(null);
  const [variantByMessage, setVariantByMessage] = useState<Record<string, string>>({});
  const [branchByParent, setBranchByParent] = useState<Record<string, string>>({});
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [fileRequest, setFileRequest] = useState<{ path: string; nonce: number } | null>(
    null,
  );
  const [attachments, setAttachments] = useState<CloudAgentAttachment[]>([]);
  /** 待发送图片的本地预览地址（object URL），key 为工作区路径 */
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  /** 正在上传的文件（含进度），用于在输入框里显示占位片 */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  /** 上传中的请求，用于取消 */
  const uploadAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const seqRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileNonceRef = useRef(1);
  /** 每个会话各自的输入草稿；切换会话不丢已敲的字 */
  const draftsRef = useRef<Map<string, string>>(new Map());
  const draftKeyRef = useRef<string>("__new__");
  const latestInputRef = useRef("");
  const agentDefaultsRef = useRef<{ model: string; modelRouteId: string | null }>({
    model: "",
    modelRouteId: null,
  });
  /** 预览 object URL 的真实来源，便于在状态更新之外安全释放 */
  const previewsRef = useRef<Record<string, string>>({});
  /** 跨 Agent 打开搜索结果：切换后应加载的目标会话 */
  const pendingSessionRef = useRef<{ agentId: string; sessionId: string } | null>(null);
  /** 引导页等深链：自动发送的首条消息（只消费一次） */
  const pendingPromptRef = useRef<string | null>(null);
  const autoPromptSentRef = useRef(false);
  const focusComposerAfterPromptRef = useRef(false);
  /** 最新类型过滤值（供稳定回调读取，避免依赖引发的重订阅） */
  const kindFilterRef = useRef<CloudAgentSessionKind | "all">("chat");

  const isMobile = useIsMobile();
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const activeSession = sessions.find((s) => s.id === sessionId) ?? null;
  const runActive = Boolean(activeSession?.activeRunId);
  const turns = useMemo(
    () => buildConversationTurns(events, { variantByMessage, branchByParent }),
    [events, variantByMessage, branchByParent],
  );
  const currentModelItem = useMemo(() => {
    if (!models.length) return undefined;
    if (!model) return models.find((m) => m.isDefault) ?? models[0];
    return models.find((m) => m.alias === model) ?? models.find((m) => m.isDefault) ?? models[0];
  }, [model, models]);
  const contextWindow = useMemo(
    () => buildContextWindowInfo(events, currentModelItem),
    [events, currentModelItem],
  );
  const itemCount = useMemo(() => turns.reduce((n, t) => n + t.items.length, 0), [turns]);
  const grouped = useMemo(() => groupSessions(sessions), [sessions]);
  const searching = searchQ.trim().length > 0;
  /**
   * 本地模糊命中：已经拉到的会话直接在前端 Fuse 一遍。
   * 服务端搜索有 250ms 防抖 + 往返，本地这层让「刚敲完就有结果」，
   * 也能容忍标题里的错字（服务端的 ILIKE 做不到）。
   */
  const localSessionHits = useFuzzySearch(sessions, searchQ, {
    keys: ["title"],
    emptyReturnsAll: false,
    limit: 8,
  });
  /** 服务端结果为准，本地独有的标题命中补在后面 */
  const mergedHits = useMemo<CloudSearchHit[] | null>(() => {
    if (!searching) return null;
    const local: CloudSearchHit[] = localSessionHits.map((s) => ({
      ...s,
      snippet: null,
      agentName: agent?.name ?? null,
      agentSlug: agent?.slug ?? null,
    }));
    if (searchHits === null) return local;
    const seen = new Set(searchHits.map((h) => h.id));
    return [...searchHits, ...local.filter((h) => !seen.has(h.id))];
  }, [searching, localSessionHits, searchHits, agent?.name, agent?.slug]);
  /** 尚未开始的对话：输入框上浮到视觉中线，首条消息发出后再流动回底部 */
  const emptyConversation = turns.length === 0;
  const {
    scrollRef,
    contentRef,
    atBottom,
    scrollToBottom,
    sync: syncScroll,
  } = useStickToBottom<HTMLDivElement, HTMLDivElement>();

  // 初始按视口决定：桌面展开，移动端收起（覆盖式抽屉，避免首帧闪现）
  useEffect(() => {
    setSidebarOpen(window.matchMedia("(min-width: 768px)").matches);
  }, []);
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  /** 移动端在做出选择后自动收起抽屉 */
  const closeNavOnMobile = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const runOptions = useMemo<CloudAgentRunOptions | undefined>(() => {
    if (reasoning === "default") return undefined;
    if (reasoning === "off") return { reasoning: { enabled: false } };
    return { reasoning: { enabled: true, effort: reasoning } };
  }, [reasoning]);

  // —— 鉴权 + Agent 列表 ——
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api("/api/me");
        const list = await fetchAgents();
        if (cancelled) return;
        setAgents(list);
        setAuthed(true);
        // ?agent=<id|slug> 优先（控制台跳转），其次上次使用的 Agent
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get("agent");
        const saved = localStorage.getItem(AGENT_KEY);
        const initial =
          list.find((a) => a.id === fromUrl || a.slug === fromUrl) ??
          list.find((a) => a.id === saved) ??
          list[0] ??
          null;
        // ?session=<id> 深链（如从工具调用跳转到子代理会话）
        const fromUrlSession = params.get("session");
        if (initial && fromUrlSession) {
          pendingSessionRef.current = { agentId: initial.id, sessionId: fromUrlSession };
        }
        // ?prompt= 引导试用：新开对话并自动发送
        const fromPrompt = params.get("prompt");
        if (fromPrompt?.trim()) {
          pendingPromptRef.current = fromPrompt.trim();
          autoPromptSentRef.current = false;
        }
        setAgentId(initial?.id ?? null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const refreshSessions = useCallback(async () => {
    if (!agentId) return [];
    const kinds = kindFilterRef.current === "all" ? ("all" as const) : [kindFilterRef.current];
    const res = await listCloudSessions(agentId, { kinds });
    setSessions(res.sessions);
    return res.sessions;
  }, [agentId]);

  const mergeEvent = useCallback(
    (ev: CloudAgentEvent) => {
      setEvents((prev) => {
        if (prev.some((e) => e.id === ev.id || e.seq === ev.seq)) return prev;
        return [...prev, ev].sort((a, b) => a.seq - b.seq);
      });
      if (ev.seq > seqRef.current) seqRef.current = ev.seq;
      if (
        ev.type === "run_start" ||
        ev.type === "run_end" ||
        ev.type === "run_error" ||
        ev.type === "user_message" ||
        ev.type === "session_update"
      ) {
        void refreshSessions();
      }
    },
    [refreshSessions],
  );

  const loadSession = useCallback(
    async (aid: string, sid: string) => {
      const res = await getCloudSession(aid, sid, 0);
      setSessionId(sid);
      setEvents(res.events);
      const sessionHasModel = Boolean(res.session.model);
      setModel(sessionHasModel ? res.session.model! : agentDefaultsRef.current.model);
      setModelRouteId(
        sessionHasModel ? res.session.modelRouteId : agentDefaultsRef.current.modelRouteId,
      );
      if (res.session.reasoning) {
        setReasoning(res.session.reasoning as ComposerReasoningValue);
      } else {
        const legacy = localStorage.getItem(REASONING_KEY);
        setReasoning(
          legacy === "none"
            ? "off"
            : legacy === "default" || legacy === "off" || (legacy && legacy.length <= 64)
              ? (legacy as ComposerReasoningValue)
              : "default",
        );
      }
      draftsRef.current.set(sid, res.session.draftText ?? "");
      setVariantByMessage({});
      setBranchByParent({});
      const maxSeq = res.events.reduce((m, e) => Math.max(m, e.seq), 0);
      seqRef.current = maxSeq;
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== sid);
        return [res.session, ...others].sort(
          (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
        );
      });
    },
    [],
  );

  // —— 切换 Agent：加载会话/配置/模型 ——
  useEffect(() => {
    if (!agentId || !authed) return;
    setAgentReady(false);
    localStorage.setItem(AGENT_KEY, agentId);
    for (const url of Object.values(previewsRef.current)) URL.revokeObjectURL(url);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
    setFileRequest(null);
    let cancelled = false;
    (async () => {
      try {
        const [list, cfg, chatModels] = await Promise.all([
          listCloudSessions(agentId, {
            kinds:
              kindFilterRef.current === "all" ? ("all" as const) : [kindFilterRef.current],
          }).then((r) => r.sessions),
          getCloudConfig(agentId),
          listChatModels(),
        ]);
        if (cancelled) return;
        setSessions(list);
        setHasChatRoute(cfg.hasChatRoute);
        setSystemPrompt(cfg.cloud.systemPrompt ?? "");
        setModel(cfg.cloud.model ?? "");
        setModelRouteId(cfg.cloud.modelRouteId ?? null);
        agentDefaultsRef.current = {
          model: cfg.cloud.model ?? "",
          modelRouteId: cfg.cloud.modelRouteId ?? null,
        };
        setEnableTools(cfg.cloud.enableTools !== false);
        setAutoMemory(cfg.cloud.autoMemory !== false);
        setAutoTitle(cfg.cloud.autoTitle !== false);
        setMaxSubagentDepth(String(cfg.cloud.maxSubagentDepth ?? 2));
        setModels(chatModels);
        const pending = pendingSessionRef.current;
        pendingSessionRef.current = null;
        // 有待发送 prompt 时开新会话草稿，避免挂在旧对话上
        if (pendingPromptRef.current) {
          setSessionId(null);
          setEvents([]);
          seqRef.current = 0;
          setSessions(list);
        } else if (pending && pending.agentId === agentId) {
          await loadSession(agentId, pending.sessionId);
        } else if (list.length > 0) {
          await loadSession(agentId, list[0]!.id);
        } else {
          setSessionId(null);
          setEvents([]);
          seqRef.current = 0;
        }
        if (!cancelled) setAgentReady(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, authed, loadSession]);

  // 引导深链：Agent 就绪后自动发送首条消息
  useEffect(() => {
    if (!agentId || !authed || !agentReady || autoPromptSentRef.current) return;
    const prompt = pendingPromptRef.current;
    if (!prompt) return;
    autoPromptSentRef.current = true;
    pendingPromptRef.current = null;
    setInput(prompt);
    void (async () => {
      setSending(true);
      try {
        const created = await createCloudSession(agentId);
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setSessionId(created.id);
        seqRef.current = 0;
        setEvents([]);
        await sendCloudMessage(agentId, created.id, prompt, null);
        await refreshSessions();
        await loadSession(agentId, created.id);
        focusComposerAfterPromptRef.current = true;
        // 清掉 URL 上的 prompt，避免刷新重复发送
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("prompt");
          window.history.replaceState({}, "", url.pathname + url.search);
        } catch {
          /* ignore */
        }
      } catch (err) {
        autoPromptSentRef.current = false;
        pendingPromptRef.current = prompt;
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
        setInput("");
      }
    })();
  }, [agentId, agentReady, authed, loadSession, refreshSessions]);

  useEffect(() => {
    if (sending || !focusComposerAfterPromptRef.current) return;
    focusComposerAfterPromptRef.current = false;
    requestAnimationFrame(() => {
      scrollToBottom("smooth");
      composerRef.current?.focus({ preventScroll: true });
    });
  }, [sending, sessionId, scrollToBottom]);

  // —— 类型过滤变化：重载列表并校正选中会话 ——
  useEffect(() => {
    const prev = kindFilterRef.current;
    kindFilterRef.current = kindFilter;
    if (prev === kindFilter || !agentId || !authed) return;
    void (async () => {
      try {
        const list = await refreshSessions();
        // 草稿态（新对话未落库）：只刷新列表，不自动选中
        if (!sessionId) return;
        if (list.some((s) => s.id === sessionId)) return;
        if (list[0]) await loadSession(agentId, list[0].id);
        else {
          setSessionId(null);
          setEvents([]);
          seqRef.current = 0;
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅响应过滤变化
  }, [kindFilter]);

  // —— SSE 订阅 ——
  useEffect(() => {
    if (!sessionId || !agentId) return;
    let unsub = subscribeCloudEvents(agentId, sessionId, seqRef.current, {
      onEvent: mergeEvent,
      onError: (msg) => console.warn("[chat sse]", msg),
    });
    const resub = () => {
      unsub();
      unsub = subscribeCloudEvents(agentId, sessionId, seqRef.current, {
        onEvent: mergeEvent,
      });
    };
    const onVis = () => {
      if (document.visibilityState === "visible") resub();
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = setInterval(resub, 60_000);
    return () => {
      unsub();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [agentId, sessionId, mergeEvent]);

  // 新内容到达时跟随到底部（用户已向上翻阅时不打扰）
  useEffect(() => {
    syncScroll("smooth");
  }, [itemCount, runActive, syncScroll]);

  // 切换会话：直接落到底部，不做动画
  useEffect(() => {
    if (!sessionId) return;
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [sessionId, scrollToBottom]);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  // 草稿即时落本地，随后同步到服务端，保证刷新和多设备打开都能恢复。
  useEffect(() => {
    if (!agentId) return;
    const expectedKey = sessionId ?? "__new__";
    // 会话刚切换但恢复 effect 尚未执行时，不能把旧会话的输入写到新 key。
    if (draftKeyRef.current !== expectedKey) return;
    const key = `${DRAFT_KEY_PREFIX}:${agentId}:${draftKeyRef.current}`;
    try {
      if (input) localStorage.setItem(key, input);
      else localStorage.removeItem(key);
    } catch {
      // 存储空间不足时，服务端同步仍然继续。
    }
    // sessionId 变化时，恢复 effect 还需要先切换 draftKey，避免把旧输入短暂写进新会话。
    if (!sessionId) return;
    const timer = window.setTimeout(() => {
      void updateCloudSession(agentId, sessionId, { draftText: input }).catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [agentId, input, sessionId]);

  // 切换会话时把当前草稿存起来，并恢复目标会话的草稿
  useEffect(() => {
    const nextKey = sessionId ?? "__new__";
    if (draftKeyRef.current === nextKey) return;
    const pending = latestInputRef.current;
    if (pending.trim()) draftsRef.current.set(draftKeyRef.current, pending);
    else draftsRef.current.delete(draftKeyRef.current);
    draftKeyRef.current = nextKey;
    let restored = draftsRef.current.get(nextKey) ?? "";
    if (!restored && agentId) {
      try {
        restored = localStorage.getItem(`${DRAFT_KEY_PREFIX}:${agentId}:${nextKey}`) ?? "";
      } catch {
        // Ignore unavailable local storage.
      }
    }
    latestInputRef.current = restored;
    setInput(restored);
  }, [agentId, sessionId]);

  // 卸载时释放尚未发送的图片预览地址
  useEffect(() => {
    const previews = previewsRef;
    return () => {
      for (const url of Object.values(previews.current)) URL.revokeObjectURL(url);
      previews.current = {};
    };
  }, []);

  // —— 搜索（防抖） ——
  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchCloudSessions(q)
        .then((r) => setSearchHits(r.results))
        .catch(() => setSearchHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQ]);

  async function openSearchHit(hit: CloudSearchHit) {    setSearchQ("");
    setSearchHits(null);
    if (hit.agentId !== agentId) {
      pendingSessionRef.current = { agentId: hit.agentId, sessionId: hit.id };
      setAgentId(hit.agentId);
    } else {
      await loadSession(hit.agentId, hit.id);
    }
  }

  /** 进入「新对话」草稿态：不落库，发消息时再创建会话 */
  function handleNewSession() {
    if (!agentId) return;
    setSessionId(null);
    setEvents([]);
    setVariantByMessage({});
    setBranchByParent({});
    seqRef.current = 0;
    clearAttachments();
    composerRef.current?.focus();
  }

  async function handleDeleteSession(sid: string) {
    if (!agentId) return;
    if (!confirm("删除该对话？")) return;
    try {
      await deleteCloudSession(agentId, sid);
      const next = sessions.filter((s) => s.id !== sid);
      setSessions(next);
      if (sessionId === sid) {
        if (next[0]) await loadSession(agentId, next[0].id);
        else {
          setSessionId(null);
          setEvents([]);
          seqRef.current = 0;
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleArchiveSession(sid: string) {
    if (!agentId) return;
    try {
      await updateCloudSession(agentId, sid, { status: "archived" });
      const next = sessions.filter((s) => s.id !== sid);
      setSessions(next);
      if (sessionId === sid) {
        if (next[0]) await loadSession(agentId, next[0].id);
        else {
          setSessionId(null);
          setEvents([]);
          seqRef.current = 0;
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function commitRename() {
    const sid = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!sid || !title || !agentId) return;
    try {
      const updated = await updateCloudSession(agentId, sid, { title });
      setSessions((prev) => prev.map((s) => (s.id === sid ? updated : s)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function parentForSend(): string | null | undefined {
    const last = turns[turns.length - 1];
    if (!last) return null;
    return last.activeRunId ?? undefined;
  }

  /** 稳定引用：工具行会以它作为 memo 依赖，重建会让缓存全部失效 */
  const openFileInPanel = useCallback((path: string) => {
    setFilePanelOpen(true);
    fileNonceRef.current += 1;
    setFileRequest({ path, nonce: fileNonceRef.current });
  }, []);

  /** 图片附件的本地预览：object URL 由 previewsRef 统一持有并释放 */
  function dropPreview(path: string) {
    const url = previewsRef.current[path];
    if (!url) return;
    URL.revokeObjectURL(url);
    const next = { ...previewsRef.current };
    delete next[path];
    previewsRef.current = next;
    setAttachmentPreviews(next);
  }

  function clearAttachments() {
    for (const url of Object.values(previewsRef.current)) URL.revokeObjectURL(url);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
  }

  function removeAttachment(path: string) {
    dropPreview(path);
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }

  /** 单个附件上限；服务端 multipart 也按这个量级设限 */
  const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
  /** 一条消息最多挂多少个附件 */
  const MAX_ATTACHMENTS = 10;

  /**
   * 附件先上传到工作区 /uploads，发送时把元数据挂在消息上。
   * 每个文件独立并发上传：一个失败不影响其余文件，也不必排队等前一个传完。
   */
  async function handleAttachFiles(files: File[]) {
    if (files.length === 0 || !agentId) return;
    if (!agent?.enableComputer) {
      toast.error("该 Agent 未开启电脑环境，无法上传文件");
      return;
    }

    const accepted: File[] = [];
    for (const f of files) {
      if (f.size === 0) {
        toast.error(`${f.name}：空文件，已跳过`);
        continue;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        toast.error(`${f.name}：超过 ${formatSize(MAX_UPLOAD_BYTES)} 上限`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length === 0) return;

    const room = MAX_ATTACHMENTS - attachments.length - uploads.length;
    if (room <= 0) {
      toast.error(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    if (accepted.length > room) {
      toast.error(`一条消息最多 ${MAX_ATTACHMENTS} 个附件，已保留前 ${room} 个`);
      accepted.length = room;
    }

    await Promise.all(accepted.map((f) => uploadOne(agentId, f)));
  }

  async function uploadOne(targetAgentId: string, file: File) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    uploadAbortsRef.current.set(id, controller);
    setUploads((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0 }]);

    try {
      const safeName = file.name.replace(/[\\/:*?"<>|]+/g, "_");
      const res = await fsUploadWithProgress(
        targetAgentId,
        `/uploads/${id}-${safeName}`,
        file,
        {
          signal: controller.signal,
          onProgress: (ratio) =>
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, progress: ratio } : u)),
            ),
        },
      );
      const isImage = file.type.startsWith("image/");
      setAttachments((prev) => [
        ...prev,
        {
          name: file.name,
          path: res.path,
          mime: file.type || "application/octet-stream",
          size: file.size,
          kind: isImage ? "image" : "file",
        },
      ]);
      if (isImage) {
        const next = { ...previewsRef.current, [res.path]: URL.createObjectURL(file) };
        previewsRef.current = next;
        setAttachmentPreviews(next);
      }
    } catch (err) {
      // 用户主动取消不是错误，不弹提示
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast.error(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      uploadAbortsRef.current.delete(id);
      setUploads((prev) => prev.filter((u) => u.id !== id));
    }
  }

  const cancelUpload = useCallback((id: string) => {
    uploadAbortsRef.current.get(id)?.abort();
  }, []);

  // 离开页面时中止在途上传，避免请求悬着
  useEffect(() => {
    const aborts = uploadAbortsRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    };
  }, []);

  async function handleSend() {
    if (!agentId || sending || runActive) return;
    const content = input.trim();
    if (!content && attachments.length === 0) return;
    const sentAttachments = attachments;
    const sentPreviews = previewsRef.current;
    setInput("");
    latestInputRef.current = "";
    draftsRef.current.delete(draftKeyRef.current);
    // 预览地址随消息一起「离开」输入框，交给消息流的附件卡片自己渲染
    for (const url of Object.values(sentPreviews)) URL.revokeObjectURL(url);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
    setSending(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const created = await createCloudSession(agentId);
        setSessions((prev) => [created, ...prev]);
        await updateCloudSession(agentId, created.id, {
          model: model || null,
          modelRouteId,
          reasoning,
          draftText: "",
        });
        // 会话 key 提前对齐，避免草稿同步 effect 把已发送内容存回「新对话」
        draftKeyRef.current = created.id;
        setSessionId(created.id);
        seqRef.current = 0;
        setEvents([]);
        sid = created.id;
      }
      await sendCloudMessage(
        agentId,
        sid,
        content,
        parentForSend(),
        sentAttachments,
        runOptions,
      );
      await refreshSessions();
      scrollToBottom("smooth");
    } catch (err) {
      setInput(content);
      latestInputRef.current = content;
      setAttachments(sentAttachments);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function handleRegenerate(messageId: string) {
    if (!agentId || !sessionId || runActive) return;
    try {
      await regenerateCloudRun(agentId, sessionId, messageId, runOptions);
      setVariantByMessage((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      await refreshSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEditSend(parentKey: string, content: string) {
    if (!agentId || !sessionId || runActive || !content.trim()) return;
    try {
      await sendCloudMessage(
        agentId,
        sessionId,
        content.trim(),
        parentKey === "" ? null : parentKey,
        undefined,
        runOptions,
      );
      setBranchByParent((prev) => {
        const next = { ...prev };
        delete next[parentKey];
        return next;
      });
      await refreshSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCancel() {
    if (!agentId || !sessionId) return;
    try {
      await cancelCloudRun(agentId, sessionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCompactContext() {
    if (!agentId || !sessionId || runActive || compactingContext) return;
    setCompactingContext(true);
    try {
      const result = await compactCloudSession(agentId, sessionId);
      await loadSession(agentId, sessionId);
      const saved = Math.max(0, result.beforeChars - result.afterChars);
      toast.success(
        saved > 0
          ? `已压缩上下文，约释放 ${Math.round(saved / 4).toLocaleString("zh-CN")} tokens`
          : "已压缩上下文",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCompactingContext(false);
    }
  }

  async function handleModelSelection(value: string | null, routeId: string | null) {
    if (!agentId) return;
    const next = !value || value === DEFAULT_MODEL ? "" : value;
    setModel(next);
    setModelRouteId(routeId);
    try {
      if (sessionId) {
        await updateCloudSession(agentId, sessionId, {
          model: next || null,
          modelRouteId: routeId || null,
        });
      } else {
        await saveCloudConfig(agentId, {
          model: next || null,
          modelRouteId: routeId || null,
        });
        agentDefaultsRef.current = { model: next, modelRouteId: routeId };
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function handleReasoningChange(value: ComposerReasoningValue) {
    setReasoning(value);
    if (sessionId && agentId) {
      void updateCloudSession(agentId, sessionId, { reasoning: value }).catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
    } else {
      localStorage.setItem(REASONING_KEY, value);
    }
  }

  type ChatSettingsPatch = {
    systemPrompt?: string;
    enableTools?: boolean;
    autoMemory?: boolean;
    autoTitle?: boolean;
    maxSubagentDepth?: string;
  };

  const persistChatSettings = useCallback(
    async (patch: ChatSettingsPatch) => {
      if (!agentId) return;
      const body: Parameters<typeof saveCloudConfig>[1] = {};
      if (patch.systemPrompt !== undefined) body.systemPrompt = patch.systemPrompt;
      if (patch.enableTools !== undefined) body.enableTools = patch.enableTools;
      if (patch.autoMemory !== undefined) body.autoMemory = patch.autoMemory;
      if (patch.autoTitle !== undefined) body.autoTitle = patch.autoTitle;
      if (patch.maxSubagentDepth !== undefined) {
        const n = Number(patch.maxSubagentDepth);
        body.maxSubagentDepth =
          Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 5) : null;
      }
      await saveCloudConfig(agentId, body);
    },
    [agentId],
  );

  const {
    status: settingsSaveStatus,
    error: settingsSaveError,
    schedule: scheduleSettings,
    saveNow: saveSettingsNow,
  } = useAutoSave(persistChatSettings, { debounceMs: 550 });

  const modelItems = useMemo<ComposerModelItem[]>(() => {
    const defaultModel = models.find((m) => m.isDefault) ?? null;
    const items: ComposerModelItem[] = [
      {
        value: DEFAULT_MODEL,
        label: "默认模型",
        keywords: ["default", "默认"],
        reasoning: defaultModel?.reasoning,
        reasoningLevels: defaultModel?.reasoningLevels,
        defaultReasonLevel: defaultModel?.defaultReasonLevel,
      },
      ...models.map((m) => ({
        value: m.alias,
        label: m.name,
        hint: m.upstream,
        keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
        reasoning: m.reasoning,
        reasoningLevels: m.reasoningLevels,
        defaultReasonLevel: m.defaultReasonLevel,
        providers: m.providers,
      })),
    ];
    // 配置里存着的模型可能已从模型列表里下线，仍要能显示当前选中项
    if (model && !models.some((m) => m.alias === model)) {
      items.push({ value: model, label: model });
    }
    return items;
  }, [models, model]);

  const selectedModelItem = useMemo(
    () => modelItems.find((item) => item.value === (model || DEFAULT_MODEL)) ?? null,
    [modelItems, model],
  );
  const reasoningItems = useMemo(
    () => reasoningItemsFromLevels(selectedModelItem?.reasoningLevels),
    [selectedModelItem?.reasoningLevels],
  );

  useEffect(() => {
    if (!reasoningItems.some((item) => item.value === reasoning)) {
      setReasoning("default");
      if (sessionId && agentId) {
        void updateCloudSession(agentId, sessionId, { reasoning: "default" });
      } else {
        localStorage.setItem(REASONING_KEY, "default");
      }
    }
  }, [agentId, reasoning, reasoningItems, sessionId]);

  if (!authed) {
    return (
      <div className="flex h-svh items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-svh bg-background">
      {/* ===== 侧边栏（桌面内联收展；移动端覆盖式抽屉） ===== */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          aria-hidden
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col border-r border-border/60 bg-muted/20",
          "md:transition-[width] md:duration-200",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[290px] max-md:bg-background max-md:shadow-xl max-md:transition-transform max-md:duration-200",
          sidebarOpen
            ? "w-[264px] max-md:translate-x-0"
            : "w-0 overflow-hidden border-r-0 max-md:-translate-x-full",
        )}
      >
        {/* Agent 切换 */}
        <div className="p-2 pb-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
                />
              }
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {agent?.name?.slice(0, 1) ?? <Bot className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {agent?.name ?? "选择 Agent"}
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {agents.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onClick={() => {
                    setAgentId(a.id);
                    closeNavOnMobile();
                  }}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {a.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.id === agentId && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 新对话 + 搜索 */}
        <div className="flex flex-col gap-1 p-2">
          <button
            type="button"
            onClick={() => {
              handleNewSession();
              closeNavOnMobile();
            }}
            className={cn(
              "group/new flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ease-fluid",
              sessionId === null
                ? "bg-muted text-foreground"
                : "text-foreground hover:bg-muted/60",
            )}
          >
            <SquarePen className="h-4 w-4 transition-transform duration-300 ease-overshoot group-hover/new:-rotate-12" />
            新对话
          </button>
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
              <Input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="搜索对话"
                className="h-8 border-0 bg-transparent pl-7 shadow-none focus-visible:bg-muted/60 focus-visible:ring-0"
              />
              {searching && (
                <button
                  type="button"
                  aria-label="清除"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
                  onClick={() => setSearchQ("")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* 会话类型过滤：查看子代理/委派/系统产生的对话记录 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="会话类型筛选"
                    title={
                      kindFilter === "all"
                        ? "全部类型"
                        : SESSION_KIND_LABELS[kindFilter]
                    }
                    className={cn(
                      "shrink-0 rounded-lg p-1.5 hover:bg-muted/60",
                      kindFilter !== "chat"
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  />
                }
              >
                <ListFilter className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-32">
                {KIND_FILTER_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => setKindFilter(opt.value)}
                  >
                    <span className="min-w-0 flex-1">{opt.label}</span>
                    {kindFilter === opt.value && <Check className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 会话列表 / 搜索结果 */}
        <ScrollArea className="min-h-0 flex-1">
          {searching ? (
            <div className="flex flex-col gap-0.5 p-2 pt-0">
              {mergedHits === null || (mergedHits.length === 0 && searchHits === null) ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">搜索中…</div>
              ) : mergedHits.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">无结果</div>
              ) : (
                mergedHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => {
                      void openSearchHit(hit);
                      closeNavOnMobile();
                    }}
                    className="animate-rise flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ease-fluid hover:bg-muted/60"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
                      {hit.agentName && hit.agentId !== agentId && (
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {hit.agentName}
                        </span>
                      )}
                    </span>
                    {hit.snippet && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {hit.snippet}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-2 pt-0">
              {grouped.map((g) => (
                <div key={g.label}>
                  <div className="px-2 pb-0.5 pt-1 text-[11px] text-muted-foreground/60">
                    {g.label}
                  </div>
                  <div className="flex flex-col">
                    {g.items.map((s) => (
                      <div
                        key={s.id}
                        className={cn(
                          "group animate-rise relative flex items-center rounded-lg text-sm",
                          "transition-colors duration-150 ease-fluid",
                          s.id === sessionId
                            ? "bg-muted text-foreground"
                            : "text-foreground/80 hover:bg-muted/60",
                        )}
                      >
                        {s.id === sessionId && (
                          <span
                            aria-hidden
                            className="animate-pop absolute top-1/2 left-0 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-foreground/60"
                          />
                        )}
                        {renamingId === s.id ? (
                          <Input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitRename();
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            className="mx-1 my-0.5 h-6 px-1 text-sm"
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1.5 text-left"
                              onClick={() => {
                                if (agentId) void loadSession(agentId, s.id);
                                closeNavOnMobile();
                              }}
                            >
                              <span className="truncate">{s.title}</span>
                              {s.kind && s.kind !== "chat" ? (
                                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                  {SESSION_KIND_LABELS[s.kind] ?? s.kind}
                                </span>
                              ) : null}
                              {s.activeRunId ? (
                                <span
                                  aria-label="运行中"
                                  className="running-halo relative h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/70 text-foreground/70"
                                />
                              ) : null}
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label="会话操作"
                                    className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted max-md:opacity-60 md:opacity-0 md:group-hover:opacity-100 md:data-[popup-open]:opacity-100"
                                  />
                                }
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="min-w-28">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenamingId(s.id);
                                    setRenameValue(s.title);
                                  }}
                                >
                                  <Pencil />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => void handleArchiveSession(s.id)}
                                >
                                  <Archive />
                                  归档
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => void handleDeleteSession(s.id)}
                                >
                                  <Trash2 />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 底部 */}
        <div className="border-t border-border/50 p-2">
          <button
            type="button"
            onClick={() => router.push("/dashboard/agents")}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <LayoutDashboard className="h-4 w-4" />
            控制台
          </button>
        </div>
      </aside>

      {/* ===== 主区 ===== */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="侧边栏"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm font-medium text-foreground/80">
            {agent?.name}
          </span>
          <div className="flex-1" />
          {runActive && (
            <Button size="sm" variant="ghost" onClick={() => void handleCancel()}>
              <Square className="h-3.5 w-3.5" />
              停止
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="文件"
            className={cn(filePanelOpen && "bg-muted text-foreground")}
            onClick={() => setFilePanelOpen((v) => !v)}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="运行日志"
            onClick={() => setLogOpen(true)}
          >
            <FileClock className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </header>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div ref={contentRef} className="flex min-h-full flex-col">
            <ChatMessages
              turns={turns}
              runActive={runActive}
              activeRunId={activeSession?.activeRunId}
              agentName={agent?.name}
              canAct={hasChatRoute && !runActive && !sending}
              onRegenerate={(mid) => void handleRegenerate(mid)}
              onEditSend={(parentKey, content) => void handleEditSend(parentKey, content)}
              onSelectVariant={(mid, runId) =>
                setVariantByMessage((prev) => ({ ...prev, [mid]: runId }))
              }
              onSelectBranch={(parentKey, mid) =>
                setBranchByParent((prev) => ({ ...prev, [parentKey]: mid }))
              }
              onOpenFile={openFileInPanel}
            />
          </div>
        </div>

        {/* 组合器 */}
        <div className="relative shrink-0 px-2.5 pt-1 pb-[max(env(safe-area-inset-bottom),0.625rem)] md:px-4 md:pb-4">
          {!atBottom && !emptyConversation && (
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              className="animate-pop absolute top-0 left-1/2 z-10 flex -translate-x-1/2 -translate-y-[calc(100%+0.375rem)] items-center gap-1 rounded-full border border-border/70 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--shadow-soft)] backdrop-blur transition-colors duration-150 hover:text-foreground"
            >
              <ArrowDown className="size-3.5" />
              回到底部
            </button>
          )}
          <Composer
            value={input}
            onValueChange={setInput}
            onSend={() => void handleSend()}
            onStop={() => void handleCancel()}
            textareaRef={composerRef}
            routeReady={hasChatRoute}
            sending={sending}
            runActive={runActive}
            attachments={attachments}
            attachmentPreviews={attachmentPreviews}
            uploads={uploads}
            canAttach={Boolean(agent?.enableComputer)}
            attachHint={
              agent?.enableComputer
                ? "上传文件到工作区（也可直接拖入或粘贴）"
                : "需要开启电脑环境才能上传文件"
            }
            onAttachFiles={(files) => void handleAttachFiles(files)}
            onRemoveAttachment={removeAttachment}
            onCancelUpload={cancelUpload}
            models={modelItems}
            model={model || DEFAULT_MODEL}
            modelRouteId={modelRouteId}
            onModelSelection={(v, routeId) => void handleModelSelection(v, routeId)}
            reasoning={reasoning}
            reasoningItems={reasoningItems}
            onReasoningChange={handleReasoningChange}
            contextWindow={contextWindow}
            contextWindowOpen={contextOpen}
            compactingContext={compactingContext}
            onContextWindowOpenChange={setContextOpen}
            onCompactContext={() => void handleCompactContext()}
          />
        </div>

        {/* 空会话时输入框浮到视觉中线；首条消息发出后 flex-grow 归零，输入框顺势落回底部 */}
        <div
          aria-hidden
          className={cn(
            "shrink-0 transition-[flex-grow] duration-[520ms] ease-fluid",
            emptyConversation ? "grow-[0.82]" : "grow-0",
          )}
        />
      </div>

      {/* ===== 文件面板（移动端全屏覆盖） ===== */}
      {filePanelOpen && agentId && (
        <FilePanel
          agentId={agentId}
          fsEnabled={Boolean(agent?.enableComputer)}
          openRequest={fileRequest}
          overlay={isMobile}
          onClose={() => setFilePanelOpen(false)}
        />
      )}

      <RunLogDrawer open={logOpen} onOpenChange={setLogOpen} events={events} />

      {/* 设置（自动保存；完整分类见 Agent 设置页） */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <div className="flex items-start justify-between gap-2 pr-6">
              <SheetTitle>{agent?.name ?? "Agent"} 设置</SheetTitle>
              <SettingsSaveIndicator
                status={settingsSaveStatus}
                error={settingsSaveError}
              />
            </div>
            <SheetDescription className="sr-only">Agent 设置</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="mt-4 space-y-1 px-1 pb-6">
              <div className="space-y-2 pb-3">
                <Label htmlFor="chat-system">系统提示词</Label>
                <Textarea
                  id="chat-system"
                  value={systemPrompt}
                  onChange={(e) => {
                    setSystemPrompt(e.target.value);
                    scheduleSettings({ systemPrompt: e.target.value });
                  }}
                  className="min-h-28"
                />
              </div>
              <Separator />
              <SettingsRow label="工具调用">
                <Switch
                  checked={enableTools}
                  onCheckedChange={(v) => {
                    setEnableTools(v);
                    saveSettingsNow({ enableTools: v });
                  }}
                />
              </SettingsRow>
              <Separator />
              <SettingsRow label="自动记忆">
                <Switch
                  checked={autoMemory}
                  onCheckedChange={(v) => {
                    setAutoMemory(v);
                    saveSettingsNow({ autoMemory: v });
                  }}
                />
              </SettingsRow>
              <Separator />
              <SettingsRow label="自动标题">
                <Switch
                  checked={autoTitle}
                  onCheckedChange={(v) => {
                    setAutoTitle(v);
                    saveSettingsNow({ autoTitle: v });
                  }}
                />
              </SettingsRow>
              <Separator />
              <div className="flex items-center justify-between gap-4 py-3">
                <Label>子代理深度</Label>
                <Select
                  value={maxSubagentDepth}
                  onValueChange={(v) => {
                    if (v == null) return;
                    setMaxSubagentDepth(v);
                    saveSettingsNow({ maxSubagentDepth: v });
                  }}
                  items={[
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                    { value: "3", label: "3" },
                    { value: "4", label: "4" },
                    { value: "5", label: "5" },
                  ]}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="4">4</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {agentId ? (
                <Button
                  variant="outline"
                  className="mt-2 w-full"
                  nativeButton={false}
                  render={
                    <Link href={`/dashboard/agents/${agentId}/general`} />
                  }
                >
                  全部设置
                  <ExternalLink className="size-3.5 opacity-70" />
                </Button>
              ) : null}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
