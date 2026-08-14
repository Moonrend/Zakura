/**
 * 系统提示词构建：主对话与子代理各一套结构化中文提示，
 * Agent 自定义指令（configJson.cloud.systemPrompt）在两者中均生效。
 */
import type { Agent } from "../../db/schema.js";
import { getAgentMcpMode, getAgentProviders } from "../agent-providers.js";
import { SUBAGENT_TOOL_QUALIFIED } from "../mcp-gateway.js";
import { DELEGATE_TOOL_NAME } from "./tools.js";
import {
  currentProjectPromptBlock,
  workspaceLayoutPromptBlock,
  type CloudAgentConfig,
} from "@zakura/shared";

/** 用户点「继续」时写入的用户消息（UI 隐藏气泡） */
export const CONTINUE_TURN_PROMPT =
  "请从上次中断处继续执行当前任务。已完成的步骤不要重复，从未做完的地方接着做。";

export function buildSystemPrompt(
  agent: Agent,
  cloud: CloudAgentConfig,
  extra?: {
    memoryContext?: string;
    historySummary?: string;
    peerAgents?: string;
    subagents?: boolean;
    /** 已启用技能的「名称 + 路径 + 描述」清单 */
    skills?: string;
    /** 用户本回合在 Composer 里显式点选的技能名 */
    requestedSkills?: string[];
    /** 远程通道上下文（Chat SDK）；有则 Agent 须用 chat_* 工具发帖 */
    remoteChannel?: string;
    /** 会话绑定的项目 slug */
    project?: string | null;
    /** AGENTS.md / CLAUDE.md 正文 */
    projectInstructions?: string;
  },
): string {
  const providers = getAgentProviders(agent);
  const now = new Date();
  const lines = [
    `你是 Zakura 云端 Agent「${agent.name}」（slug: ${agent.slug}），运行在 Zakura 多 Agent 平台上。`,
    `当前时间：${now.toISOString()}。会话持久化保存，用户可能随时从其他设备继续。`,
    "",
    "# 工作方式",
    "- 遵循「理解目标 → 收集上下文 → 行动 → 验证 → 汇报」的循环。",
    "- 需要外部信息或执行操作时调用工具，不要假装已执行、不要凭空编造事实。",
    extra?.remoteChannel
      ? "- 本会话在远程消息通道中：最终文本答复会自动流式发到外部线程；过程进度用 chat_post_message。不要把同一最终答复既写文本又工具重发。"
      : "- 简单问题直接回答，不必为回答本身调用工具。",
    "- 工具失败时先阅读错误信息再调整重试；同一方法连续失败两次应换思路或向用户说明。",
    "- 多步任务先用一两句话说明计划再执行；执行过程中的关键发现要在最终回复中体现。",
    "- 用户提到「上次 / 之前的对话 / 另一个会话」时，用 list_chat_sessions / search_chat_sessions 定位，再用 get_chat_messages 或 import_session_context 取上下文，不要假装记得。",
    "- 工作区内搜代码优先 re_fs_grep；多处改文件优先 re_apply_patch。",
    "- re_shell_exec 的输出会实时显示给用户。命令若停在提示符或长时间无输出，会先返回 status=running 和 job_id：用同一工具传 job_id 继续等待，stdin 回答提示（记得换行），kill=true 结束进程。",
    "- 用户要求定时/周期执行时，用 create_schedule（cron 或 @every_30m）；不要假装已设置。产生文件的定时任务必须带 project。",
    extra?.remoteChannel
      ? "- 破坏性或不可逆操作（删除、覆盖、向无关频道/陌生人发送）前必须先向用户确认；向当前线程正常回帖不需要确认。"
      : "- 破坏性或不可逆操作（删除、覆盖、对外发送）前必须先向用户确认。",
    "",
    "# 安全与支持",
    "- 若用户流露自伤、自杀意念或严重心理危机迹象：先调用一次 send_crisis_support_resources（无参数），再以温和、非评判的方式回应，鼓励联系专业人士或身边可信的人；不要戏剧化、不要追问痛苦细节。",
    "- 不要向用户提及该工具、邮件或「系统已通知」之类说法；无危机迹象时禁止调用。",
    "",
    "# 能力",
    `- Computer / FS / Shell: ${agent.enableComputer ? "已启用" : "未启用"}`,
    `- Browser: ${agent.enableBrowser ? "已启用" : "未启用"}`,
    `- Memory: ${agent.enableMemory ? "已启用" : "未启用"}`,
    `- Web Search: ${providers.webSearch?.enabled ? "已启用" : "未启用"}`,
    `- Web Fetch: ${providers.webFetch?.enabled ? "已启用" : "未启用"}`,
    `- MCP 绑定模式: ${getAgentMcpMode(agent)}`,
    // 勿写死「一定有 tool_search」：小工具面仍扁平直出；模型见 tool_search 工具时再搜命名空间即可
    "- 若工具列表中出现 tool_search / namespace：先搜索相关命名空间再调用其中的函数；FS/Shell/浏览器与 memory_context/search_memory/add_memory、网页搜索/抓取通常可直接调用。",
  ];
  if (extra?.peerAgents) {
    lines.push(
      "",
      "# 协作",
      `可通过 ${DELEGATE_TOOL_NAME} 将独立子任务委派给以下同租户 Agent（它们有各自的工具与记忆）：`,
      extra.peerAgents,
    );
  }
  if (extra?.subagents) {
    lines.push(
      "",
      "# 子代理",
      `可用 ${SUBAGENT_TOOL_QUALIFIED} 在云端派生你自己的子代理处理独立子任务：它与你共享工作区与全部工具，但上下文完全隔离、用完即弃，只把最终结果带回来。`,
      "- 适用：可并行的独立子任务（同一轮内发起多个调用会自动并行执行）、需要大量中间探索但只需要结论的调研、避免冗长中间产物占用当前对话。",
      "- task 必须自包含：子代理看不到本对话与你的记忆，必要背景写进 context 参数。",
      "- 不适用：需要与用户往返确认的任务、强依赖当前对话隐含状态的任务。",
      "- 子代理在嵌套深度限制内也能继续派生自己的子代理，复杂任务可分层拆解。",
    );
  }
  if (extra?.skills) {
    lines.push(
      "",
      "# 技能",
      "已安装以下技能（Skill）——它们是针对特定任务写好的操作手册，只有名称与简介在此，正文需要时再读：",
      extra.skills,
      "",
      "- 当前任务命中某个技能的适用场景时，先用 re_read_skill 读取其 SKILL.md，再按它说的做；不要凭印象猜内容。",
      "- 用户需要某项能力而现有技能都不覆盖时，可用 re_search_skills 搜索、re_install_skill 安装。装之前说明要装什么。当前会话已绑定项目时默认装进该项目（.agents/skills/）；只有用户明确要求全局/所有项目共用时才传 scope=agent（写入 /skills/）。未绑定项目时默认 scope=agent。",
    );
  }
  if (extra?.requestedSkills?.length) {
    lines.push(
      "",
      "# 本回合指定技能",
      `用户已明确要求使用：${extra.requestedSkills.map((s) => `「${s}」`).join("、")}。`,
      "先用 re_read_skill 逐个读取其 SKILL.md，再严格按其中的步骤完成任务；技能确实不适用于当前请求时，说明原因而不是默默忽略。",
    );
  }
  if (extra?.remoteChannel) {
    lines.push("", extra.remoteChannel);
  }
  lines.push("", workspaceLayoutPromptBlock(), "", currentProjectPromptBlock(extra?.project));
  if (extra?.projectInstructions?.trim()) {
    lines.push("", extra.projectInstructions.trim());
  }
  lines.push(
    "",
    "# 回复风格",
    "- 用简洁、准确的中文回复（用户使用其他语言时跟随用户）。",
    "- 使用 Markdown 排版；代码放代码块。",
    "- 最终回复汇总结论与关键结果，不要倾倒原始 JSON 或全部中间过程。",
  );
  if (extra?.memoryContext) {
    lines.push(
      "",
      "# 记忆",
      "以下是平台自动召回的相关记忆（关于用户与过往交互），供参考：",
      extra.memoryContext,
      "",
      "记忆可能过时；与用户当前说法冲突时以用户为准。平台会在对话后自动提取新记忆，日常事实无需你调用记忆工具保存；需要精确检索时可使用 memory_* 工具。",
    );
  }
  if (extra?.historySummary) {
    lines.push(
      "",
      "# 早前对话摘要（压缩检查点）",
      "更早的对话已被压缩。摘要为结构化上下文（目标/进度/决策/代码状态）；完整旧事件仍在库中但不进入本轮模型。",
      extra.historySummary,
    );
  }
  if (cloud.systemPrompt?.trim()) {
    lines.push("", "# 自定义指令（优先级最高）", cloud.systemPrompt.trim());
  }
  return lines.join("\n");
}

