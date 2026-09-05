/**
 * ACP client-side request handlers.
 *
 * When an ACP agent runs, it does not just stream output back to us -- it calls
 * *us* for capabilities it lacks: permission prompts, workspace file reads and
 * writes, and terminal (shell job) control. Those handlers are pure protocol
 * plumbing: they translate ACP requests into Zakura services and back.
 *
 * They used to live inline inside `AcpSessionService.bootRuntime`, which made
 * that method ~540 lines and mixed three unrelated concerns (adapter launch,
 * protocol wiring, session negotiation). Extracting them keeps `bootRuntime`
 * about the *lifecycle* and lets these handlers be read -- and tested -- as the
 * self-contained capability surface they actually are.
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  isPathUnderRoots,
  pathPrefixFromLocations,
  pickGrantedOptionId,
  type AcpAgentConfig,
} from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import { firstDeny, type AgentHooksService } from "../agent-hooks.js";
import type { LiveRuntime } from "./session.js";

/**
 * Only the slice of session deps these handlers touch.
 *
 * These are `Pick`ed from the real service types rather than re-declared by
 * hand. A hand-written structural copy drifts silently the moment an upstream
 * signature changes -- this block already had `startShellJob(command: string)`
 * when the real one takes `string[]`, and nothing would have caught it.
 */
export interface AcpClientHandlerDeps {
  store: Pick<CloudAgentSessionStore, "appendEvent">;
  workspace: Pick<
    AgentWorkspaceService,
    "startShellJob" | "getShellJob" | "waitShellJob" | "killShellJob"
  >;
  workspaceFs?: Pick<ServerWorkspaceFsProvider, "forAgent">;
}

export interface AcpClientHandlerContext {
  deps: AcpClientHandlerDeps;
  live: LiveRuntime;
  agent: Agent;
  chatSessionId: string;
  /** Snapshot of the agent's ACP config; drives the permission fast-path. */
  config: AcpAgentConfig;
  hooks: AgentHooksService;
  /**
   * Resolve the runtime that owns an incoming ACP `sessionId`.
   *
   * Phase 2 wires every handler through this instead of closing over a single
   * `live`. Today one process serves one session, so the default resolver just
   * checks the bound runtime and the behaviour is unchanged. Phase 3 swaps in a
   * real routing table for one-process-many-sessions without touching handlers.
   */
  resolveSession?: (acpSessionId: string) => LiveRuntime | undefined;
  /**
   * All runtimes served by this connection. `elicitation/complete` carries only
   * an elicitationId (no sessionId), so the owner must be found by lookup.
   * Defaults to the single bound runtime.
   */
  allSessions?: () => Iterable<LiveRuntime>;
}

/**
 * Every ACP client request carries the `sessionId` it belongs to. Resolving the
 * target runtime from that id -- rather than from the closure -- is what keeps
 * a multiplexed connection from leaking one session's files, permissions or
 * terminals into another.
 *
 * Fail closed: an unknown or absent id throws instead of silently falling back
 * to the bound runtime. Under today's one-session-per-process model the
 * assertion can never fire, which is exactly why it is safe to add now and
 * load-bearing later.
 */
function makeSessionResolver(ctx: AcpClientHandlerContext) {
  const { live } = ctx;
  return (acpSessionId: unknown, method: string): LiveRuntime => {
    if (typeof acpSessionId !== "string" || !acpSessionId) {
      throw new Error(`${method}: 缺少 sessionId，拒绝执行`);
    }
    const resolved = ctx.resolveSession
      ? ctx.resolveSession(acpSessionId)
      : live.acpSessionId === acpSessionId
        ? live
        : undefined;
    if (!resolved) {
      throw new Error(`${method}: 未知会话 ${acpSessionId}，拒绝执行`);
    }
    return resolved;
  };
}

/**
 * Build the ACP client with every capability handler attached.
 * The caller owns the transport and connects the returned app to a stream.
 */
