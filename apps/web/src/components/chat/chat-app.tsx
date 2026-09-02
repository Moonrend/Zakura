"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { chatSessionHref, shouldLetBrowserHandleClick } from "@/lib/nav";
import { toast } from "sonner";
import {
  Archive,
  ArrowDown,
  Bot,
  Check,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileClock,
  FolderOpen,
  FolderPlus,
  GitFork,
  LayoutDashboard,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Settings2,
  SquarePen,
  Square,
  Trash2,
  Loader2,
} from "lucide-react";
import type {
  CloudAgentEvent,
  CloudAgentFollowUpMode,
  CloudAgentRunOptions,
  ComposerCapabilities,
} from "@zakura/shared";
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  estimateEventPayloadTokens,
  estimateTextTokens,
  estimateTokensFromChars,
  ZAKURA_RUNTIME_ID,
  type AcpRuntimeState,
} from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { notifyAcpStartFailed } from "@/components/workspace-image-upgrade-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { PageLoading } from "@/components/ui/progress-linear";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { fetchAcpConfig, fetchAcpRuntime, prepareAcpDraft, resolveAcpPermission, resolveAcpElicitation, setAcpMode, setAcpModel, setAcpConfigOption } from "@/lib/acp";
import {
  buildConversationTurns,
  cancelCloudRun,
  compactCloudSession,
  continueCloudRun,
  createCloudSession,
  fetchComposerCapabilities,
  deleteCloudSession,
  forkCloudSession,
  getCloudConfig,
  getCloudSession,
  interruptWithQueuedMessage,
  lastCancelledRunId,
  listChatModels,
  listCloudSessions,
  regenerateCloudRun,
  removeQueuedMessage,
  saveCloudConfig,
  searchCloudSessions,
  sendCloudMessage,
  subscribeCloudEvents,
  updateCloudSession,
  SESSION_KIND_LABELS,
  type ChatModelOption,
  type CloudAgentAttachment,
  type CloudAgentQueuedMessage,
  type CloudAgentSessionKind,
  type CloudSearchHit,
  type CloudSession,
  type SessionKindsFilter,
} from "@/lib/cloud-agent";
import { formatSize, fsUploadWithProgress, listAgentProjects, createAgentProject, renameAgentProject, deleteAgentProject, type AgentProject } from "@/lib/agent-fs";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { ChatMessages } from "./chat-messages";
import { MessageNavigator } from "./message-navigator";
import {
  Composer,
  type ComposerModelItem,
  type ComposerReasoningValue,
  type PendingUpload,
  reasoningItemsFromLevels,
} from "./composer";
import { MessageQueue } from "./message-queue";
import type { ContextWindowInfo } from "./context-window";
import { FilePanel } from "./file-panel";
import { AutomationPanel } from "./automation-panel";
import { RunLogDrawer } from "./run-log-drawer";
import { ProjectConfigPanel } from "./project-config-panel";

import {
  AGENT_KEY,
  REASONING_KEY,
  DRAFT_KEY_PREFIX,
  kindsForSidebar,
  syncChatUrl,
  KIND_FILTER_OPTIONS,
  groupSessions,
  latestCompaction,
  latestMeasuredPromptTokens,
  buildContextWindowInfo,
} from "./chat-helpers";