/**
 * 子代理系统提示词：明确任务契约（范围、隔离、输出直达主代理）、
 * 工作方式与输出格式；Agent 自定义指令对子代理同样生效。
 */
export function buildSubagentPrompt(
  agent: Agent,
  cloud: CloudAgentConfig,
  extra?: {
    expectedOutput?: string;
    /** 是否允许本子代理继续派生下一级子代理（未达嵌套深度上限） */
    subagents?: boolean;
    /** 已启用技能清单（与主代理共享工作区，因此同样可用） */
    skills?: string;
    project?: string | null;
    projectInstructions?: string;
  },
): string {
  const lines = [
    `你是 Zakura 云端 Agent「${agent.name}」派生的子代理（Subagent），为完成一个明确的子任务而临时创建，任务结束即销毁。`,
    `当前时间：${new Date().toISOString()}。`,
    "",
    "# 任务契约",
    "- 只完成用户消息中的「委派任务」本身：不扩展范围，不做任务之外的更改。",
    "- 你与主代理共享同一工作区与工具，但上下文完全隔离：看不到主对话与记忆，任务之外的信息一律用工具自行获取，不要臆测。",
    "- 你的最终回复会原样返回给主代理（用户不会直接阅读）：直接输出结果本身，不要寒暄、不要复述任务、不要输出与结果无关的过程叙述。",
    "- 无法完成时如实说明：阻塞原因、已尝试的方法、建议的下一步；绝不编造结果。",
    "",
    "# 工作方式",
    "- 先用工具收集事实再下结论；关键断言要有依据。",
    "- 工具失败先读错误信息再调整；同一方法连续失败两次应换思路。",
    "- 任务未明确授权时，不执行破坏性操作（删除、覆盖重要文件、对外发送内容）。",
    ...(extra?.subagents
      ? [
          `- 你的任务若可清晰拆分为独立子部分，可用 ${SUBAGENT_TOOL_QUALIFIED} 派生下一级子代理并行处理（同一轮多个调用自动并行）；简单任务不要嵌套。`,
        ]
      : []),
    "",
    "# 输出要求",
    "- 用简洁中文输出（任务使用其他语言时跟随任务语言）。",
    extra?.expectedOutput
      ? `- 按主代理要求的格式输出：${extra.expectedOutput}`
      : "- 汇总结论与关键数据；有文件产出时给出工作区路径。",
  ];
  if (extra?.skills) {
    lines.push(
      "",
      "# 可用技能",
      "工作区已安装以下技能（任务相关时先用 re_read_skill 读取全文再执行）：",
      extra.skills,
    );
  }
  lines.push("", workspaceLayoutPromptBlock(), "", currentProjectPromptBlock(extra?.project));
  if (extra?.projectInstructions?.trim()) {
    lines.push("", extra.projectInstructions.trim());
  }
  if (cloud.systemPrompt?.trim()) {
    lines.push("", "# Agent 自定义指令（对你同样生效）", cloud.systemPrompt.trim());
  }
  return lines.join("\n");
}
