import type { ModelProtocolAdapter } from "../adapter.js";
import { responsesChat, responsesChatStream } from "../openai-responses-api.js";
import { packOpenAiChatTools } from "../openai-tools.js";

export const codexAdapter: ModelProtocolAdapter = {
  protocol: "codex",
  supportedCapabilities: ["chat"],
  chat(route, messages, options) {
    if (!route.upstream.config.apiKey) throw new Error("尚未登录 Codex 订阅");
    const packed =
      packOpenAiChatTools(options?.tools, route.model, {
        format: "responses",
        messages,
      })?.tools ?? [];
    return responsesChat(route, messages, packed, {
      toolChoice: options?.toolChoice,
      temperature: route.options.temperature,
      maxTokens: route.options.maxTokens,
    });
  },
  chatStream(route, messages, options, callbacks) {
    if (!route.upstream.config.apiKey) throw new Error("尚未登录 Codex 订阅");
    const packed =
      packOpenAiChatTools(options?.tools, route.model, {
        format: "responses",
        messages,
      })?.tools ?? [];
    return responsesChatStream(
      route,
      messages,
      packed,
      {
        toolChoice: options?.toolChoice,
        temperature: route.options.temperature,
        maxTokens: route.options.maxTokens,
      },
      callbacks,
    );
  },
};