export function ChatApp() {
  const { confirm } = useConfirmDialog();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectGit, setNewProjectGit] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [configProject, setConfigProject] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** 会话类型过滤：chat=日常对话；subagent/delegate/system=系统产生的对话记录 */
  const [kindFilter, setKindFilter] = useState<CloudAgentSessionKind | "all">("chat");
  const [events, setEvents] = useState<CloudAgentEvent[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreHistoryRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const oldestSeqRef = useRef(0);
  /**
   * Session currently being fetched, for UI only.
   *
   * Switching sessions awaits a full round trip. Without this the previous
   * conversation stayed on screen the whole time and the clicked row was not even
   * highlighted, so a slow load was indistinguishable from a frozen app — then the
   * content swapped in one jump. `sessionId` itself is still assigned only after
   * the fetch resolves, so the SSE subscription and draft effects keep their
   * existing ordering guarantees.
   */
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const pendingSessionRequestRef = useRef(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 侧栏：对话列表 | 定时任务 */
  const [sidebarMode, setSidebarMode] = useState<"chats" | "tasks">("chats");
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
  /** 运行中再发：steer=下一工具后注入（默认）；queue=整轮结束后再发 */
  const [followUpMode, setFollowUpMode] = useState<CloudAgentFollowUpMode>("steer");
  const [maxSubagentDepth, setMaxSubagentDepth] = useState("2");
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [hasChatRoute, setHasChatRoute] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<CloudSearchHit[] | null>(null);
  const [variantByMessage, setVariantByMessage] = useState<Record<string, string>>({});
  const [branchByParent, setBranchByParent] = useState<Record<string, string>>({});
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [fileRequest, setFileRequest] = useState<{
    path: string;
    nonce: number;
    dir?: boolean;
  } | null>(null);
  const [attachments, setAttachments] = useState<CloudAgentAttachment[]>([]);
  /** 待发送图片的本地预览地址（object URL），key 为工作区路径 */
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  /** 正在上传的文件（含进度），用于在输入框里显示占位片 */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [composerCap, setComposerCap] = useState<ComposerCapabilities>({
    skills: [],
    groups: [],
  });
  const [acpRuntimes, setAcpRuntimes] = useState<Array<{ id: string; label: string }>>([
    { id: ZAKURA_RUNTIME_ID, label: "Zakura" },
  ]);
  const [draftRuntimeId, setDraftRuntimeId] = useState(ZAKURA_RUNTIME_ID);
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const [acpPreparingProfileId, setAcpPreparingProfileId] = useState<string | null>(null);
  /** 实时事件流断开（正在自动重连）；收到任何事件即恢复 */
  const [realtimeOffline, setRealtimeOffline] = useState(false);
  const defaultRuntimeRef = useRef(ZAKURA_RUNTIME_ID);
  const [acpRuntime, setAcpRuntime] = useState<{
    state?: AcpRuntimeState;
    error?: string;
    modes?: { currentId?: string; available: Array<{ id: string; name: string }> };
    availableCommands?: Array<{ name: string; description?: string }>;
    models?: { currentId?: string; available: Array<{ id: string; name: string }>; configId?: string };
    reasoning?: { current?: string; available: Array<{ id: string; name: string }>; configId?: string };
  } | null>(null);
  const acpPreparingProfileIdRef = useRef<string | null>(null);
  acpPreparingProfileIdRef.current = acpPreparingProfileId;
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [disabledGroupIds, setDisabledGroupIds] = useState<string[]>([]);
  /** 服务端排队的后续消息（queue_update 快照实时同步，跨设备一致） */
  const [queue, setQueue] = useState<CloudAgentQueuedMessage[]>([]);
  /**
   * 正在编辑的已发送消息：编辑一律召回 Composer 复用完整能力（附件/换行/模型选项），
   * 不做行内简易文本框。发送时按 parentKey 建新分支，原消息保留为兄弟变体。
   */
  const [editingTarget, setEditingTarget] = useState<{
    messageId: string;
    parentKey: string;
  } | null>(null);
  /** 上传中的请求，用于取消 */
  const uploadAbortsRef = useRef<Map<string, AbortController>>(new Map());
  /** 已应用的队列快照 seq：重放/乱序事件不回退队列 */
  const queueSeqRef = useRef(0);
  /** 发送串行链：多次快速发送按序到达服务端（顺序由服务端队列保证） */
  const sendChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** 当前会话 id 的同步镜像：串行链内的发送不能读过期的 state */
  const sessionIdRef = useRef<string | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
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
  // Older cloud sessions may have a null/undefined origin after schema
  // migrations. Treat those as ordinary sessions instead of crashing render.
  const isGatewaySession = activeSession?.origin?.channel === "openai-gateway";
  /**
   * 活跃 Run 优先从事件流推导（有序、无请求竞态）。
   * 引导/出队是「run_end(cancelled) → 立刻 run_start 新回合」的连续事件；
   * 若依赖拉会话列表，两次刷新响应乱序会把「运行中」闪成「已结束」，
   * 让停止按钮消失、重新生成等操作在运行中提前出现。
   * 事件窗口里没有 run_start（刚加载/Gateway 会话）时回退会话快照。
   */
  const activeRunId = useMemo(() => {
    let latest: { runId: string; ended: boolean } | null = null;
    for (const ev of events) {
      if (ev.type === "run_start" && ev.runId) {
        latest = { runId: ev.runId, ended: false };
      } else if (ev.type === "run_end" && ev.runId && latest?.runId === ev.runId) {
        latest.ended = true;
      }
    }
    if (latest) return latest.ended ? null : latest.runId;
    return activeSession?.activeRunId ?? null;
  }, [events, activeSession?.activeRunId]);
  /**
   * 队列只在运行期存在（停止/完成后服务端自动继续出队），
   * 因此「有排队消息」也按运行中展示，避免出队间隙闪成空闲。
   */
  const runActive = Boolean(activeRunId) || queue.length > 0;
  const canContinue =
    Boolean(sessionId) && hasChatRoute && !runActive && !sending && Boolean(lastCancelledRunId(events));

  // 串行发送链在 state 提交前就可能读取会话 id，保持同步镜像
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
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
  const unboundGrouped = useMemo(
    () =>
      groupSessions(
        sessions.filter(
          (s) => !s.project && (kindFilter === "all" || s.kind === kindFilter),
        ),
      ),
    [sessions, kindFilter],
  );
  const projectRows = useMemo(() => {
    const by = new Map<string, CloudSession[]>();
    for (const s of sessions) {
      if (!s.project) continue;
      const list = by.get(s.project) ?? [];
      list.push(s);
      by.set(s.project, list);
    }
    const names = new Set([...projects.map((p) => p.name), ...by.keys()]);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        missing: !projects.some((p) => p.name === name),
        sessions: by.get(name) ?? [],
      }));
  }, [projects, sessions]);
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
  /**
   * True while switching to a *different* session. Re-loading the session already
   * on screen (fork, compact, boot restore) keeps the transcript visible so the
   * view does not flash placeholders over content the user is already reading.
   */
  const switchingSession = pendingSessionId !== null && pendingSessionId !== sessionId;
  const isNewSession = !events.some((ev) => ev.type === "user_message");
  const sessionProject = activeSession?.project ?? draftProject;
  const {
    scrollRef,
    contentRef,
    scrollEl,
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
    const options: CloudAgentRunOptions = {};
    if (reasoning === "off") options.reasoning = { enabled: false };
    else if (reasoning !== "default") options.reasoning = { enabled: true, effort: reasoning };
    if (selectedSkills.length > 0) options.skills = selectedSkills;
    if (disabledGroupIds.length > 0 && composerCap.groups.length > 0) {
      const disabled = new Set(disabledGroupIds);
      const tools: string[] = [];
      const seen = new Set<string>();
      for (const group of composerCap.groups) {
        if (!disabled.has(group.id)) continue;
        for (const name of group.tools) {
          if (seen.has(name)) continue;
          seen.add(name);
          tools.push(name);
        }
      }
      if (tools.length > 0) options.disabledTools = tools;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  }, [reasoning, selectedSkills, disabledGroupIds, composerCap.groups]);

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
        } else {
          try {
            const stored = sessionStorage.getItem("zakura_pending_prompt");
            if (stored?.trim()) {
              pendingPromptRef.current = stored.trim();
              autoPromptSentRef.current = false;
              sessionStorage.removeItem("zakura_pending_prompt");
            }
          } catch {
            /* ignore */
          }
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
    const kinds = kindsForSidebar(kindFilterRef.current);
    const res = await listCloudSessions(agentId, { kinds, limit: 200 });
    setSessions(res.sessions);
    return res.sessions;
  }, [agentId]);

  const refreshProjects = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await listAgentProjects(agentId);
      setProjects(res.projects);
    } catch {
      setProjects([]);
    }
  }, [agentId]);

  const mergeEvent = useCallback(
    (ev: CloudAgentEvent) => {
      setRealtimeOffline(false);
      setEvents((prev) => {
        // 事件基本按 seq 顺序到达：尾部追加是 O(1)，只有乱序才走排序兜底。
        const last = prev[prev.length - 1];
        if (!last || ev.seq > last.seq) return [...prev, ev];
        if (prev.some((e) => e.id === ev.id || e.seq === ev.seq)) return prev;
        return [...prev, ev].sort((a, b) => a.seq - b.seq);
      });
      if (ev.seq > seqRef.current) seqRef.current = ev.seq;
      // 服务端队列快照：全量替换（只认更新的 seq，重放不回退）
      if (ev.type === "queue_update") {
        const p = ev.payload as { items?: CloudAgentQueuedMessage[] };
        if (ev.seq >= queueSeqRef.current) {
          queueSeqRef.current = ev.seq;
          setQueue(Array.isArray(p.items) ? p.items : []);
        }
      }
      if (ev.type === "session_update") {
        const p = ev.payload as {
          acpState?: AcpRuntimeState;
          acpError?: string;
          acpCommands?: Array<{ name: string; description?: string }>;
          acpModeId?: string;
          acpModes?: { currentId?: string; available: Array<{ id: string; name: string }> };
          acpModels?: {
            currentId?: string;
            available: Array<{ id: string; name: string }>;
            configId?: string;
          };
          acpReasoning?: {
            current?: string;
            available: Array<{ id: string; name: string }>;
            configId?: string;
          };
        };
        if (
          p.acpState ||
          p.acpError ||
          p.acpCommands ||
          p.acpModeId ||
          p.acpModes ||
          p.acpModels ||
          p.acpReasoning
        ) {
          setAcpRuntime((prev) => ({
            ...prev,
            ...(p.acpState ? { state: p.acpState } : {}),
            ...(p.acpError ? { error: p.acpError, state: "closed" as const } : {}),
            ...(p.acpCommands ? { availableCommands: p.acpCommands } : {}),
            ...(p.acpModes
              ? { modes: p.acpModes }
              : p.acpModeId
                ? {
                    modes: {
                      currentId: p.acpModeId,
                      available: prev?.modes?.available ?? [],
                    },
                  }
                : {}),
            ...(p.acpModels ? { models: p.acpModels } : {}),
            ...(p.acpReasoning ? { reasoning: p.acpReasoning } : {}),
          }));
        }
        if (p.acpError) {
          setAcpPreparingProfileId(null);
          toast.error(`Agent 启动失败：${p.acpError}`);
          // Agent 启动失败常因工作区镜像过旧（未预装 CLI）。触发一次镜像
          // 检查，若有落后镜像则弹出升级对话框引导用户去刷新重建。
          notifyAcpStartFailed();
        } else if (p.acpState === "idle" || p.acpState === "active") {
          if (acpPreparingProfileIdRef.current) toast.success("Agent 已就绪");
          setAcpPreparingProfileId(null);
        }
      }
      // session_update 不触发列表刷新：ACP 会话里模型/命令更新频繁，
      // 且列表元数据变化已有 platform cloud_session_changed 事件覆盖。
      if (
        ev.type === "run_start" ||
        ev.type === "run_end" ||
        ev.type === "run_error" ||
        ev.type === "user_message"
      ) {
        void refreshSessions();
      }
    },
    [refreshSessions],
  );

  const loadSessionInner = useCallback(
    async (aid: string, sid: string) => {
      const res = await getCloudSession(aid, sid, 0);
      setSessionId(sid);
      sessionIdRef.current = sid;
      setEvents(res.events);
      const hasMore = Boolean(res.hasMore);
      setHasMoreHistory(hasMore);
      hasMoreHistoryRef.current = hasMore;
      oldestSeqRef.current = res.events[0]?.seq ?? 0;
      const sessionHasModel = Boolean(res.session.model);
      // ACP models belong to the selected adapter. Keep them out of the
      // Zakura catalog state so a later render cannot show the wrong list.
      setModel(res.session.kind === "acp"
        ? ""
        : sessionHasModel
          ? res.session.model!
          : agentDefaultsRef.current.model);
      setModelRouteId(res.session.kind === "acp"
        ? null
        : sessionHasModel
          ? res.session.modelRouteId
          : agentDefaultsRef.current.modelRouteId);
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
      setDraftRuntimeId(
        res.session.kind === "acp" && res.session.origin?.acpProfileId
          ? res.session.origin.acpProfileId
          : ZAKURA_RUNTIME_ID,
      );
      if (res.session.kind === "acp") {
        let commands: Array<{ name: string; description?: string }> | undefined;
        let modeId: string | undefined;
        let modes: { currentId?: string; available: Array<{ id: string; name: string }> } | undefined;
        let models: {
          currentId?: string;
          available: Array<{ id: string; name: string }>;
          configId?: string;
        } | undefined;
        let reasoning: {
          current?: string;
          available: Array<{ id: string; name: string }>;
          configId?: string;
        } | undefined;
        let acpState: AcpRuntimeState | undefined;
        let acpError: string | undefined;
        for (const ev of res.events) {
          if (ev.type !== "session_update") continue;
          const p = ev.payload as {
            acpState?: AcpRuntimeState;
            acpError?: string;
            acpCommands?: Array<{ name: string; description?: string }>;
            acpModeId?: string;
            acpModes?: { currentId?: string; available: Array<{ id: string; name: string }> };
            acpModels?: typeof models;
            acpReasoning?: typeof reasoning;
          };
          if (p.acpCommands) commands = p.acpCommands;
          if (p.acpModes) modes = p.acpModes;
          if (p.acpModeId) modeId = p.acpModeId;
          if (p.acpModels) models = p.acpModels;
          if (p.acpReasoning) reasoning = p.acpReasoning;
          if (p.acpState) acpState = p.acpState;
          if (p.acpError) acpError = p.acpError;
        }
        setAcpRuntime({
          state: acpError ? "closed" : acpState,
          error: acpError,
          availableCommands: commands,
          modes: modes ?? (modeId ? { currentId: modeId, available: [] } : undefined),
          models,
          reasoning,
        });
        void fetchAcpRuntime(aid, sid)
          .then((status) => {
            setAcpRuntime((prev) => ({
              ...prev,
              state: status.state,
              error: status.error,
              availableCommands: status.availableCommands ?? prev?.availableCommands,
              modes: status.modes ?? prev?.modes,
              models: status.models ?? prev?.models,
              reasoning: status.reasoning ?? prev?.reasoning,
            }));
            if (status.state === "idle" || status.state === "active") {
              setAcpPreparingProfileId(null);
            }
            if (status.error) {
              toast.error(`Agent 启动失败：${status.error}`);
              notifyAcpStartFailed();
            }
          })
          .catch((err) => {
            console.warn("[acp runtime]", err);
            const msg = err instanceof Error ? err.message : String(err);
            if (!/^HTTP 5\d\d$/.test(msg)) {
              toast.error(`Agent 状态获取失败：${msg}`);
            }
          });
      } else {
        setAcpRuntime(null);
      }
      setVariantByMessage({});
      setBranchByParent({});
      setEditingTarget(null);
      const maxSeq = res.events.reduce((m, e) => Math.max(m, e.seq), 0);
      seqRef.current = maxSeq;
      // 服务端队列随会话加载（其它设备排的消息也在这里）
      setQueue(res.queue ?? []);
      queueSeqRef.current = maxSeq;
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== sid);
        return [res.session, ...others].sort(
          (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
        );
      });
    },
    [],
  );

  /**
   * Session switch with a visible pending state and a real failure path.
   *
   * Callers used to `void loadSession(...)`, so a rejected fetch was an unhandled
   * promise: the old transcript simply stayed on screen with no error and no way to
   * tell it had failed. The request counter drops stale responses when the user
   * clicks through several sessions quickly.
   */
  const loadSession = useCallback(
    async (aid: string, sid: string) => {
      const requestId = ++pendingSessionRequestRef.current;
      setPendingSessionId(sid);
      try {
        await loadSessionInner(aid, sid);
      } catch (err) {
        if (requestId === pendingSessionRequestRef.current) {
          toast.error(
            `会话加载失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        if (requestId === pendingSessionRequestRef.current) {
          setPendingSessionId(null);
        }
      }
    },
    [loadSessionInner],
  );

  const loadOlderMessages = useCallback(async () => {
    const aid = agentId;
    const sid = sessionIdRef.current;
    const beforeSeq = oldestSeqRef.current;
    if (!aid || !sid || beforeSeq <= 0) return;
    if (loadingOlderRef.current || !hasMoreHistoryRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const prevHeight = scrollEl?.scrollHeight ?? 0;
    const prevTop = scrollEl?.scrollTop ?? 0;
    try {
      const res = await getCloudSession(aid, sid, { beforeSeq });
      const hasMore = Boolean(res.hasMore) && res.events.length > 0;
      hasMoreHistoryRef.current = hasMore;
      setHasMoreHistory(hasMore);
      if (res.events.length === 0) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const older = res.events.filter((e) => !seen.has(e.seq));
        if (older.length === 0) {
          hasMoreHistoryRef.current = false;
          setHasMoreHistory(false);
          return prev;
        }
        const merged = [...older, ...prev];
        oldestSeqRef.current = merged[0]?.seq ?? beforeSeq;
        return merged;
      });
      requestAnimationFrame(() => {
        if (!scrollEl) return;
        scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevHeight);
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载更早消息失败");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [agentId, scrollEl]);

  const resetConversationEvents = useCallback(() => {
    setEvents([]);
    setHasMoreHistory(false);
    hasMoreHistoryRef.current = false;
    oldestSeqRef.current = 0;
  }, []);

  useEffect(() => {
    if (!scrollEl) return;
    const onScroll = () => {
      if (scrollEl.scrollTop < 120) void loadOlderMessages();
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, loadOlderMessages]);

  // 首屏未撑满视口时继续回拉，避免「还有历史但滚不到顶」
  useEffect(() => {
    if (!scrollEl || !hasMoreHistory || loadingOlder) return;
    // 切换会话期间跳过：此时视口里是骨架屏，高度必然「没撑满」，
    // 会立刻对着上一个会话的 hasMoreHistory 再发一次回拉请求，
    // 和正在进行的切换抢带宽、抢渲染。
    if (switchingSession) return;
    if (scrollEl.scrollHeight <= scrollEl.clientHeight + 48) {
      void loadOlderMessages();
    }
  }, [
    scrollEl,
    hasMoreHistory,
    loadingOlder,
    switchingSession,
    events.length,
    loadOlderMessages,
  ]);

  // —— 切换 Agent：加载会话/配置/模型 ——
  useEffect(() => {
    if (!agentId || !authed) return;
    setAgentReady(false);
    localStorage.setItem(AGENT_KEY, agentId);
    for (const url of Object.values(previewsRef.current)) URL.revokeObjectURL(url);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
    setSelectedSkills([]);
    setDisabledGroupIds([]);
    setComposerCap({ skills: [], groups: [] });
    setFileRequest(null);
    let cancelled = false;
    (async () => {
      try {
        const [list, cfg, chatModels, projectRes] = await Promise.all([
          listCloudSessions(agentId, {
            kinds: kindsForSidebar(kindFilterRef.current),
            limit: 200,
          }).then((r) => r.sessions),
          getCloudConfig(agentId),
          listChatModels(),
          listAgentProjects(agentId).catch(() => ({ projects: [] as AgentProject[] })),
        ]);
        if (cancelled) return;
        void fetchComposerCapabilities(agentId)
          .then((cap) => {
            if (!cancelled) setComposerCap(cap);
          })
          .catch(() => {});
        void fetchAcpConfig(agentId)
          .then((res) => {
            if (cancelled) return;
            const extras = Object.values(res.config.agents)
              .filter((a) => a.enabled)
              .map((a) => ({
                id: a.id,
                label:
                  a.displayName ||
                  res.profiles.find((p) => p.id === a.id)?.displayName ||
                  a.id,
              }));
            setAcpRuntimes([{ id: ZAKURA_RUNTIME_ID, label: "Zakura" }, ...extras]);
            const def = res.config.defaultRuntime || ZAKURA_RUNTIME_ID;
            defaultRuntimeRef.current = extras.some((e) => e.id === def) || def === ZAKURA_RUNTIME_ID
              ? def
              : ZAKURA_RUNTIME_ID;
            if (!sessionIdRef.current) setDraftRuntimeId(defaultRuntimeRef.current);
          })
          .catch(() => {
            if (!cancelled) setAcpRuntimes([{ id: ZAKURA_RUNTIME_ID, label: "Zakura" }]);
          });
        setSessions(list);
        setProjects(projectRes.projects);
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
        setFollowUpMode(cfg.cloud.followUpMode === "queue" ? "queue" : "steer");
        setMaxSubagentDepth(String(cfg.cloud.maxSubagentDepth ?? 2));
        setModels(chatModels);
        const pending = pendingSessionRef.current;
        pendingSessionRef.current = null;
        // 有待发送 prompt 时开新会话草稿，避免挂在旧对话上
        if (pendingPromptRef.current) {
          setSessionId(null);
          resetConversationEvents();
          seqRef.current = 0;
          setSessions(list);
        } else if (pending && pending.agentId === agentId) {
          await loadSession(agentId, pending.sessionId);
        } else if (list.length > 0) {
          await loadSession(agentId, list[0]!.id);
        } else {
          setSessionId(null);
          resetConversationEvents();
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
  }, [agentId, authed, loadSession, resetConversationEvents]);

  // agentReady 后再同步 URL，避免首屏加载深链 session 前被清掉
  useEffect(() => {
    if (!authed || !agentReady) return;
    syncChatUrl(agentId, sessionId);
  }, [authed, agentReady, agentId, sessionId]);

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
        resetConversationEvents();
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
  }, [agentId, agentReady, authed, loadSession, refreshSessions, resetConversationEvents]);

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
          resetConversationEvents();
          seqRef.current = 0;
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅响应过滤变化
  }, [kindFilter]);

  // —— 会话事件订阅（重连与 afterSeq 续传由传输层处理）——
  useEffect(() => {
    if (!sessionId || !agentId) return;
    return subscribeCloudEvents(agentId, sessionId, seqRef.current, {
      onEvent: mergeEvent,
      onError: (msg) => {
        console.warn("[chat realtime]", msg);
        setRealtimeOffline(true);
      },
    });
  }, [agentId, sessionId, mergeEvent]);

  // —— 平台事件：其它会话新建/更新（含 Gateway）同步侧栏 ——
  useEffect(() => {
    if (!agentId || !authed) return;
    return subscribePlatformEvents(
      (ev) => {
        if (ev.type === "cloud_session_changed" && ev.agentId === agentId) {
          void refreshSessions();
        }
        if (ev.type === "agent_fs_changed" && ev.agentId === agentId) {
          if (ev.path === "/projects" || ev.path.startsWith("/projects/")) {
            void refreshProjects();
          }
        }
      },
      () => {
        void refreshSessions();
        void refreshProjects();
      },
    );
  }, [agentId, authed, refreshSessions, refreshProjects]);

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

  useEffect(() => {
    if (!sessionId) return;
    setDraftProject(activeSession?.project ?? null);
  }, [sessionId, activeSession?.project]);

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
    const sid = sessionIdRef.current;
    const current = sessions.find((s) => s.id === sid);
    // prepareAcpDraft 预创建的会话若始终没有发过消息，视为未使用直接删掉，
    // 避免侧栏堆积一堆「ACP · xxx」空会话。
    if (sid && current?.kind === "acp" && !events.some((e) => e.type === "user_message")) {
      void discardUnusedAcpDraft(agentId, sid);
    }
    setSessionId(null);
    sessionIdRef.current = null;
    resetConversationEvents();
    setVariantByMessage({});
    setBranchByParent({});
    seqRef.current = 0;
    queueSeqRef.current = 0;
    setQueue([]);
    setEditingTarget(null);
    setAcpRuntime(null);
    setDraftRuntimeId(defaultRuntimeRef.current);
    setDraftProject(null);
    clearAttachments();
    setSelectedSkills([]);
    composerRef.current?.focus();
  }

  async function discardUnusedAcpDraft(aid: string, sid: string) {
    try {
      await deleteCloudSession(aid, sid);
      setSessions((prev) => prev.filter((s) => s.id !== sid));
    } catch {
      // 删除失败就保留，用户仍可手动删除。
    }
  }

  /** 新建定时任务：开新对话，让 Agent 用 create_schedule 创建 */
  function handleAskAgentCreateSchedule(goal: string) {
    if (!agentId || sending || runActive) return;
    const prompt = [
      "请用 create_schedule 为我创建定时任务。",
      "根据下面描述自行决定名称、执行周期（cron 或 @every_…）和任务指令，创建后用一两句话确认。",
      "若任务会写文件，create_schedule 必须带 project（工作区项目 slug）。",
      projects.length
        ? `当前项目：${projects.map((p) => p.name).join("、")}`
        : "还没有项目时，先在 /workspace/projects/<名>/ 建目录再绑 project。",
      "",
      goal.trim(),
    ].join("\n");
    setSidebarMode("chats");
    handleNewSession();
    closeNavOnMobile();
    void (async () => {
      setSending(true);
      setInput(prompt);
      try {
        const created = await createCloudSession(agentId);
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        draftKeyRef.current = created.id;
        setSessionId(created.id);
        sessionIdRef.current = created.id;
        seqRef.current = 0;
        resetConversationEvents();
        await sendCloudMessage(agentId, created.id, prompt, null, undefined, runOptions);
        await refreshSessions();
        focusComposerAfterPromptRef.current = true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
        setInput("");
      }
    })();
  }

  async function handleDeleteSession(sid: string) {
    if (!agentId) return;
    if (!(await confirm({ title: "删除该对话？", confirmLabel: "删除" }))) return;
    try {
      await deleteCloudSession(agentId, sid);
      const next = sessions.filter((s) => s.id !== sid);
      setSessions(next);
      if (sessionId === sid) {
        if (next[0]) await loadSession(agentId, next[0].id);
        else {
          setSessionId(null);
          resetConversationEvents();
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
          resetConversationEvents();
          seqRef.current = 0;
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleForkSession(sid: string) {
    if (!agentId) return;
    try {
      const result = await forkCloudSession(agentId, sid);
      const forked = result.session;
      if (!forked) throw new Error("Fork 会话创建成功，但无法读取新会话");
      setSessions((prev) => [forked, ...prev.filter((s) => s.id !== forked.id)]);
      await loadSession(agentId, forked.id);
      toast.success("已从该会话 Fork，新会话不会修改原会话");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** 锁定会话（Gateway）操作前自动 Fork，返回可写会话 id */
  async function forkToWritableSession(sourceSid: string): Promise<string> {
    if (!agentId) throw new Error("未选择 Agent");
    const result = await forkCloudSession(agentId, sourceSid);
    const forked = result.session;
    if (!forked) throw new Error("Fork 成功，但无法读取新会话");
    setSessions((prev) => [forked, ...prev.filter((s) => s.id !== forked.id)]);
    await loadSession(agentId, forked.id);
    toast.success("已自动 Fork，在新会话中继续");
    return forked.id;
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

  async function handleMoveSession(sid: string, project: string | null) {
    if (!agentId) return;
    try {
      const updated = await updateCloudSession(agentId, sid, { project });
      setSessions((prev) => prev.map((s) => (s.id === sid ? updated : s)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSessionProjectChange(next: string | null) {
    setDraftProject(next);
    const sid = sessionIdRef.current;
    if (!agentId || !sid) return;
    const current = sessions.find((s) => s.id === sid);
    const unusedAcp =
      current?.kind === "acp" && !events.some((e) => e.type === "user_message");
    if (unusedAcp && draftRuntimeId !== ZAKURA_RUNTIME_ID) {
      try {
        setAcpPreparingProfileId(draftRuntimeId);
        await discardUnusedAcpDraft(agentId, sid);
        const prepared = await prepareAcpDraft(agentId, draftRuntimeId, next);
        const created = prepared.session;
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setSessionId(created.id);
        sessionIdRef.current = created.id;
        draftKeyRef.current = created.id;
        setAcpRuntime(prepared.runtime);
        resetConversationEvents();
        seqRef.current = 0;
        queueSeqRef.current = 0;
        setQueue([]);
        if (prepared.runtime.state !== "starting") {
          setAcpPreparingProfileId(null);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setAcpPreparingProfileId(null);
      }
      return;
    }
    await handleMoveSession(sid, next);
  }

  async function handleNewProjectSession(project: string) {
    if (!agentId) return;
    try {
      const created = await createCloudSession(agentId, undefined, { project });
      setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
      await loadSession(agentId, created.id);
      closeNavOnMobile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleProjectCollapsed(name: string) {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function submitNewProject() {
    if (!agentId) return;
    const name = newProjectName.trim();
    if (!name) {
      toast.error("请填写项目名");
      return;
    }
    setNewProjectBusy(true);
    try {
      const res = await createAgentProject(agentId, {
        name,
        ...(newProjectGit.trim() ? { gitUrl: newProjectGit.trim() } : {}),
      });
      if (res.cloneError) toast.error(`项目已创建，克隆失败：${res.cloneError}`);
      else toast.success("已创建项目");
      setNewProjectOpen(false);
      setNewProjectName("");
      setNewProjectGit("");
      await refreshProjects();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setNewProjectBusy(false);
    }
  }

  async function commitRenameProject() {
    if (!agentId) return;
    const from = renamingProject;
    const to = renameProjectValue.trim();
    setRenamingProject(null);
    if (!from || !to || to === from) return;
    try {
      const res = await renameAgentProject(agentId, from, to);
      setProjects((prev) =>
        prev.map((p) => (p.name === from ? res.project : p)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setSessions((prev) => prev.map((s) => (s.project === from ? { ...s, project: to } : s)));
      setCollapsedProjects((prev) => {
        if (!prev.has(from)) return prev;
        const next = new Set(prev);
        next.delete(from);
        next.add(to);
        return next;
      });
      if (configProject === from) setConfigProject(to);
      toast.success(`已重命名为 ${to}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      await refreshProjects();
    }
  }

  async function handleDeleteProject(slug: string) {
    if (!agentId) return;
    const ok = await confirm({
      title: `删除项目 ${slug}？`,
      description: `将删除工作区目录 /workspace/projects/${slug} 及其文件。该项目下的对话（含子代理）和定时任务会解绑，不会被删掉。`,
      confirmLabel: "删除目录",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentProject(agentId, slug);
      setProjects((prev) => prev.filter((p) => p.name !== slug));
      setSessions((prev) => prev.map((s) => (s.project === slug ? { ...s, project: null } : s)));
      setCollapsedProjects((prev) => {
        if (!prev.has(slug)) return prev;
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
      if (configProject === slug) setConfigProject(null);
      toast.success("已删除项目目录");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function openProjectDir(slug: string) {
    setFilePanelOpen(true);
    fileNonceRef.current += 1;
    setFileRequest({ path: `/projects/${slug}`, nonce: fileNonceRef.current, dir: true });
  }

  function copyProjectPath(slug: string) {
    const path = `/workspace/projects/${slug}`;
    void navigator.clipboard.writeText(path).then(
      () => toast.success("已复制路径"),
      () => toast.error("复制失败"),
    );
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

  /**
   * 编辑排队消息：从服务端队列摘回主输入框（保留换行与附件），
   * 复用完整输入能力（图片/文件/模型选项），改完再发送即可。
   */
  function handleQueuedEdit(messageId: string) {
    const aid = agentId;
    const sid = sessionIdRef.current;
    if (!aid || !sid) return;
    const item = queueRef.current.find((m) => m.messageId === messageId);
    if (!item) return;
    if (latestInputRef.current.trim() || attachments.length > 0) {
      toast.error("输入框还有未发送的内容，先发送或清空后再编辑排队消息");
      return;
    }
    setQueue((prev) => prev.filter((m) => m.messageId !== messageId));
    setInput(item.content);
    latestInputRef.current = item.content;
    if (item.attachments?.length) setAttachments(item.attachments);
    void removeQueuedMessage(aid, sid, messageId).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
    composerRef.current?.focus();
  }

  function handleQueuedRemove(messageId: string) {
    const aid = agentId;
    const sid = sessionIdRef.current;
    if (!aid || !sid) return;
    setQueue((prev) => prev.filter((m) => m.messageId !== messageId));
    void removeQueuedMessage(aid, sid, messageId).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }

  /** 立即发送：打断当前 Run，只用这一条马上开新回合 */
  function handleQueuedInterrupt(messageId: string) {
    const aid = agentId;
    const sid = sessionIdRef.current;
    if (!aid || !sid) return;
    // 立刻出队：服务端 claim 后 queue_update 也会收敛；先消掉等待感
    setQueue((prev) => prev.filter((m) => m.messageId !== messageId));
    void interruptWithQueuedMessage(aid, sid, messageId).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }

  /** 空输入框按 ↑：召回最近排队的消息进输入框编辑（Codex edit_queued_message） */
  function handleRecallQueued() {
    const last = queueRef.current[queueRef.current.length - 1];
    if (!last) return;
    handleQueuedEdit(last.messageId);
  }

  /**
   * 编辑已发送消息：召回 Composer（复用附件/换行/模型选项等完整能力）。
   * 原消息不删除 —— 发送后按 parentKey 成为兄弟分支变体。
   */
  function handleEditStart(
    messageId: string,
    parentKey: string,
    content: string,
    msgAttachments: CloudAgentAttachment[],
  ) {
    if (runActive) return;
    // 已在编辑另一条时直接改目标；否则保护输入框里的未发送内容
    if (!editingTarget && (latestInputRef.current.trim() || attachments.length > 0)) {
      toast.error("输入框还有未发送的内容，先发送或清空后再编辑消息");
      return;
    }
    setEditingTarget({ messageId, parentKey });
    setInput(content);
    latestInputRef.current = content;
    setAttachments(msgAttachments);
    composerRef.current?.focus();
  }

  /** 取消编辑：清空召回的内容，回到普通输入态 */
  function handleEditCancel() {
    setEditingTarget(null);
    setInput("");
    latestInputRef.current = "";
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

  // 离开页面时中止在途上传
  useEffect(() => {
    const aborts = uploadAbortsRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    };
  }, []);

  /**
   * 真正打 API 发一条消息（串行链内执行）。会话不存在则先创建；
   * 服务端根据运行状态决定：空闲直接开 Run，运行中/有排队则入服务端队列
   * （steer 项在下一工具批后注入，queue 项等回合结束按 FIFO 发出）。
   */
  async function dispatchOutbound(
    content: string,
    sentAttachments: CloudAgentAttachment[],
    parentRunId: string | null | undefined,
    sentPreviews: Record<string, string>,
    sentSkills: string[],
  ) {
    if (!agentId) return;
    setSending(true);
    try {
      let sid = sessionIdRef.current;
      if (sid && sessions.find((s) => s.id === sid)?.origin?.channel === "openai-gateway") {
        sid = await forkToWritableSession(sid);
      }
      if (!sid) {
        const acpProfile =
          draftRuntimeId !== ZAKURA_RUNTIME_ID ? draftRuntimeId : undefined;
        const created = await createCloudSession(
          agentId,
          undefined,
          {
            ...(draftProject ? { project: draftProject } : {}),
            ...(acpProfile
              ? {
                  kind: "acp" as const,
                  origin: { runtime: "acp" as const, acpProfileId: acpProfile },
                }
              : {}),
          },
        );
        setSessions((prev) => [created, ...prev]);
        await updateCloudSession(agentId, created.id, {
          // ACP 会话的模型/思考强度由所选 Agent 自己管理，
          // 写入 Zakura 的值会在下次加载时误导 composer。
          ...(acpProfile ? {} : { model: model || null, modelRouteId, reasoning }),
          draftText: "",
        });
        draftKeyRef.current = created.id;
        setSessionId(created.id);
        sessionIdRef.current = created.id;
        seqRef.current = 0;
        queueSeqRef.current = 0;
        resetConversationEvents();
        setQueue([]);
        sid = created.id;
      }
      const res = await sendCloudMessage(
        agentId,
        sid,
        content,
        parentRunId,
        sentAttachments,
        runOptions,
      );
      if (draftRuntimeId !== ZAKURA_RUNTIME_ID) {
        void fetchAcpRuntime(agentId, sid)
          .then((status) =>
            setAcpRuntime((prev) => ({
              ...prev,
              state: status.state,
              error: status.error,
              availableCommands: status.availableCommands ?? prev?.availableCommands,
              modes: status.modes ?? prev?.modes,
              models: status.models ?? prev?.models,
              reasoning: status.reasoning ?? prev?.reasoning,
            })),
          )
          .catch((err) => {
            console.warn("[acp runtime]", err);
          });
      }
      // 服务端入队：乐观补一条占位，快照事件到达后全量对齐
      if (res.queued && res.messageId) {
        const mid = res.messageId;
        setQueue((prev) =>
          prev.some((m) => m.messageId === mid)
            ? prev
            : [
                ...prev,
                {
                  messageId: mid,
                  content,
                  attachments: sentAttachments,
                  mode: res.mode === "queue" ? "queue" : "steer",
                  createdAt: new Date().toISOString(),
                },
              ],
        );
      }
      await refreshSessions();
      scrollToBottom("smooth");
      for (const url of Object.values(sentPreviews)) URL.revokeObjectURL(url);
    } catch (err) {
      // 还原输入与附件（含图片预览），用户可修改后重发
      setInput(content);
      latestInputRef.current = content;
      setAttachments(sentAttachments);
      previewsRef.current = { ...previewsRef.current, ...sentPreviews };
      setAttachmentPreviews({ ...previewsRef.current });
      setSelectedSkills(sentSkills);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  /**
   * 发送：内容立即离开输入框，实际 POST 走串行链保证到达顺序。
   * 运行中无需特判——服务端统一决定注入 / 排队 / 直接开新回合。
   */
  function handleSend() {
    if (!agentId) return;
    const content = input.trim();
    if ((!content && attachments.length === 0) || uploads.length > 0) return;
    const sentAttachments = attachments;
    const sentPreviews = previewsRef.current;
    const sentSkills = selectedSkills;
    const parentRunId = parentForSend();
    setInput("");
    latestInputRef.current = "";
    draftsRef.current.delete(draftKeyRef.current);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
    setSelectedSkills([]);

    // 编辑态：不追加新回合，而是按 parentKey 建分支变体
    const editing = editingTarget;
    if (editing) {
      setEditingTarget(null);
      sendChainRef.current = sendChainRef.current
        .catch(() => {})
        .then(() => handleEditSend(editing.parentKey, content, sentAttachments));
      return;
    }

    sendChainRef.current = sendChainRef.current
      .catch(() => {})
      .then(() =>
        dispatchOutbound(content, sentAttachments, parentRunId, sentPreviews, sentSkills),
      );
  }

  async function handleRegenerate(messageId: string) {
    if (!agentId || !sessionId || runActive) return;
    try {
      let sid = sessionId;
      if (isGatewaySession) {
        sid = await forkToWritableSession(sessionId);
      }
      await regenerateCloudRun(agentId, sid, messageId, runOptions);
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

  async function handleEditSend(
    parentKey: string,
    content: string,
    sentAttachments: CloudAgentAttachment[] = [],
  ) {
    if (!agentId || !sessionId || runActive) return;
    if (!content.trim() && sentAttachments.length === 0) return;
    try {
      let sid = sessionId;
      if (isGatewaySession) {
        sid = await forkToWritableSession(sessionId);
      }
      await sendCloudMessage(
        agentId,
        sid,
        content.trim(),
        parentKey === "" ? null : parentKey,
        sentAttachments.length > 0 ? sentAttachments : undefined,
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

  async function handleContinue() {
    if (!agentId || !sessionId || runActive || sending) return;
    setSending(true);
    try {
      let sid = sessionId;
      if (isGatewaySession) {
        sid = await forkToWritableSession(sessionId);
      }
      await continueCloudRun(agentId, sid, runOptions);
      await refreshSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
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
    if (!agentId || !value) return;
    setModel(value);
    setModelRouteId(routeId);
    try {
      if (sessionId) {
        await updateCloudSession(agentId, sessionId, {
          model: value,
          modelRouteId: routeId || null,
        });
      } else {
        await saveCloudConfig(agentId, {
          model: value,
          modelRouteId: routeId || null,
        });
        agentDefaultsRef.current = { model: value, modelRouteId: routeId };
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
    followUpMode?: CloudAgentFollowUpMode;
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
      if (patch.followUpMode !== undefined) body.followUpMode = patch.followUpMode;
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
    const items: ComposerModelItem[] = models.map((m) => ({
      value: m.alias,
      label: m.name,
      hint: m.upstream,
      keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
      reasoning: m.reasoning,
      reasoningLevels: m.reasoningLevels,
      defaultReasonLevel: m.defaultReasonLevel,
      providers: m.providers,
    }));
    // 配置里存着的模型可能已从模型列表里下线，仍要能显示当前选中项
    if (model && !models.some((m) => m.alias === model)) {
      items.push({ value: model, label: model });
    }
    return items;
  }, [models, model]);

  /** 空 model 时展示团队默认（或列表首项），不引入「默认模型」哨兵项 */
  const displayModel = useMemo(() => {
    if (model) return model;
    return models.find((m) => m.isDefault)?.alias ?? models[0]?.alias ?? "";
  }, [model, models]);

  const selectedModelItem = useMemo(
    () => modelItems.find((item) => item.value === displayModel) ?? null,
    [modelItems, displayModel],
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
    return <PageLoading />;
  }

  function sessionRow(s: CloudSession) {
    return (
      <div
        key={s.id}
        aria-busy={s.id === pendingSessionId || undefined}
        className={cn(
          "group animate-rise relative flex items-center rounded-lg text-sm",
          "transition-colors duration-150 ease-fluid",
          s.id === sessionId || s.id === pendingSessionId
            ? "bg-muted text-foreground session-row-active"
            : "text-foreground/75 hover:bg-muted/60 hover:text-foreground/90",
        )}
      >
        {(s.id === sessionId || s.id === pendingSessionId) && (
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
            {/*
              A real anchor, not a button: the session already has a deep link
              (syncChatUrl writes /chat?agent=…&session=…), so making the row an
              <a href> is what enables right-click "copy link", long-press on
              mobile, and cmd/middle-click into a new tab. The onClick keeps the
              fast in-place load for plain clicks and steps aside otherwise.
            */}
            <a
              href={agentId ? chatSessionHref(agentId, s.id) : undefined}
              className="weight-hover flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1.5 text-left"
              onClick={(e) => {
                if (!agentId || shouldLetBrowserHandleClick(e)) return;
                e.preventDefault();
                void loadSession(agentId, s.id);
                closeNavOnMobile();
              }}
            >
              <span className="truncate">{s.title}</span>
              {s.kind === "acp" && s.origin?.acpProfileId ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {acpRuntimes.find((r) => r.id === s.origin?.acpProfileId)?.label ||
                    s.origin?.acpProfileId}
                </span>
              ) : s.kind && s.kind !== "chat" ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {SESSION_KIND_LABELS[s.kind] ?? s.kind}
                </span>
              ) : null}
              {s.origin?.channel === "openai-gateway" ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  Gateway
                </span>
              ) : null}
              {s.id === pendingSessionId ? (
                <Loader2
                  aria-label="加载中"
                  className="size-3 shrink-0 animate-spin text-muted-foreground"
                />
              ) : s.activeRunId ? (
                <span
                  aria-label="运行中"
                  className="running-halo relative h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/70 text-foreground/70"
                />
              ) : null}
            </a>
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
                {s.origin?.channel === "openai-gateway" ? (
                  <DropdownMenuItem onClick={() => void handleForkSession(s.id)}>
                    <GitFork />
                    Fork 后续聊
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={() => {
                    setRenamingId(s.id);
                    setRenameValue(s.title);
                  }}
                >
                  <Pencil />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>移到项目</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-32">
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.name}
                        onClick={() => void handleMoveSession(s.id, p.name)}
                      >
                        {p.name}
                        {s.project === p.name ? <Check className="h-3.5 w-3.5" /> : null}
                      </DropdownMenuItem>
                    ))}
                    {s.project ? (
                      <DropdownMenuItem onClick={() => void handleMoveSession(s.id, null)}>
                        移出到其他对话
                      </DropdownMenuItem>
                    ) : null}
                    {projects.length === 0 && !s.project ? (
                      <DropdownMenuItem disabled>暂无项目</DropdownMenuItem>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => void handleArchiveSession(s.id)}>
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
    );
  }

  return (
    <div className="chat-shell flex h-svh bg-background text-foreground">
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
          "chat-sidebar flex h-full shrink-0 flex-col border-r border-border/50",
          "md:transition-[width] md:duration-200",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[290px] max-md:shadow-xl max-md:transition-transform max-md:duration-200",
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
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground">
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
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-muted text-[10px] font-semibold text-foreground">
                    {a.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.id === agentId && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 侧栏分区：对话 | 任务 */}
        <div className="flex gap-3 border-b border-border/60 px-3">
          {(
            [
              { id: "chats" as const, label: "对话" },
              { id: "tasks" as const, label: "任务" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSidebarMode(tab.id)}
              className={cn(
                "-mb-px border-b-2 px-0.5 pb-2 pt-2 text-sm transition-colors",
                sidebarMode === tab.id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {sidebarMode === "chats" ? (
        <>
        {/* 新对话 + 搜索 */}
        <div className="flex flex-col gap-1 p-2">
          <button
            type="button"
            onClick={() => {
              handleNewSession();
              closeNavOnMobile();
            }}
            className={cn(
              "press group/new flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ease-fluid",
              sessionId === null
                ? "bg-muted text-foreground"
                : "text-foreground hover:bg-muted/60",
            )}
          >
            <SquarePen className="h-4 w-4 transition-transform duration-300 ease-overshoot group-hover/new:-rotate-12" />
            新对话
          </button>
          <div className="flex items-center gap-1">
            {/* 统一搜索框（含清空 + Esc 清空），与其余列表页保持一致 */}
            <SearchField
              value={searchQ}
              onValueChange={setSearchQ}
              placeholder="搜索对话"
              className="min-w-0 flex-1"
            />
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
              <div>
                <div className="flex items-center px-2 pb-0.5 pt-1">
                  <div className="flex-1 text-[11px] text-muted-foreground/60">项目</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="新建项目"
                    onClick={() => setNewProjectOpen(true)}
                    className="size-6 text-muted-foreground hover:text-foreground"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {projectRows.length === 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setNewProjectOpen(true)}
                    className="h-auto w-full justify-start rounded-lg px-2 py-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                  >
                    暂无项目，点此创建
                  </Button>
                ) : (
                  projectRows.map((row) => {
                    const collapsed = collapsedProjects.has(row.name);
                    const renaming = renamingProject === row.name;
                    return (
                      <div key={row.name}>
                        <div className="group flex items-center rounded-lg hover:bg-muted/50">
                          {renaming ? (
                            <Input
                              autoFocus
                              value={renameProjectValue}
                              onChange={(e) => setRenameProjectValue(e.target.value)}
                              onBlur={() => void commitRenameProject()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitRenameProject();
                                if (e.key === "Escape") setRenamingProject(null);
                              }}
                              className="mx-1 my-0.5 h-6 px-1 text-sm"
                            />
                          ) : (
                            <>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm"
                            onClick={() => toggleProjectCollapsed(row.name)}
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 truncate font-medium">{row.name}</span>
                            {row.missing ? (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                目录已删
                              </span>
                            ) : null}
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {row.sessions.length}
                            </span>
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <button
                                  type="button"
                                  aria-label="项目操作"
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground max-md:opacity-60 md:opacity-0 md:group-hover:opacity-100 md:data-[popup-open]:opacity-100"
                                />
                              }
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-32">
                              <DropdownMenuItem onClick={() => setConfigProject(row.name)}>
                                <Settings2 />
                                配置
                              </DropdownMenuItem>
                              {row.missing ? null : (
                                <DropdownMenuItem onClick={() => openProjectDir(row.name)}>
                                  <FolderOpen />
                                  打开目录
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => copyProjectPath(row.name)}>
                                <ExternalLink />
                                复制路径
                              </DropdownMenuItem>
                              {row.missing ? null : (
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenamingProject(row.name);
                                    setRenameProjectValue(row.name);
                                  }}
                                >
                                  <Pencil />
                                  重命名
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => void handleDeleteProject(row.name)}
                              >
                                <Trash2 />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <button
                            type="button"
                            title="在此项目新对话"
                            onClick={() => void handleNewProjectSession(row.name)}
                            className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground max-md:opacity-60 md:opacity-0 md:group-hover:opacity-100"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                            </>
                          )}
                        </div>
                        {collapsed ? null : (
                          <div className="flex flex-col pl-2">
                            {row.sessions.length === 0 ? (
                              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                                还没有对话
                              </div>
                            ) : (
                              row.sessions.map((s) => sessionRow(s))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              {unboundGrouped.map((g) => (
                <div key={g.label}>
                  <div className="px-2 pb-0.5 pt-1 text-[11px] text-muted-foreground/60">
                    {g.label === unboundGrouped[0]?.label ? `${g.label}` : g.label}
                  </div>
                  <div className="flex flex-col">{g.items.map((s) => sessionRow(s))}</div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        </>
        ) : (
          <AutomationPanel
            agentId={agentId}
            projects={projects.map((p) => p.name)}
            className="min-h-0 flex-1"
            onAskAgentCreate={handleAskAgentCreateSchedule}
            onOpenSession={(sid) => {
              if (!agentId) return;
              setSidebarMode("chats");
              setKindFilter("system");
              void loadSession(agentId, sid);
              closeNavOnMobile();
            }}
          />
        )}

        {/* 底部 */}
        <div className="border-t border-border/50 p-2">
          <Link
            href="/dashboard/agents"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <LayoutDashboard className="h-4 w-4" />
            控制台
          </Link>
        </div>
      </aside>

      {/* ===== 主区 ===== */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <MessageNavigator turns={turns} scrollEl={scrollEl ?? null} />
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="侧边栏"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm font-medium text-foreground/90">
            {agent?.name}
          </span>
          {realtimeOffline ? (
            <span
              role="status"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title="实时事件流已断开，正在自动重连；重连后会从断点继续同步"
            >
              <Loader2 className="size-3 animate-spin" />
              重连中
            </span>
          ) : null}
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
            {switchingSession ? (
              <PageLoading />
            ) : (
              <>
            {(loadingOlder || hasMoreHistory) && !emptyConversation && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                {loadingOlder ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    加载更早消息…
                  </>
                ) : (
                  "上滑加载更早消息"
                )}
              </div>
            )}
            <ChatMessages
              turns={turns}
              runActive={runActive}
              activeRunId={activeRunId}
              agentName={agent?.name}
              agentId={agentId}
              sessionId={sessionId}
              canAct={(hasChatRoute || draftRuntimeId !== ZAKURA_RUNTIME_ID) && !runActive && !sending}
              editingMessageId={editingTarget?.messageId ?? null}
              onRegenerate={(mid) => void handleRegenerate(mid)}
              onEditStart={handleEditStart}
              onSelectVariant={(mid, runId) =>
                setVariantByMessage((prev) => ({ ...prev, [mid]: runId }))
              }
              onSelectBranch={(parentKey, mid) =>
                setBranchByParent((prev) => ({ ...prev, [parentKey]: mid }))
              }
              onOpenFile={openFileInPanel}
              onPermission={(requestId, optionId, cancelled) => {
                if (!agentId || !sessionId) return;
                void resolveAcpPermission(agentId, sessionId, {
                  requestId,
                  optionId,
                  cancelled,
                }).catch((err) =>
                  toast.error(err instanceof Error ? err.message : String(err)),
                );
              }}
              onElicitation={(requestId, cancelled, content) => {
                if (!agentId || !sessionId) return;
                void resolveAcpElicitation(agentId, sessionId, {
                  requestId,
                  cancelled,
                  content,
                }).catch((err) =>
                  toast.error(err instanceof Error ? err.message : String(err)),
                );
              }}
            />
              </>
            )}
          </div>
        </div>

        {/* 组合器：排队列表贴在输入框上方连成一块 */}
        <div className="relative shrink-0 px-2.5 pt-1 pb-[max(env(safe-area-inset-bottom),0.625rem)] md:px-4 md:pb-4">
          {!atBottom && !emptyConversation && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => scrollToBottom("smooth")}
              className="animate-pop absolute top-0 left-1/2 z-10 h-auto -translate-x-1/2 -translate-y-[calc(100%+0.375rem)] gap-1 rounded-lg border-border/70 bg-background/90 px-3 py-1.5 text-xs font-normal text-muted-foreground shadow-[var(--shadow-soft)] backdrop-blur hover:text-foreground"
            >
              <ArrowDown className="size-3.5" />
              回到底部
            </Button>
          )}
          <Composer
            value={input}
            onValueChange={setInput}
            onSend={() => void handleSend()}
            onStop={() => void handleCancel()}
            showContinue={canContinue}
            onContinue={() => void handleContinue()}
            textareaRef={composerRef}
            routeReady={hasChatRoute || draftRuntimeId !== ZAKURA_RUNTIME_ID}
            runtimes={acpRuntimes}
            runtimeId={draftRuntimeId}
            runtimeDisabled={
              Boolean(sessionId && !isNewSession) || Boolean(acpPreparingProfileId)
            }
            runtimeLoading={
              Boolean(acpPreparingProfileId) || acpRuntime?.state === "starting"
            }
            runtimeDisabledHint={
              acpPreparingProfileId
                ? "正在启动 Agent…"
                : "对话已绑定执行方，不能切换；请新建对话后再选"
            }
            projects={projects.map((p) => p.name)}
            project={sessionProject}
            isNewSession={isNewSession}
            onProjectChange={(next) => void handleSessionProjectChange(next)}
            onRuntimeChange={(id) => {
              void (async () => {
                if (sessionId && !isNewSession) {
                  toast.message("当前对话已绑定 Agent，不能切换；请新建对话");
                  return;
                }
                const previousSessionId = sessionIdRef.current;
                const previousUnused =
                  previousSessionId &&
                  sessions.find((s) => s.id === previousSessionId)?.kind === "acp" &&
                  !events.some((e) => e.type === "user_message");
                setDraftRuntimeId(id);
                if (id === ZAKURA_RUNTIME_ID) {
                  setAcpRuntime(null);
                  if (agentId && previousSessionId && previousUnused) {
                    await discardUnusedAcpDraft(agentId, previousSessionId);
                    setSessionId(null);
                    sessionIdRef.current = null;
                    resetConversationEvents();
                    seqRef.current = 0;
                    queueSeqRef.current = 0;
                    setQueue([]);
                    setEditingTarget(null);
                  }
                  return;
                }
                if (agentId) {
                  setAcpPreparingProfileId(id);
                  try {
                    const prepared = await prepareAcpDraft(agentId, id, draftProject);
                    const created = prepared.session;
                    setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
                    setSessionId(created.id);
                    sessionIdRef.current = created.id;
                    draftKeyRef.current = created.id;
                    setAcpRuntime(prepared.runtime);
                    resetConversationEvents();
                    // 新会话 seq 从 1 开始；游标不重置会让订阅按旧 seq 续传，
                    // 服务端回放会跳过新会话的首批事件（首条消息不显示）。
                    seqRef.current = 0;
                    queueSeqRef.current = 0;
                    setQueue([]);
                    if (previousSessionId && previousUnused) {
                      await discardUnusedAcpDraft(agentId, previousSessionId);
                    }
                    if (prepared.runtime.state !== "starting") {
                      setAcpPreparingProfileId(null);
                    }
                  } catch (err) {
                    setDraftRuntimeId(ZAKURA_RUNTIME_ID);
                    setAcpRuntime(null);
                    setAcpPreparingProfileId(null);
                    toast.error(err instanceof Error ? err.message : String(err));
                  }
                }
              })();
            }}
            // ACP model selection must come from the selected Agent's
            // session/new response. Never fall back to Zakura's own catalog.
            hideZakuraModel={draftRuntimeId !== ZAKURA_RUNTIME_ID}
            acpModes={acpRuntime?.modes}
            acpCommands={acpRuntime?.availableCommands}
            acpModels={acpRuntime?.models}
            acpReasoning={acpRuntime?.reasoning}
            onAcpModeChange={(modeId) => {
              if (!agentId || !sessionId) return;
              void setAcpMode(agentId, sessionId, modeId)
                .then((status) =>
                  setAcpRuntime((prev) => ({
                    ...prev,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                  })),
                )
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
            }}
            onAcpModelChange={(modelId) => {
              if (!agentId || !sessionId) return;
              void setAcpModel(agentId, sessionId, modelId)
                .then((status) =>
                  setAcpRuntime((prev) => ({
                    ...prev,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                  })),
                )
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
            }}
            onAcpReasoningChange={(value) => {
              if (!agentId || !sessionId) return;
              const configId = acpRuntime?.reasoning?.configId;
              if (!configId) return;
              void setAcpConfigOption(agentId, sessionId, configId, value)
                .then((status) =>
                  setAcpRuntime((prev) => ({
                    ...prev,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                  })),
                )
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
            }}
            sending={sending}
            runActive={runActive}
            runSendHint={followUpMode === "steer" ? "注入当前回合" : "加入队列"}
            queueSlot={
              queue.length > 0 ? (
                <MessageQueue
                  items={queue}
                  onEdit={handleQueuedEdit}
                  onRemove={handleQueuedRemove}
                  onInterrupt={handleQueuedInterrupt}
                />
              ) : null
            }
            canRecallQueued={queue.length > 0}
            onRecallQueued={handleRecallQueued}
            editing={Boolean(editingTarget)}
            onCancelEdit={handleEditCancel}
            attachments={attachments}
            attachmentPreviews={attachmentPreviews}
            uploads={uploads}
            canAttach={Boolean(agent?.enableComputer)}
            attachHint={
              agent?.enableComputer
                ? "上传文件"
                : "需要开启电脑环境"
            }
            onAttachFiles={(files) => void handleAttachFiles(files)}
            onRemoveAttachment={removeAttachment}
            onCancelUpload={cancelUpload}
            skills={composerCap.skills}
            selectedSkills={selectedSkills}
            onToggleSkill={(name) =>
              setSelectedSkills((prev) =>
                prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name],
              )
            }
            toolGroups={composerCap.groups}
            disabledGroupIds={disabledGroupIds}
            onToggleGroup={(id) =>
              setDisabledGroupIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            models={modelItems}
            model={displayModel}
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
          projectPath={activeSession?.project ?? null}
          overlay={isMobile}
          onClose={() => setFilePanelOpen(false)}
        />
      )}

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">新建项目</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="np-name">名称</Label>
            <Input
              id="np-name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="my-app"
            />
            <Label htmlFor="np-git">Git 地址（可选）</Label>
            <Input
              id="np-git"
              value={newProjectGit}
              onChange={(e) => setNewProjectGit(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
            <p className="text-[11px] text-muted-foreground">
              会创建 /workspace/projects/名称；填写 Git 地址则克隆进去。
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setNewProjectOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submitNewProject()} disabled={newProjectBusy}>
              {newProjectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!configProject} onOpenChange={(open) => !open && setConfigProject(null)}>
        <DialogContent className="flex max-h-[min(90vh,44rem)] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">项目 · {configProject}</DialogTitle>
          </DialogHeader>
          {agentId && configProject ? (
            <ProjectConfigPanel
              agentId={agentId}
              slug={configProject}
              className="min-h-0 flex-1 overflow-y-auto pr-1"
            />
          ) : null}
        </DialogContent>
      </Dialog>

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
                <div className="min-w-0 space-y-0.5">
                  <Label>执行中发消息</Label>
                  <p className="text-xs text-muted-foreground">
                    {followUpMode === "steer" ? "下一工具后注入" : "结束后按序发送"}
                  </p>
                </div>
                <Select
                  value={followUpMode}
                  onValueChange={(v) => {
                    if (v !== "steer" && v !== "queue") return;
                    setFollowUpMode(v);
                    saveSettingsNow({ followUpMode: v });
                  }}
                  items={[
                    { value: "steer", label: "注入" },
                    { value: "queue", label: "排队" },
                  ]}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="steer">注入</SelectItem>
                    <SelectItem value="queue">排队</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
                    <Link href={`/dashboard/agents/${agentId}/overview`} />
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
