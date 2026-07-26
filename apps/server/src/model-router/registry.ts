import type { ModelCapability, ModelUpstreamProtocol } from "@zakura/shared";
import type { ModelProtocolAdapter } from "./adapter.js";
import { adapterSupports } from "./adapter.js";

const adapters = new Map<ModelUpstreamProtocol, ModelProtocolAdapter>();

export function registerModelAdapter(adapter: ModelProtocolAdapter): void {
  adapters.set(adapter.protocol, adapter);
}

export function getModelAdapter(protocol: ModelUpstreamProtocol): ModelProtocolAdapter {
  const adapter = adapters.get(protocol);
  if (!adapter) {
    throw new Error(`未注册的模型协议适配器: ${protocol}`);
  }
  return adapter;
}

export function listModelAdapters(): ModelProtocolAdapter[] {
  return [...adapters.values()];
}

export function resolveAdapterForCapability(
  protocol: ModelUpstreamProtocol,
  capability: ModelCapability,
): ModelProtocolAdapter {
  const adapter = getModelAdapter(protocol);
  if (!adapterSupports(adapter, capability)) {
    throw new Error(`协议 ${protocol} 不支持能力 ${capability}`);
  }
  return adapter;
}
