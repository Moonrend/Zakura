"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { chatSessionHref, shouldLetBrowserHandleClick } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronsUpDown,
  AlarmClock,
  FileClock,
  FolderKanban,
  FolderOpen,
  LayoutDashboard,
  ListFilter,
  PanelLeft,
  Search,
  Settings2,
  SquarePen,
  Square,
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
  DRAFT_CARET_CHANNEL,
  estimateEventPayloadTokens,
  estimateTextTokens,
  estimateTokensFromChars,
  ZAKURA_RUNTIME_ID,
  type AcpRuntimeState,
} from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { notifyAcpStartFailed } from "@/components/workspace-image-upgrade-dialog";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChatSettingsSheet } from "./chat-settings-sheet";
import { ChatSessionRow } from "./chat-session-row";
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
import { formatSize, fsUploadWithProgress, listAgentProjects, createAgentProject, deleteAgentProject, type AgentProject } from "@/lib/agent-fs";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { ChatMessages } from "./chat-messages";
import { MessageNavigator } from "./message-navigator";
import {
  Composer,
  type ComposerModelItem,
  type ComposerReasoningValue,
  type ComposerRemoteFlash,
  type PendingUpload,
  reasoningItemsFromLevels,
} from "./composer";
import { MessageQueue } from "./message-queue";
import type { ContextWindowInfo } from "./context-window";
import { FilePanel } from "./file-panel";
import { AutomationPanel } from "./automation-panel";
import { RunLogDrawer } from "./run-log-drawer";
import { ProjectListPane, ProjectSettingsPane, NewProjectFields } from "./project-pane";
import { SessionSearchDialog } from "./session-search-dialog";
import { PresenceAvatars } from "./presence-avatars";
import { ChatProjectRow } from "./chat-project-row";
import { FollowChip, PresencePointers } from "./presence-cursors";
import { UserAvatar } from "@/components/user-avatar";
import { useTenantPresence } from "@/lib/sync/presence";
import { useSessionDoc } from "@/lib/sync/session-doc";
import {
  activeSessionIds,
  othersOnProject,
  othersOnSession,
  normalizePresencePane,
  type PresenceLocation,
  type PresencePane,
} from "@zakura/shared";

import {
  AGENT_KEY,
  REASONING_KEY,
  DRAFT_KEY_PREFIX,
  kindsForSidebar,
  syncChatUrl,
  KIND_FILTER_OPTIONS,
  groupSessions,
  pinViewingSession,
  latestCompaction,
  latestMeasuredPromptTokens,
  buildContextWindowInfo,
} from "./chat-helpers";

function sameArr(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((x) => left.has(x));
}

function parsePrefList(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return undefined;
  }
}

