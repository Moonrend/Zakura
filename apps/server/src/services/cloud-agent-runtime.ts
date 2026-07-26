/**
 * Cloud Agent 运行时（门面）：实现拆分在 ./cloud-agent/ 模块中——
 * - runtime.ts  编排：主对话 / 子代理 / 跨 Agent 委派三条路径
 * - loop.ts     统一 Agent 循环引擎（流式、重试自愈、工具执行、事件落库）
 * - messages.ts 事件日志 ↔ 模型消息转换与上下文预算
 * - prompts.ts  系统提示词构建
 * - tools.ts    工具定义映射与结果转文本
 * - memory.ts   自动记忆提取
 *
 * 本文件保持既有导入路径稳定，只做再导出。
 */
export {
  CloudAgentRuntime,
  agentCloudConfig,
  type CloudAgentRuntimeDeps,
} from "./cloud-agent/runtime.js";
export {
  runAgentLoop,
  DeltaPublisher,
  appendRunLog,
  failRun,
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentLoopInput,
  type AgentLoopResult,
  type LoopChildLink,
  type LoopToolOutcome,
} from "./cloud-agent/loop.js";
export {
  buildChainMessages,
  buildUserMessage,
  eventsToMessages,
  parseAttachments,
  type StoredEvent,
} from "./cloud-agent/messages.js";
export { buildSubagentPrompt, buildSystemPrompt } from "./cloud-agent/prompts.js";
export {
  DELEGATE_TOOL_NAME,
  mcpResultToText,
  parseToolArgs,
  sanitizeToolName,
  toolsToDefinitions,
} from "./cloud-agent/tools.js";
export { extractAndSaveMemories, parseMemoryExtraction } from "./cloud-agent/memory.js";
