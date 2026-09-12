import { registerModelAdapter } from "../registry.js";
import { anthropicAdapter, claudeCodeAdapter } from "./anthropic.js";
import { bailianAdapter } from "./bailian.js";
import {
  createOpenAiCompatibleAdapters,
  azureOpenAiAdapter,
  customAdapter,
  openAiAdapter,
} from "./openai-compatible.js";
import { geminiAdapter, geminiCliAdapter } from "./gemini.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";

let registered = false;

/** 注册内置协议适配器（幂等，启动时调用一次） */
export function registerBuiltinModelAdapters(): void {
  if (registered) return;
  for (const adapter of createOpenAiCompatibleAdapters()) {
    registerModelAdapter(adapter);
  }
  registerModelAdapter(bailianAdapter);
  registerModelAdapter(anthropicAdapter);
  registerModelAdapter(claudeCodeAdapter);
  registerModelAdapter(geminiAdapter);
  registerModelAdapter(geminiCliAdapter);
  registerModelAdapter(codexAdapter);
  registerModelAdapter(cursorAdapter);
  registered = true;
}

export {
  openAiAdapter,
  bailianAdapter,
  azureOpenAiAdapter,
  customAdapter,
  anthropicAdapter,
  claudeCodeAdapter,
  geminiAdapter,
  geminiCliAdapter,
  codexAdapter,
  cursorAdapter,
};