export function ChatApp() {
  const { confirm } = useConfirmDialog();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [meUser, setMeUser] = useState<{
    id: string;
    name: string;
    email: string;
    avatarRev?: number;
  } | null>(null);
  const [pointerHost, setPointerHost] = useState<HTMLDivElement | null>(null);
  const [followUserId, setFollowUserId] = useState<string | null>(null);
  const [remoteFlash, setRemoteFlash] = useState<ComposerRemoteFlash>({});
  const bumpFlash = useCallback((keys: Array<keyof ComposerRemoteFlash>) => {
    if (keys.length === 0) return;
    setRemoteFlash((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = (prev[k] ?? 0) + 1;
      return next;
    });
  }, []);
  const liveRef = useRef({
    model: "",
    modelRouteId: null as string | null,
    reasoning: "default" as ComposerReasoningValue,
    runtimeId: ZAKURA_RUNTIME_ID,
    project: null as string | null,
    skills: [] as string[],
    groups: [] as string[],
    acpMode: undefined as string | undefined,
    acpModel: undefined as string | undefined,
    acpReasoning: undefined as string | undefined,
  });
  const prefsSeededKeyRef = useRef("");
  const lastFollowKeyRef = useRef("");
  const applyRemotePrefsRef = useRef<(prefs: Record<string, string>) => void>(() => {});
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectGit, setNewProjectGit] = useState("");
  const [newProjectWithWorkspace, setNewProjectWithWorkspace] = useState(false);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
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
  const [mainPane, setMainPane] = useState<"chat" | "files" | "tasks" | "projects" | "project-settings">(
    "chat",
  );
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  const [variantByMessage, setVariantByMessage] = useState<Record<string, string>>({});
  const [branchByParent, setBranchByParent] = useState<Record<string, string>>({});
  const [fileRequest, setFileRequest] = useState<{
    path: string;
    nonce: number;
    dir?: boolean;
  } | null>(null);
  const [collabFile, setCollabFile] = useState<{ path: string; dir?: boolean } | null>(
    null,
  );
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
  const [acpControlPending, setAcpControlPending] = useState<
    "mode" | "model" | "reasoning" | null
  >(null);
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
  const acpControlPendingRef = useRef(acpControlPending);
  acpControlPendingRef.current = acpControlPending;
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
  type EditStash = {
    input: string;
    attachments: CloudAgentAttachment[];
    previews: Record<string, string>;
    skills: string[];
  };
  const editStashRef = useRef<EditStash | null>(null);
  const [caretSnap, setCaretSnap] = useState(0);
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
  const eventsRef = useRef<CloudAgentEvent[]>([]);
  eventsRef.current = events;

  const isMobile = useIsMobile();
  const peers = useTenantPresence({
    userId: meUser?.id ?? null,
    agentId,
    project: activeProject,
    sessionId,
    pane: mainPane,
    filePath: mainPane === "files" ? (collabFile?.path ?? fileRequest?.path ?? null) : null,
    fileDir: mainPane === "files" ? Boolean(collabFile?.dir ?? fileRequest?.dir) : false,
  });
  const {
    bindValueChange,
    remotes,
    setPointer,
    setView,
    setPaused,
    setCaretChannel,
    ready: yjsReady,
    ui,
    setUiFlag,
    setPref,
    setPrefs,
    setPrefIfAbsent,
  } = useSessionDoc({
    agentId,
    sessionId,
    userId: meUser?.id ?? null,
    name: meUser?.name ?? "",
    textareaRef: composerRef,
    onValueChange: setInput,
    onPrefsChange: (prefs) => applyRemotePrefsRef.current(prefs),
  });
  applyRemotePrefsRef.current = (prefs) => {
    const live = liveRef.current;
    const seedKey = `${agentId ?? ""}:${sessionId ?? ""}`;
    const seeding = prefsSeededKeyRef.current !== seedKey;
    if (seeding) prefsSeededKeyRef.current = seedKey;
    const flashes: Array<keyof ComposerRemoteFlash> = [];
    if (typeof prefs.model === "string") {
      const nextRoute = prefs.modelRouteId || null;
      if (prefs.model !== live.model || nextRoute !== live.modelRouteId) {
        flashes.push("model");
        live.model = prefs.model;
        live.modelRouteId = nextRoute;
      }
      setModel(prefs.model);
      setModelRouteId(nextRoute);
    }
    if (typeof prefs.reasoning === "string" && prefs.reasoning) {
      if (prefs.reasoning !== live.reasoning) {
        flashes.push("reasoning");
        live.reasoning = prefs.reasoning as ComposerReasoningValue;
      }
      setReasoning(prefs.reasoning as ComposerReasoningValue);
    }
    const skills = parsePrefList(prefs.skills);
    if (skills) {
      if (!sameArr(skills, live.skills)) {
        flashes.push("extras");
        live.skills = skills;
      }
      setSelectedSkills(skills);
    }
    const groups = parsePrefList(prefs.disabledGroups);
    if (groups) {
      if (!sameArr(groups, live.groups)) {
        if (!flashes.includes("extras")) flashes.push("extras");
        live.groups = groups;
      }
      setDisabledGroupIds(groups);
    }
    if (prefs.pane) setMainPane(normalizePresencePane(prefs.pane));
    if (typeof prefs.filePath === "string" && prefs.filePath) {
      const dir = prefs.fileDir === "1";
      setCollabFile({ path: prefs.filePath, dir });
      setFileRequest((prev) => {
        if (prev?.path === prefs.filePath && Boolean(prev?.dir) === dir) return prev;
        fileNonceRef.current += 1;
        return { path: prefs.filePath, nonce: fileNonceRef.current, dir };
      });
    }
    if ("project" in prefs) {
      const p = prefs.project || null;
      if (p !== live.project) {
        flashes.push("project");
        live.project = p;
      }
      setDraftProject(p);
    }
    if (typeof prefs.runtimeId === "string" && prefs.runtimeId) {
      if (prefs.runtimeId !== live.runtimeId) {
        flashes.push("runtime");
        live.runtimeId = prefs.runtimeId;
      }
      setDraftRuntimeId(prefs.runtimeId);
    }
    if (!seeding) bumpFlash(flashes);
  };
  const goPane = useCallback(
    (next: PresencePane) => {
      setFollowUserId(null);
      setMainPane(next);
      setPref("pane", next);
    },
    [setPref],
  );
  const workingIds = useMemo(
    () => activeSessionIds(peers, meUser?.id ?? ""),
    [peers, meUser?.id],
  );
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
  const presenceTurns = useMemo(
    () =>
      turns.map((t) => ({
        seq: t.message.seq,
        messageId: t.message.id,
        parentKey: t.message.parentKey,
        runId: t.activeRunId,
        siblings: t.siblings,
        variants: t.variants,
      })),
    [turns],
  );
  useEffect(() => {
    setView(
      turns.map((t) => ({
        messageId: t.message.id,
        parentKey: t.message.parentKey,
        runId: t.activeRunId,
      })),
    );
  }, [setView, turns]);
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
  const listedForSidebar = useMemo(() => {
    const raw = activeProject
      ? sessions.filter(
          (s) => s.project === activeProject && (kindFilter === "all" || s.kind === kindFilter),
        )
      : sessions.filter(
          (s) => !s.project && (kindFilter === "all" || s.kind === kindFilter),
        );
    const viewing = sessionId ? sessions.find((s) => s.id === sessionId) : null;
    return pinViewingSession(raw, viewing);
  }, [activeProject, sessions, kindFilter, sessionId]);
  const projectRows = useMemo(() => {
    const by = new Map<string, CloudSession[]>();
    for (const s of sessions) {
      if (!s.project) continue;
      const list = by.get(s.project) ?? [];
      list.push(s);
      by.set(s.project, list);
    }
    const slugs = new Set([...projects.map((p) => p.slug), ...by.keys()]);
    return [...slugs]
      .sort((a, b) => {
        const an = projects.find((p) => p.slug === a)?.name ?? a;
        const bn = projects.find((p) => p.slug === b)?.name ?? b;
        return an.localeCompare(bn);
      })
      .map((slug) => {
        const rec = projects.find((p) => p.slug === slug);
        return {
          slug,
          name: rec?.name ?? slug,
          missing: !rec,
          sessions: by.get(slug) ?? [],
        };
      });
  }, [projects, sessions]);
  const listedProjects = useMemo(() => {
    const have = new Set(projects.map((p) => p.slug));
    const extra: AgentProject[] = projectRows
      .filter((r) => !have.has(r.slug))
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        description: "",
        instructions: "",
        hasWorkspace: false,
        path: null,
      }));
    return [...projects, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, projectRows]);
  const sessionCountBySlug = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of projectRows) m.set(row.slug, row.sessions.length);
    return m;
  }, [projectRows]);
  const activeProjectRow = activeProject
    ? (projectRows.find((r) => r.slug === activeProject) ?? null)
    : null;
  const settingsProjectRec = settingsProject
    ? (listedProjects.find((p) => p.slug === settingsProject) ?? null)
    : null;
  const sidebarSessions = useMemo(
    () => groupSessions(listedForSidebar, workingIds),
    [listedForSidebar, workingIds],
  );
  const peersByProject = useMemo(() => {
    const m = new Map<string, PresenceLocation[]>();
    const self = meUser?.id ?? "";
    for (const row of projectRows) m.set(row.slug, othersOnProject(peers, row.slug, self));
    return m;
  }, [meUser?.id, peers, projectRows]);
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
  liveRef.current = {
    model,
    modelRouteId,
    reasoning,
    runtimeId: draftRuntimeId,
    project: sessionProject,
    skills: selectedSkills,
    groups: disabledGroupIds,
    acpMode: acpRuntime?.modes?.currentId,
    acpModel: acpRuntime?.models?.currentId,
    acpReasoning: acpRuntime?.reasoning?.current,
  };
  useEffect(() => {
    setRemoteFlash({});
    prefsSeededKeyRef.current = "";
  }, [agentId, sessionId]);
  useEffect(() => {
    if (!yjsReady) return;
    const patch: Record<string, string> = {
      reasoning,
      runtimeId: draftRuntimeId,
      skills: JSON.stringify(selectedSkills),
      disabledGroups: JSON.stringify(disabledGroupIds),
      pane: mainPane,
    };
    if (model) patch.model = model;
    if (modelRouteId) patch.modelRouteId = modelRouteId;
    if (collabFile?.path) {
      patch.filePath = collabFile.path;
      if (collabFile.dir) patch.fileDir = "1";
    }
    if (sessionProject) patch.project = sessionProject;
    setPrefIfAbsent(patch);
    // 只在接入文档时填空，避免把本地默认值盖到对端已写入的键上
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yjsReady, sessionId]);
  const {
    scrollRef,
    contentRef,
    scrollEl,
    atBottom,
    scrollToBottom,
    sync: syncScroll,
  } = useStickToBottom<HTMLDivElement, HTMLDivElement>(140, Boolean(followUserId));

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
                    const me = await api<{
                      user: { id: string; name?: string | null; email: string; avatarRev?: number };
                    }>("/api/me");
                    setMeUser({
                      id: me.user.id,
                      name: me.user.name?.trim() || me.user.email,
                      email: me.user.email,
                      avatarRev: me.user.avatarRev ?? 0,
                    });
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
          if (!acpControlPendingRef.current) {
            const live = liveRef.current;
            const flashes: Array<keyof ComposerRemoteFlash> = [];
            if (p.acpModels?.currentId && p.acpModels.currentId !== live.acpModel) {
              flashes.push("acpModel");
              live.acpModel = p.acpModels.currentId;
            }
            if (p.acpReasoning?.current && p.acpReasoning.current !== live.acpReasoning) {
              flashes.push("acpReasoning");
              live.acpReasoning = p.acpReasoning.current;
            }
            const nextMode = p.acpModes?.currentId ?? p.acpModeId;
            if (nextMode && nextMode !== live.acpMode) {
              flashes.push("acpMode");
              live.acpMode = nextMode;
            }
            bumpFlash(flashes);
          }
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
    [refreshSessions, bumpFlash],
  );

  const loadSessionInner = useCallback(
    async (aid: string, sid: string, requestId: number) => {
      const res = await getCloudSession(aid, sid, 0);
      if (requestId !== pendingSessionRequestRef.current) return;
      const prevSid = sessionIdRef.current;
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
      if (prevSid === sid) {
        const stash = editStashRef.current;
        editStashRef.current = null;
        setPaused(false);
        setCaretChannel(DRAFT_CARET_CHANNEL);
        if (stash) {
          setAttachments(stash.attachments);
          previewsRef.current = stash.previews;
          setAttachmentPreviews({ ...stash.previews });
          setSelectedSkills(stash.skills);
        }
      }
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
    [setPaused, setCaretChannel],
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
      setMainPane("chat");
      try {
        await loadSessionInner(aid, sid, requestId);
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

  const ensureSeqLoaded = useCallback(async (seq: number) => {
    if (eventsRef.current.some((e) => e.seq === seq)) return true;
    const aid = agentId;
    const sid = sessionIdRef.current;
    if (!aid || !sid || seq < 1) return false;
    try {
      const res = await getCloudSession(aid, sid, { aroundSeq: seq });
      if (res.events.length === 0) return false;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const extra = res.events.filter((e) => !seen.has(e.seq));
        if (extra.length === 0) return prev;
        const merged = [...prev, ...extra].sort((a, b) => a.seq - b.seq);
        oldestSeqRef.current = merged[0]?.seq ?? oldestSeqRef.current;
        return merged;
      });
      if (res.hasMore) {
        hasMoreHistoryRef.current = true;
        setHasMoreHistory(true);
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "无法定位协同位置");
      return false;
    }
  }, [agentId]);

  const applyPeerLocation = useCallback(
    (peer: PresenceLocation, force = false) => {
      const key = [
        peer.agentId ?? "",
        peer.sessionId ?? "",
        peer.project ?? "",
        peer.pane,
        peer.filePath ?? "",
        peer.fileDir ? "1" : "0",
      ].join("|");
      if (!force && key === lastFollowKeyRef.current) return;
      lastFollowKeyRef.current = key;
      setMainPane(peer.pane);
      setActiveProject(peer.project);
      if (peer.pane === "files" && peer.filePath) {
        const dir = Boolean(peer.fileDir);
        setCollabFile({ path: peer.filePath, dir });
        setFileRequest((prev) => {
          if (prev?.path === peer.filePath && Boolean(prev?.dir) === dir) return prev;
          fileNonceRef.current += 1;
          return { path: peer.filePath!, nonce: fileNonceRef.current, dir };
        });
      }
      if (!peer.sessionId || !peer.agentId) return;
      if (peer.agentId === agentId) {
        if (peer.sessionId !== sessionId) void loadSession(peer.agentId, peer.sessionId);
        return;
      }
      pendingSessionRef.current = { agentId: peer.agentId, sessionId: peer.sessionId };
      setAgentId(peer.agentId);
    },
    [agentId, loadSession, sessionId],
  );

  const goToPeer = useCallback(
    (userId: string) => {
      const peer = peers.find((p) => p.userId === userId);
      if (!peer) return;
      closeNavOnMobile();
      setFollowUserId(userId);
      lastFollowKeyRef.current = "";
      applyPeerLocation(peer, true);
    },
    [applyPeerLocation, closeNavOnMobile, peers],
  );

  useEffect(() => {
    if (!followUserId) {
      lastFollowKeyRef.current = "";
      return;
    }
    const peer = peers.find((p) => p.userId === followUserId);
    if (!peer || peer.idle) return;
    applyPeerLocation(peer);
  }, [applyPeerLocation, followUserId, peers]);

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
    const unfollowIfUser = () => {
      if (followUserId) setFollowUserId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!followUserId) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End") {
        unfollowIfUser();
      }
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    scrollEl.addEventListener("wheel", unfollowIfUser, { passive: true });
    scrollEl.addEventListener("touchmove", unfollowIfUser, { passive: true });
    scrollEl.addEventListener("keydown", onKey);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      scrollEl.removeEventListener("wheel", unfollowIfUser);
      scrollEl.removeEventListener("touchmove", unfollowIfUser);
      scrollEl.removeEventListener("keydown", onKey);
    };
  }, [scrollEl, loadOlderMessages, followUserId]);

  useEffect(() => {
    if (!followUserId) return;
    const r = remotes.find((x) => x.user.id === followUserId);
    const ptr = r?.pointer;
    if (!ptr || !scrollEl) return;
    if (ptr.seq < 1) return;
    let cancelled = false;
    void (async () => {
      const ok = await ensureSeqLoaded(ptr.seq);
      if (!ok || cancelled) return;
      const el = scrollEl.querySelector(`[data-turn-seq="${ptr.seq}"]`);
      if (!(el instanceof HTMLElement)) return;
      const box = el.getBoundingClientRect();
      const host = scrollEl.getBoundingClientRect();
      scrollEl.scrollTop += box.top - host.top + ptr.y * box.height - host.height * 0.35;
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSeqLoaded, followUserId, remotes, scrollEl]);

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
        setActiveProject(null);
        setSettingsProject(null);
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
        bindValueChange("");
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
          void refreshSessions().then((list) => {
            const cur = list.find((s) => s.id === sessionIdRef.current);
            if (!cur) return;
            const live = liveRef.current;
            const flashes: Array<keyof ComposerRemoteFlash> = [];
            if (cur.kind !== "acp") {
              if (cur.model) {
                if (cur.model !== live.model || cur.modelRouteId !== live.modelRouteId) {
                  flashes.push("model");
                  live.model = cur.model;
                  live.modelRouteId = cur.modelRouteId;
                }
                setModel(cur.model);
                setModelRouteId(cur.modelRouteId);
              }
            }
            if (cur.reasoning) {
              if (cur.reasoning !== live.reasoning) {
                flashes.push("reasoning");
                live.reasoning = cur.reasoning as ComposerReasoningValue;
              }
              setReasoning(cur.reasoning as ComposerReasoningValue);
            }
            if (sessionIdRef.current === cur.id) {
              const nextProject = cur.project ?? null;
              if (nextProject !== live.project) {
                flashes.push("project");
                live.project = nextProject;
              }
              setDraftProject(nextProject);
            }
            bumpFlash(flashes);
          });
        }
        if (ev.type === "agent_fs_changed" && ev.agentId === agentId) {
          if (ev.path === "/projects" || ev.path.startsWith("/projects/")) {
            void refreshProjects();
          }
        }
        if (ev.type === "agent_config_changed" && ev.agentId === agentId) {
          void getCloudConfig(agentId)
            .then((cfg) => {
              setHasChatRoute(cfg.hasChatRoute);
              setSystemPrompt(cfg.cloud.systemPrompt ?? "");
              agentDefaultsRef.current = {
                model: cfg.cloud.model ?? "",
                modelRouteId: cfg.cloud.modelRouteId ?? null,
              };
              if (!sessionIdRef.current) {
                const nextModel = cfg.cloud.model ?? "";
                const nextRoute = cfg.cloud.modelRouteId ?? null;
                const live = liveRef.current;
                if (nextModel !== live.model || nextRoute !== live.modelRouteId) {
                  live.model = nextModel;
                  live.modelRouteId = nextRoute;
                  bumpFlash(["model"]);
                }
                setModel(nextModel);
                setModelRouteId(nextRoute);
              }
              setEnableTools(cfg.cloud.enableTools !== false);
              setAutoMemory(cfg.cloud.autoMemory !== false);
              setAutoTitle(cfg.cloud.autoTitle !== false);
              setFollowUpMode(cfg.cloud.followUpMode === "queue" ? "queue" : "steer");
              setMaxSubagentDepth(String(cfg.cloud.maxSubagentDepth ?? 2));
            })
            .catch(() => {});
        }
      },
      () => {
        void refreshSessions();
        void refreshProjects();
        void getCloudConfig(agentId)
          .then((cfg) => {
            setHasChatRoute(cfg.hasChatRoute);
            setSystemPrompt(cfg.cloud.systemPrompt ?? "");
            agentDefaultsRef.current = {
              model: cfg.cloud.model ?? "",
              modelRouteId: cfg.cloud.modelRouteId ?? null,
            };
            if (!sessionIdRef.current) {
              setModel(cfg.cloud.model ?? "");
              setModelRouteId(cfg.cloud.modelRouteId ?? null);
            }
            setEnableTools(cfg.cloud.enableTools !== false);
            setAutoMemory(cfg.cloud.autoMemory !== false);
            setAutoTitle(cfg.cloud.autoTitle !== false);
            setFollowUpMode(cfg.cloud.followUpMode === "queue" ? "queue" : "steer");
            setMaxSubagentDepth(String(cfg.cloud.maxSubagentDepth ?? 2));
          })
          .catch(() => {});
      },
    );
  }, [agentId, authed, refreshSessions, refreshProjects, bumpFlash]);

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

  useLayoutEffect(() => {
    if (caretSnap === 0) return;
    const el = composerRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const n = el.value.length;
    el.setSelectionRange(n, n);
    el.scrollTop = el.scrollHeight;
  }, [caretSnap]);

  // 草稿即时落本地，随后同步到服务端，保证刷新和多设备打开都能恢复。
  useEffect(() => {
    if (!agentId) return;
    const expectedKey = sessionId ?? "__new__";
    // 会话刚切换但恢复 effect 尚未执行时，不能把旧会话的输入写到新 key。
    if (draftKeyRef.current !== expectedKey) return;
    const persistText = editStashRef.current?.input ?? input;
    const key = `${DRAFT_KEY_PREFIX}:${agentId}:${draftKeyRef.current}`;
    try {
      if (persistText) localStorage.setItem(key, persistText);
      else localStorage.removeItem(key);
    } catch {
      // 存储空间不足时，服务端同步仍然继续。
    }
    // sessionId 变化时，恢复 effect 还需要先切换 draftKey，避免把旧输入短暂写进新会话。
    if (!sessionId) return;
    if (yjsReady) return;
    const timer = window.setTimeout(() => {
      void updateCloudSession(agentId, sessionId, { draftText: persistText }).catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [agentId, input, sessionId, yjsReady, editingTarget]);

  useEffect(() => {
    if (!sessionId) return;
    setDraftProject(activeSession?.project ?? null);
  }, [sessionId, activeSession?.project]);

  // 切换会话时把当前草稿存起来，并恢复目标会话的草稿
  useEffect(() => {
    const nextKey = sessionId ?? "__new__";
    if (draftKeyRef.current === nextKey) return;
    const stash = editStashRef.current;
    const pending = stash ? stash.input : latestInputRef.current;
    if (pending.trim()) draftsRef.current.set(draftKeyRef.current, pending);
    else draftsRef.current.delete(draftKeyRef.current);
    if (stash) {
      editStashRef.current = null;
      setPaused(false);
      setCaretChannel(DRAFT_CARET_CHANNEL);
      setEditingTarget(null);
    }
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
  }, [agentId, sessionId, setPaused, setCaretChannel]);

  // 卸载时释放尚未发送的图片预览地址
  useEffect(() => {
    const previews = previewsRef;
    return () => {
      for (const url of Object.values(previews.current)) URL.revokeObjectURL(url);
      previews.current = {};
    };
  }, []);

  // —— 搜索弹框：⌘K / Ctrl+K ——
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openSearchHit(hit: CloudSearchHit) {
    setActiveProject(hit.project ?? null);
    setDraftProject(hit.project ?? null);
    setMainPane("chat");
    if (hit.agentId !== agentId) {
      pendingSessionRef.current = { agentId: hit.agentId, sessionId: hit.id };
      setAgentId(hit.agentId);
    } else {
      await loadSession(hit.agentId, hit.id);
    }
  }

  /** 进入「新对话」草稿态：不落库，发消息时再创建会话 */
  function handleNewSession(project: string | null = activeProject) {
    if (!agentId) return;
    const sid = sessionIdRef.current;
    const current = sessions.find((s) => s.id === sid);
    // prepareAcpDraft 预创建的会话若始终没有发过消息，视为未使用直接删掉，
    // 避免侧栏堆积一堆「ACP · xxx」空会话。
    if (sid && current?.kind === "acp" && !events.some((e) => e.type === "user_message")) {
      void discardUnusedAcpDraft(agentId, sid);
    }
    pendingSessionRequestRef.current += 1;
    setPendingSessionId(null);
    setAcpPreparingProfileId(null);
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
    setDraftProject(project);
    clearAttachments();
    setSelectedSkills([]);
    setMainPane("chat");
    composerRef.current?.focus();
  }

  function enterProject(slug: string) {
    setActiveProject(slug);
    const current = sessions.find((s) => s.id === sessionId);
    if (!current || current.project !== slug) {
      handleNewSession(slug);
    } else {
      setDraftProject(slug);
      setMainPane("chat");
    }
  }

  function leaveProject() {
    setActiveProject(null);
    const current = sessions.find((s) => s.id === sessionId);
    if (!current) setDraftProject(null);
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
        ? `当前项目：${projects.map((p) => `${p.name}（${p.slug}）`).join("、")}`
        : "还没有项目时，可先在主页创建项目。写文件的任务再绑有工作区的项目。",
      "",
      goal.trim(),
    ].join("\n");
    setMainPane("chat");
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
        bindValueChange("");
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
    const current = sessions.find((s) => s.id === sid);
    if (current?.title === title) return;
    try {
      const updated = await updateCloudSession(agentId, sid, { title });
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, ...updated } : s)));
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
    setActiveProject(next);
    liveRef.current.project = next;
    setPref("project", next ?? "");
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
        description: newProjectDesc.trim() || undefined,
        withWorkspace: newProjectWithWorkspace || Boolean(newProjectGit.trim()),
        ...(newProjectGit.trim() ? { gitUrl: newProjectGit.trim() } : {}),
      });
      if (res.cloneError) toast.error(`项目已创建，克隆失败：${res.cloneError}`);
      else toast.success("已创建项目");
      setNewProjectOpen(false);
      setNewProjectName("");
      setNewProjectDesc("");
      setNewProjectGit("");
      setNewProjectWithWorkspace(false);
      await refreshProjects();
      enterProject(res.project.slug);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setNewProjectBusy(false);
    }
  }

  async function handleDeleteProject(slug: string) {
    if (!agentId) return;
    const rec = projects.find((p) => p.slug === slug);
    const ok = await confirm({
      title: `删除项目 ${rec?.name ?? slug}？`,
      description: rec?.hasWorkspace
        ? `将删除项目记录和工作区目录 ${rec.path}。该项目下的对话（含子代理）和定时任务会解绑，不会被删掉。`
        : "将删除项目记录。该项目下的对话（含子代理）和定时任务会解绑，不会被删掉。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentProject(agentId, slug);
      setProjects((prev) => prev.filter((p) => p.slug !== slug));
      setSessions((prev) => prev.map((s) => (s.project === slug ? { ...s, project: null } : s)));
      if (activeProject === slug) setActiveProject(null);
      if (settingsProject === slug) {
        setSettingsProject(null);
        setMainPane("projects");
      }
      toast.success("已删除项目");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function openProjectDir(slug: string) {
    goPane("files");
    fileNonceRef.current += 1;
    const path = `/projects/${slug}`;
    setFileRequest({ path, nonce: fileNonceRef.current, dir: true });
    setCollabFile({ path, dir: true });
    setPref("filePath", path);
    setPref("fileDir", "1");
  }

  function parentForSend(): string | null | undefined {
    const last = turns[turns.length - 1];
    if (!last) return null;
    return last.activeRunId ?? undefined;
  }

  /** 稳定引用：工具行会以它作为 memo 依赖，重建会让缓存全部失效 */
  const openFileInPanel = useCallback((path: string) => {
    goPane("files");
    fileNonceRef.current += 1;
    setFileRequest({ path, nonce: fileNonceRef.current });
    setCollabFile({ path, dir: false });
    setPref("filePath", path);
    setPref("fileDir", "");
  }, [goPane, setPref]);

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
    if (editingTarget) {
      toast.error("正在编辑历史消息，先发送或取消后再改排队消息");
      return;
    }
    if (latestInputRef.current.trim() || attachments.length > 0) {
      toast.error("输入框还有未发送的内容，先发送或清空后再编辑排队消息");
      return;
    }
    setQueue((prev) => prev.filter((m) => m.messageId !== messageId));
    bindValueChange(item.content);
    latestInputRef.current = item.content;
    if (item.attachments?.length) setAttachments(item.attachments);
    void removeQueuedMessage(aid, sid, messageId).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
    setCaretSnap((n) => n + 1);
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

  function leaveEditMode(restore: boolean) {
    const stash = editStashRef.current;
    editStashRef.current = null;
    setCaretChannel(DRAFT_CARET_CHANNEL);
    setPaused(false);
    setEditingTarget(null);
    if (!restore || !stash) return;
    setAttachments(stash.attachments);
    previewsRef.current = stash.previews;
    setAttachmentPreviews({ ...stash.previews });
    setSelectedSkills(stash.skills);
  }

  /**
   * 编辑已发送消息：召回 Composer（复用附件/换行/模型选项等完整能力）。
   * 原消息不删除 —— 发送后按 parentKey 成为兄弟分支变体。
   * 草稿留在 Yjs 里，不覆盖其他人正在输入的内容。
   */
  function handleEditStart(
    messageId: string,
    parentKey: string,
    content: string,
    msgAttachments: CloudAgentAttachment[],
  ) {
    if (runActive) return;
    if (!editStashRef.current) {
      editStashRef.current = {
        input: latestInputRef.current,
        attachments: attachments,
        previews: { ...previewsRef.current },
        skills: selectedSkills,
      };
    }
    setPaused(true);
    setCaretChannel(`edit:${messageId}`);
    setEditingTarget({ messageId, parentKey });
    setInput(content);
    latestInputRef.current = content;
    setAttachments(msgAttachments);
    setSelectedSkills([]);
    setCaretSnap((n) => n + 1);
  }

  /** 取消编辑：恢复进入前的草稿，不写空进协同文档 */
  function handleEditCancel() {
    leaveEditMode(true);
    setCaretSnap((n) => n + 1);
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
      bindValueChange(content);
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

    // 编辑态：不追加新回合，而是按 parentKey 建分支变体；草稿仍留在协同文档里
    const editing = editingTarget;
    if (editing) {
      leaveEditMode(true);
      sendChainRef.current = sendChainRef.current
        .catch(() => {})
        .then(() => handleEditSend(editing.parentKey, content, sentAttachments));
      return;
    }

    bindValueChange("");
    latestInputRef.current = "";
    draftsRef.current.delete(draftKeyRef.current);
    previewsRef.current = {};
    setAttachmentPreviews({});
    setAttachments([]);
    setSelectedSkills([]);

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
    liveRef.current.model = value;
    liveRef.current.modelRouteId = routeId;
    setPrefs({
      model: value,
      modelRouteId: routeId || "",
    });
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
    liveRef.current.reasoning = value;
    setPref("reasoning", value);
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
    if (reasoningItems.length === 0) return;
    if (!reasoningItems.some((item) => item.value === reasoning)) {
      // 只改本地展示：对端改模型时本端列表会短暂对不上，写回会把对端的思考等级打掉
      setReasoning("default");
    }
  }, [reasoning, reasoningItems]);

  if (!authed) {
    return <PageLoading />;
  }

  /** 侧边栏会话行：把 ChatApp 的状态与操作绑到独立的展示组件上 */
  function sessionRow(s: CloudSession) {
    return (
      <ChatSessionRow
        key={s.id}
        session={s}
        agentId={agentId}
        sessionId={sessionId}
        pendingSessionId={pendingSessionId}
        acpRuntimes={acpRuntimes}
        projects={projects}
        renamingId={renamingId}
        renameValue={renameValue}
        onRenameValueChange={setRenameValue}
        onRenamingIdChange={setRenamingId}
        onCommitRename={commitRename}
        onLoadSession={loadSession}
        onCloseNav={closeNavOnMobile}
        onFork={handleForkSession}
        onMove={handleMoveSession}
        onArchive={handleArchiveSession}
        onDelete={handleDeleteSession}
        peers={othersOnSession(peers, s.id, meUser?.id ?? "")}
        onPickUser={goToPeer}
        listProject={activeProject}
      />
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
          "chat-sidebar flex h-full shrink-0 flex-col border-r border-border/40",
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
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-foreground">
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
                    setFollowUserId(null);
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

        {/* 新对话 + 搜索 */}
        <div className="flex flex-col gap-1 p-2">
          {activeProject ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={leaveProject}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">
                  {activeProjectRow?.name ?? activeProject}
                </span>
              </button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="项目设置"
                className="shrink-0 text-muted-foreground"
                onClick={() => {
                  setSettingsProject(activeProject);
                  goPane("project-settings");
                }}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              handleNewSession(activeProject);
              closeNavOnMobile();
            }}
            className={cn(
              "press group/new flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ease-fluid",
              sessionId === null
                ? "text-foreground"
                : "text-foreground/80 hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <SquarePen className="h-4 w-4 transition-transform duration-300 ease-overshoot group-hover/new:-rotate-12" />
            新对话
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">搜索对话</span>
              <kbd className="hidden shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground/80 md:inline">
                {typeof navigator !== "undefined" && /Mac|iPhone/.test(navigator.userAgent)
                  ? "⌘K"
                  : "Ctrl+K"}
              </kbd>
            </button>
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

        {/* 会话列表 */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-2 pt-0">
            {sidebarSessions.length === 0 && (activeProject || projectRows.length === 0) ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {activeProject ? "这个项目还没有对话" : "还没有对话"}
              </div>
            ) : (
              <>
                {!activeProject && projectRows.length > 0 ? (
                  <div>
                    <div className="px-2 pb-0.5 pt-1 text-[11px] text-muted-foreground/60">
                      项目
                    </div>
                    <div className="flex flex-col">
                      {projectRows.map((row) => (
                        <ChatProjectRow
                          key={row.slug}
                          slug={row.slug}
                          name={row.name}
                          sessionCount={row.sessions.length}
                          peers={othersOnProject(peers, row.slug, meUser?.id ?? "")}
                          onOpen={enterProject}
                          onPickUser={goToPeer}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {sidebarSessions.map((g) => (
                <div key={g.label}>
                  <div className="px-2 pb-0.5 pt-1 text-[11px] text-muted-foreground/60">
                    {g.label}
                  </div>
                  <div className="flex flex-col">{g.items.map((s) => sessionRow(s))}</div>
                </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>

        {/* 底部 */}
        <div className="border-t border-sidebar-border p-2">
          {meUser ? (
            <Link
              href="/dashboard/settings/account"
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground/80 hover:bg-muted/40 hover:text-foreground"
            >
              <UserAvatar
                userId={meUser.id}
                name={meUser.name}
                email={meUser.email}
                avatarRev={meUser.avatarRev}
                size="sm"
                className="size-6"
              />
              <span className="min-w-0 flex-1 truncate">{meUser.name}</span>
            </Link>
          ) : null}
          <Link
            href="/dashboard/agents"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <LayoutDashboard className="h-4 w-4" />
            控制台
          </Link>
        </div>
      </aside>

      {/* ===== 主区 ===== */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {mainPane === "chat" ? (
          <MessageNavigator turns={turns} scrollEl={scrollEl ?? null} />
        ) : null}
        <header className="flex h-11 shrink-0 items-center gap-1.5 px-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="侧边栏"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-0 truncate text-sm text-foreground/90">
            {mainPane === "files"
              ? "文件"
              : mainPane === "tasks"
                ? "任务"
                : mainPane === "projects"
                  ? "项目"
                  : mainPane === "project-settings"
                    ? (settingsProjectRec?.name ?? "项目设置")
                    : activeProjectRow
                      ? `${agent?.name ?? ""} · ${activeProjectRow.name}`
                      : agent?.name}
          </span>
          {followUserId ? (
            <FollowChip
              userId={followUserId}
              name={peers.find((p) => p.userId === followUserId)?.name ?? remotes.find((r) => r.user.id === followUserId)?.user.name ?? "成员"}
              onStop={() => setFollowUserId(null)}
            />
          ) : null}
          <PresenceAvatars
            peers={othersOnSession(peers, sessionId, meUser?.id ?? "")}
            onPick={(id) => {
              if (followUserId === id) setFollowUserId(null);
              else goToPeer(id);
            }}
          />
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
          {runActive && mainPane === "chat" && (
            <Button size="sm" variant="ghost" onClick={() => void handleCancel()}>
              <Square className="h-3.5 w-3.5" />
              停止
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="项目"
            className={cn(
              (mainPane === "projects" || mainPane === "project-settings" || activeProject) &&
                "bg-muted text-foreground",
            )}
            onClick={() => {
              setSettingsProject(null);
              goPane(mainPane === "projects" ? "chat" : "projects");
            }}
          >
            <FolderKanban className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="文件"
            className={cn(mainPane === "files" && "bg-muted text-foreground")}
            onClick={() => goPane(mainPane === "files" ? "chat" : "files")}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="任务"
            className={cn(mainPane === "tasks" && "bg-muted text-foreground")}
            onClick={() => goPane(mainPane === "tasks" ? "chat" : "tasks")}
          >
            <AlarmClock className="h-4 w-4" />
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
          ref={setPointerHost}
          className={cn("relative flex min-h-0 flex-1 flex-col", mainPane !== "chat" && "hidden")}
          onPointerMove={(e) => {
            if (document.visibilityState !== "visible") {
              setPointer(null);
              return;
            }
            const host = e.currentTarget;
            const turn = (e.target as HTMLElement | null)?.closest?.("[data-turn-seq]");
            if (turn instanceof HTMLElement && host.contains(turn)) {
              const seq = Number(turn.getAttribute("data-turn-seq"));
              if (!Number.isFinite(seq)) return;
              const box = turn.getBoundingClientRect();
              const x = box.width <= 0 ? 0 : (e.clientX - box.left) / box.width;
              const y = box.height <= 0 ? 0 : (e.clientY - box.top) / box.height;
              setPointer({
                seq,
                x: Math.min(1, Math.max(0, x)),
                y: Math.min(1, Math.max(0, y)),
              });
              return;
            }
            const box = host.getBoundingClientRect();
            const x = box.width <= 0 ? 0 : (e.clientX - box.left) / box.width;
            const y = box.height <= 0 ? 0 : (e.clientY - box.top) / box.height;
            setPointer({
              seq: 0,
              x: Math.min(1, Math.max(0, x)),
              y: Math.min(1, Math.max(0, y)),
            });
          }}
          onPointerLeave={() => setPointer(null)}
        >
          <PresencePointers remotes={remotes} followUserId={followUserId} container={pointerHost} turns={presenceTurns} />

        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
              ui={ui}
              setUiFlag={setUiFlag}
              remotes={remotes}
              peers={peers}
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
              className="animate-pop absolute top-0 left-1/2 z-10 h-auto -translate-x-1/2 -translate-y-[calc(100%+0.375rem)] gap-1 rounded-lg border-border/50 bg-background/90 px-3 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              <ArrowDown className="size-3.5" />
              回到底部
            </Button>
          )}
          <Composer
            value={input}
            onValueChange={bindValueChange}
            remotes={remotes}
            remoteFlash={remoteFlash}
            caretChannel={
              editingTarget ? `edit:${editingTarget.messageId}` : DRAFT_CARET_CHANNEL
            }
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
              Boolean(acpPreparingProfileId)
              || acpRuntime?.state === "starting"
              || Boolean(acpControlPending)
            }
            runtimeDisabledHint={
              acpPreparingProfileId
                ? "正在启动 Agent…"
                : "对话已绑定执行方，不能切换；请新建对话后再选"
            }
            projects={projects.map((p) => p.slug)}
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
                liveRef.current.runtimeId = id;
                setPref("runtimeId", id);
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
                    setPref("runtimeId", id);
                  } catch (err) {
                    setDraftRuntimeId(ZAKURA_RUNTIME_ID);
                    liveRef.current.runtimeId = ZAKURA_RUNTIME_ID;
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
            acpControlPending={acpControlPending}
            onAcpModeChange={(modeId) => {
              if (!agentId || !sessionId || acpControlPending) return;
              liveRef.current.acpMode = modeId;
              setAcpControlPending("mode");
              void setAcpMode(agentId, sessionId, modeId)
                .then((status) => {
                  setAcpRuntime((prev) => ({
                    ...prev,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                  }));
                  toast.success("Agent 模式已切换");
                })
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
                .finally(() => setAcpControlPending(null));
            }}
            onAcpModelChange={(modelId) => {
              if (!agentId || !sessionId || acpControlPending) return;
              liveRef.current.acpModel = modelId;
              setAcpControlPending("model");
              void setAcpModel(agentId, sessionId, modelId)
                .then((status) => {
                  setAcpRuntime((prev) => ({
                    ...prev,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                  }));
                  toast.success(
                    status.modelChange === "restart"
                      ? "模型已切换，Agent 已自动重启并创建新会话"
                      : "模型已切换",
                  );
                })
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
                .finally(() => setAcpControlPending(null));
            }}
            onAcpReasoningChange={(value) => {
              if (!agentId || !sessionId || acpControlPending) return;
              const configId = acpRuntime?.reasoning?.configId;
              if (!configId) return;
              liveRef.current.acpReasoning = value;
              setAcpControlPending("reasoning");
              void setAcpConfigOption(agentId, sessionId, configId, value)
                .then((status) => {
                  setAcpRuntime((prev) => ({
                    ...prev,
                    models: status.models ?? prev?.models,
                    reasoning: status.reasoning ?? prev?.reasoning,
                    modes: status.modes ?? prev?.modes,
                    availableCommands: status.availableCommands ?? prev?.availableCommands,
                  }));
                  toast.success("思考强度已更新");
                })
                .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
                .finally(() => setAcpControlPending(null));
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
              setSelectedSkills((prev) => {
                const next = prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name];
                liveRef.current.skills = next;
                setPref("skills", JSON.stringify(next));
                return next;
              })
            }
            toolGroups={composerCap.groups}
            disabledGroupIds={disabledGroupIds}
            onToggleGroup={(id) =>
              setDisabledGroupIds((prev) => {
                const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
                liveRef.current.groups = next;
                setPref("disabledGroups", JSON.stringify(next));
                return next;
              })
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

      {agentId && mainPane === "files" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <FilePanel
            agentId={agentId}
            fsEnabled={Boolean(agent?.enableComputer)}
            openRequest={fileRequest}
            projectPath={activeSession?.project ?? null}
            layout="page"
            onClose={() => goPane("chat")}
            onOpenPath={(path, dir) => {
              setCollabFile(path ? { path, dir } : null);
              setPref("filePath", path);
              setPref("fileDir", dir ? "1" : "");
              setPref("pane", "files");
            }}
          />
        </div>
      ) : null}

      {mainPane === "tasks" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <AutomationPanel
            agentId={agentId}
            projects={projects.map((p) => p.slug)}
            layout="page"
            className="h-full"
            onAskAgentCreate={(goal) => {
              goPane("chat");
              handleAskAgentCreateSchedule(goal);
            }}
            onOpenSession={(sid) => {
              if (!agentId) return;
              goPane("chat");
              setKindFilter("system");
              void loadSession(agentId, sid);
              closeNavOnMobile();
            }}
          />
        </div>
      ) : null}

      {mainPane === "projects" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProjectListPane
            projects={listedProjects}
            sessionCountBySlug={sessionCountBySlug}
            onOpen={(slug) => {
              enterProject(slug);
              closeNavOnMobile();
            }}
            onSettings={(slug) => {
              setSettingsProject(slug);
              goPane("project-settings");
            }}
            onCreate={() => setNewProjectOpen(true)}
            peersByProject={peersByProject}
            onPickUser={goToPeer}
          />
        </div>
      ) : null}

      {mainPane === "project-settings" && agentId && settingsProjectRec ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProjectSettingsPane
            agentId={agentId}
            project={settingsProjectRec}
            onSaved={(next) => {
              setProjects((prev) =>
                prev
                  .map((p) => (p.slug === settingsProjectRec.slug ? next : p))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              );
              if (settingsProject !== next.slug) setSettingsProject(next.slug);
              if (activeProject === settingsProjectRec.slug) setActiveProject(next.slug);
            }}
            onOpenDir={openProjectDir}
            onDelete={(slug) => void handleDeleteProject(slug)}
          />
        </div>
      ) : null}
      </div>

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">新建项目</DialogTitle>
          </DialogHeader>
          <NewProjectFields
            name={newProjectName}
            onNameChange={setNewProjectName}
            description={newProjectDesc}
            onDescriptionChange={setNewProjectDesc}
            gitUrl={newProjectGit}
            onGitUrlChange={setNewProjectGit}
            withWorkspace={newProjectWithWorkspace}
            onWithWorkspaceChange={setNewProjectWithWorkspace}
          />
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

      <SessionSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        agentId={agentId}
        agentName={agent?.name}
        sessions={sessions}
        onPick={(hit) => {
          closeNavOnMobile();
          void openSearchHit(hit);
        }}
      />

      <RunLogDrawer open={logOpen} onOpenChange={setLogOpen} events={events} />

      <ChatSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        agentName={agent?.name}
        agentId={agentId}
        saveStatus={settingsSaveStatus}
        saveError={settingsSaveError}
        systemPrompt={systemPrompt}
        onSystemPromptChange={(v) => {
          setSystemPrompt(v);
          scheduleSettings({ systemPrompt: v });
        }}
        enableTools={enableTools}
        onEnableToolsChange={(v) => {
          setEnableTools(v);
          saveSettingsNow({ enableTools: v });
        }}
        autoMemory={autoMemory}
        onAutoMemoryChange={(v) => {
          setAutoMemory(v);
          saveSettingsNow({ autoMemory: v });
        }}
        autoTitle={autoTitle}
        onAutoTitleChange={(v) => {
          setAutoTitle(v);
          saveSettingsNow({ autoTitle: v });
        }}
        followUpMode={followUpMode}
        onFollowUpModeChange={(v) => {
          setFollowUpMode(v);
          saveSettingsNow({ followUpMode: v });
        }}
        maxSubagentDepth={maxSubagentDepth}
        onMaxSubagentDepthChange={(v) => {
          setMaxSubagentDepth(v);
          saveSettingsNow({ maxSubagentDepth: v });
        }}
      />
    </div>
  );
}
