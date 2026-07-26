import { registerModelAdapter } from "../registry.js";
import { anthropicAdapter } from "./anthropic.js";
import { bailianAdapter } from "./bailian.js";
import {
  createOpenAiCompatibleAdapters,
  azureOpenAiAdapter,
  customAdapter,
  openAiAdapter,
} from "./openai-compatible.js";
import { geminiAdapter } from "./gemini.js";

let registered = false;

/** 注册内置协议适配器（幂等，启动时调用一次） */
export function registerBuiltinModelAdapters(): void {
  if (registered) return;
  for (const adapter of createOpenAiCompatibleAdapters()) {
    registerModelAdapter(adapter);
  }
  registerModelAdapter(bailianAdapter);
  registerModelAdapter(anthropicAdapter);
  registerModelAdapter(geminiAdapter);
  registered = true;
}

export {
  openAiAdapter,
  bailianAdapter,
  azureOpenAiAdapter,
  customAdapter,
  anthropicAdapter,
  geminiAdapter,
};
