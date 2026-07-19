import type { ProviderFactory, ProviderPlugin } from "./provider.js";

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();
  /** Cached instances — providers may hold injected state (e.g. DB) */
  private readonly instances = new Map<string, ProviderPlugin>();

  register(factory: ProviderFactory): void {
    const plugin = factory();
    if (this.factories.has(plugin.id)) {
      throw new Error(`Provider already registered: ${plugin.id}`);
    }
    this.factories.set(plugin.id, factory);
    this.instances.set(plugin.id, plugin);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  get(id: string): ProviderPlugin {
    const cached = this.instances.get(id);
    if (cached) return cached;
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`Unknown provider: ${id}`);
    }
    const plugin = factory();
    this.instances.set(id, plugin);
    return plugin;
  }

  list(): ProviderPlugin[] {
    return this.ids().map((id) => this.get(id));
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }
}

export const globalRegistry = new ProviderRegistry();