export function buildAcpClient(ctx: AcpClientHandlerContext) {
  const { deps, live, agent, config, hooks } = ctx;
  // Handler callbacks shadow `ctx` with their own request context, so keep a
  // stable alias to the builder-level context.
  const handlerCtx = ctx;
  const fsProvider = deps.workspaceFs;
  const sessionOf = makeSessionResolver(ctx);

  const app = acp
    .client({ name: "zakura" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const requestId = String(ctx.requestId);
      const target = sessionOf(ctx.params.sessionId, "session/request_permission");
      const options = ctx.params.options ?? [];
      const tool = ctx.params.toolCall;
      const kind = tool?.kind ? String(tool.kind) : undefined;
      const pathPrefix = pathPrefixFromLocations(tool?.locations ?? undefined);
      if (config.permissionPolicy === "allow") {
        const allow =
          options.find((o) => String(o.kind).startsWith("allow")) ?? options[0];
        return {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        };
      }
      const granted = pickGrantedOptionId(
        target.permissionGrants,
        { kind, locations: tool?.locations ?? undefined },
        options.map((o) => ({ optionId: o.optionId, kind: String(o.kind) })),
      );
      if (granted) {
        return { outcome: { outcome: "selected", optionId: granted } };
      }
      await deps.store.appendEvent({
        sessionId: target.chatSessionId,
        type: "permission_request",
        ...(target.runId ? { runId: target.runId } : {}),
        payload: {
          requestId,
          toolCallId: tool?.toolCallId ?? undefined,
          title: tool?.title ?? undefined,
          options: options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: String(o.kind),
          })),
        },
      });
      return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
        target.permissions.set(requestId, {
          resolve,
          reject,
          kind,
          pathPrefix,
          optionKinds: Object.fromEntries(options.map((o) => [o.optionId, String(o.kind)])),
        });
      });
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      if (!fsProvider) throw new Error("workspace fs unavailable");
      const target = sessionOf(ctx.params.sessionId, "fs/read_text_file");
      const path = assertAcpFsPath(ctx.params.path, target);
      const fs = await fsProvider.forAgent(agent.id, agent.tenantId);
      const read = await fs.readText(path);
      let content = read.content;
      if (ctx.params.line && ctx.params.line > 1) {
        const lines = content.split("\n");
        content = lines.slice(ctx.params.line - 1).join("\n");
      }
      if (ctx.params.limit && ctx.params.limit > 0) {
        content = content.split("\n").slice(0, ctx.params.limit).join("\n");
      }
      return { content };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      if (!fsProvider) throw new Error("workspace fs unavailable");
      const target = sessionOf(ctx.params.sessionId, "fs/write_text_file");
      const path = assertAcpFsPath(ctx.params.path, target);
      const denied = firstDeny(
        await hooks.runEvent(agent, "PreToolUse", {
          toolName: "write_text_file",
          toolArgs: { path, content: ctx.params.content },
          workingDir: target.cwd,
          sessionId: target.chatSessionId,
        }),
      );
      if (denied) throw new Error(denied.reason || "hook 拒绝写入");
      const fs = await fsProvider.forAgent(agent.id, agent.tenantId);
      await fs.writeText(path, ctx.params.content);
      return {};
    })
    .onRequest(acp.methods.client.terminal.create, async (ctx) => {
      const target = sessionOf(ctx.params.sessionId, "terminal/create");
      const cwd = ctx.params.cwd || target.cwd;
      if (cwd) assertAcpFsPath(cwd, target);
      const args = ctx.params.args ?? [];
      const command = args.length
        ? [ctx.params.command, ...args]
        : ["bash", "-lc", ctx.params.command];
      const env: Record<string, string> = {};
      for (const item of ctx.params.env ?? []) {
        if (item.name) env[item.name] = item.value ?? "";
      }
      const result = await deps.workspace.startShellJob(agent, command, {
        workingDir: cwd || target.cwd,
        ...(Object.keys(env).length ? { env } : {}),
      });
      target.terminals.set(result.jobId, {
        outputByteLimit: ctx.params.outputByteLimit ?? undefined,
      });
      return { terminalId: result.jobId };
    })
    .onRequest(acp.methods.client.terminal.output, async (ctx) => {
      const target = sessionOf(ctx.params.sessionId, "terminal/output");
      const snap = await deps.workspace.getShellJob(agent, ctx.params.terminalId);
      const limit = target.terminals.get(ctx.params.terminalId)?.outputByteLimit;
      const clipped = clipAcpTerminalOutput(`${snap.stdout}${snap.stderr}`, limit);
      return {
        output: clipped.output,
        truncated: clipped.truncated,
        exitStatus: snap.running ? null : { exitCode: snap.exitCode ?? 0, signal: null },
      };
    })
    .onRequest(acp.methods.client.terminal.release, async (ctx) => {
      const target = sessionOf(ctx.params.sessionId, "terminal/release");
      target.terminals.delete(ctx.params.terminalId);
      await deps.workspace.killShellJob(agent, ctx.params.terminalId).catch(() => undefined);
      return {};
    })
    .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
      sessionOf(ctx.params.sessionId, "terminal/wait_for_exit");
      const snap = await deps.workspace.waitShellJob(agent, ctx.params.terminalId, 120_000);
      if (snap.running) {
        // 命令仍在运行却返回 exitCode 会把失败伪装成成功，agent 会基于
        // 假结果继续；报错让 agent 自行决定等待或终止。
        throw new Error("terminal command still running after timeout");
      }
      return { exitCode: snap.exitCode ?? 0, signal: null };
    })
    .onRequest(acp.methods.client.terminal.kill, async (ctx) => {
      const target = sessionOf(ctx.params.sessionId, "terminal/kill");
      target.terminals.delete(ctx.params.terminalId);
      await deps.workspace.killShellJob(agent, ctx.params.terminalId);
      return {};
    })
    .onRequest(acp.methods.client.elicitation.create, async (ctx) => {
      const requestId = String(ctx.requestId);
      // Unlike fs/terminal/permission requests, an elicitation may be scoped to
      // a session *or* only to a request id (ElicitationRequestScope), so a
      // sessionId is not guaranteed. Route when it is present; otherwise fall
      // back to the bound runtime rather than rejecting a legal request.
      const scoped = (ctx.params as { sessionId?: unknown }).sessionId;
      const target =
        typeof scoped === "string" && scoped
          ? sessionOf(scoped, "session/elicitation/create")
          : live;
      const elicitationId =
        typeof (ctx.params as { elicitationId?: unknown }).elicitationId === "string"
          ? (ctx.params as { elicitationId: string }).elicitationId
          : undefined;
      await deps.store.appendEvent({
        sessionId: target.chatSessionId,
        type: "elicitation_request",
        ...(target.runId ? { runId: target.runId } : {}),
        payload: {
          requestId,
          mode: ctx.params.mode === "url" ? "url" : "form",
          message: typeof ctx.params.message === "string" ? ctx.params.message : undefined,
          url:
            typeof (ctx.params as { url?: unknown }).url === "string"
              ? (ctx.params as { url: string }).url
              : undefined,
          fields: elicitationFields(ctx.params),
        },
      });
      return new Promise((resolve, reject) => {
        target.elicitations.set(requestId, { resolve, reject });
        // url 模式下 agent 通过 elicitation/complete 通知收尾，而该通知只带
        // elicitationId（与 JSON-RPC requestId 不同）。这里额外登记一条别名，
        // 否则 URL 型 elicitation 永远等不到 resolve，整轮 prompt 会一直挂起。
        if (elicitationId && elicitationId !== requestId) {
          target.elicitations.set(elicitationId, { resolve, reject });
        }
      });
    })
    .onNotification(acp.methods.client.elicitation.complete, async (ctx) => {
      const elicitationId =
        typeof ctx.params?.elicitationId === "string" ? ctx.params.elicitationId : "";
      if (!elicitationId) return;
      // This notification carries no sessionId, so locate the owning runtime by
      // the elicitation id itself instead of assuming the bound one.
      let target: LiveRuntime | undefined;
      for (const candidate of handlerCtx.allSessions ? handlerCtx.allSessions() : [live]) {
        if (candidate.elicitations.has(elicitationId)) {
          target = candidate;
          break;
        }
      }
      if (!target) return;
      const pending = target.elicitations.get(elicitationId);
      if (!pending) return;
      for (const [key, value] of target.elicitations) {
        if (value === pending) target.elicitations.delete(key);
      }
      await deps.store.appendEvent({
        sessionId: target.chatSessionId,
        type: "elicitation_resolved",
        ...(target.runId ? { runId: target.runId } : {}),
        payload: { requestId: elicitationId, cancelled: false },
      });
      pending.resolve({ action: "accept" });
    });


  return app;
}


