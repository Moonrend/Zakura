/**
 * Agent 侧「询问用户」工具：主对话与 routine（system）会话注入。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import type { AskUserService } from "../ask-user.js";

export const ASK_USER_TOOL = "ask_user";

export function isAskUserToolName(name: string): boolean {
  return name === ASK_USER_TOOL;
}

export function listAskUserToolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: ASK_USER_TOOL,
        description: [
          "Ask the user a question with optional choice cards. Use this instead of guessing when a decision, preference, or secret is needed.",
          "mode=sync (default) blocks until they answer; mode=async returns immediately and the answer arrives later as a follow-up message.",
          "For long-running / routine jobs always set timeout_seconds and timeout_action (skip or default) so the run does not hang if they are offline.",
          "secret=true shows a masked field; do not echo the value back in chat.",
        ].join(" "),
        parameters: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string", description: "Question shown on the card" },
            options: {
              type: "array",
              description: "Choice cards. Omit for free-text / secret input.",
              items: {
                type: "object",
                required: ["id", "label"],
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
            allow_multiple: { type: "boolean", default: false },
            secret: {
              type: "boolean",
              default: false,
              description: "Masked input; value is not shown in the transcript",
            },
            mode: {
              type: "string",
              enum: ["sync", "async"],
              default: "sync",
            },
            timeout_seconds: {
              type: "integer",
              minimum: 5,
              description:
                "Auto-resolve after N seconds. Routine/system sessions default to 1800 if omitted.",
            },
            timeout_action: {
              type: "string",
              enum: ["skip", "default"],
              default: "skip",
            },
            default_option_ids: {
              type: "array",
              items: { type: "string" },
              description: "Used when timeout_action=default",
            },
            placeholder: { type: "string" },
          },
        },
      },
    },
  ];
}

export async function callAskUserTool(
  askUser: AskUserService,
  input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    runId: string;
    toolCallId?: string;
    sessionKind?: string;
    args: Record<string, unknown>;
  },
): Promise<{ text: string; isError?: boolean }> {
  return askUser.ask({
    tenantId: input.tenantId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    question: String(input.args.question ?? ""),
    options: input.args.options,
    allowMultiple: input.args.allow_multiple === true,
    secret: input.args.secret === true,
    mode: input.args.mode === "async" ? "async" : "sync",
    timeoutSeconds:
      typeof input.args.timeout_seconds === "number" ? input.args.timeout_seconds : null,
    timeoutAction: input.args.timeout_action === "default" ? "default" : "skip",
    defaultOptionIds: input.args.default_option_ids,
    placeholder: typeof input.args.placeholder === "string" ? input.args.placeholder : undefined,
    sessionKind: input.sessionKind,
  });
}