function clipAcpTerminalOutput(
  output: string,
  limit?: number,
): { output: string; truncated: boolean } {
  if (!limit || limit <= 0) return { output, truncated: false };
  const buf = Buffer.from(output);
  if (buf.length <= limit) return { output, truncated: false };
  let start = buf.length - limit;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return { output: buf.subarray(start).toString("utf8"), truncated: true };
}

function assertAcpFsPath(path: string, live: LiveRuntime): string {
  const p = path.replace(/\\/g, "/");
  if (!isPathUnderRoots(p, live.extraRoots.length ? live.extraRoots : [live.cwd])) {
    throw new Error(`路径超出会话工作区: ${path}`);
  }
  return p;
}

function elicitationFields(
  params: unknown,
): Array<{
  id: string;
  type: string;
  title?: string;
  required?: boolean;
  options?: string[];
}> | undefined {
  const rec = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const schema =
    rec.requestedSchema && typeof rec.requestedSchema === "object"
      ? (rec.requestedSchema as Record<string, unknown>)
      : null;
  const props =
    schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (!props) return undefined;
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [],
  );
  const fields = Object.entries(props)
    .slice(0, 16)
    .map(([id, raw]) => {
      const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      // JSON Schema 的 enum（如选择登录方式）原样透传，前端渲染为下拉。
      const options = Array.isArray(p.enum)
        ? p.enum.filter((v): v is string => typeof v === "string" && v.length > 0)
        : undefined;
      return {
        id,
        type: typeof p.type === "string" ? p.type : "string",
        title:
          typeof p.title === "string"
            ? p.title
            : typeof p.description === "string"
              ? p.description
              : id,
        required: required.has(id),
        ...(options?.length ? { options } : {}),
      };
    });
  return fields.length ? fields : undefined;
}
