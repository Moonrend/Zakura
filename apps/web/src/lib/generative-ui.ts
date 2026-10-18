import { createSpecStreamCompiler, resolveElementProps, type Spec } from "@json-render/core";
import { uiComponents, uiFunctions, UI_CATALOG_VERSION } from "./generative-ui-catalog";

export type UIState = Record<string, string | number | boolean | null>;
export type UISnapshot = { messageId: string; blockIndex: number; catalogVersion: number; contentHash: string; revision: number; state: UIState };
export type UIContentPart = { kind: "text"; content: string } | { kind: "ui"; content: string; blockIndex: number; closed: boolean };
export type UISpec = Spec & { catalogVersion?: number; state?: UIState };
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
export const UI_MAX_BYTES = 131072;

export function splitUIContent(content: string): UIContentPart[] {
  const parts: UIContentPart[] = [];
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let text = "", body = "", fence = "", ui = false, index = 0;
  for (const line of lines) {
    const trimmed = line.replace(/\r?\n$/, "");
    if (!fence) {
      const open = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(trimmed);
      if (open) {
        fence = open[2]!;
        ui = open[3]!.trim() === "json-render";
        if (ui) {
          if (text) parts.push({ kind: "text", content: text });
          text = "";
          body = "";
          continue;
        }
      }
    } else if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(trimmed)) {
      if (ui) {
        parts.push({ kind: "ui", content: body, blockIndex: index++, closed: true });
        body = "";
        fence = "";
        ui = false;
        continue;
      }
      fence = "";
    }
    if (ui) body += line;
    else text += line;
  }
  if (ui) parts.push({ kind: "ui", content: body, blockIndex: index, closed: false });
  if (text) parts.push({ kind: "text", content: text });
  return parts;
}

export function safeStatePath(path: unknown): path is string {
  return typeof path === "string" && /^\/[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(path) && !unsafe.has(path.slice(1));
}

export function validateUIState(value: unknown): asserts value is UIState {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw new Error("表单状态格式不正确");
  for (const [key, item] of Object.entries(value)) {
    if (!safeStatePath(`/${key}`) || !(item === null || typeof item === "boolean" || typeof item === "string" && item.length <= 8000 || typeof item === "number" && Number.isFinite(item))) throw new Error("表单字段格式不正确");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32768) throw new Error("表单内容过长");
}

function safeValue(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 10000 || depth > 20) throw new Error("界面结构过于复杂");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("界面包含无效数字");
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (unsafe.has(key)) throw new Error("界面包含不支持的字段");
    safeValue(item, depth + 1, budget);
  }
}

function expressions(value: unknown, state: UIState, depth = 0): void {
  if (depth > 15) throw new Error("计算表达式过于复杂");
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(obj)) {
    if (key.startsWith("$") && !["$state", "$bindState", "$computed"].includes(key)) throw new Error("界面使用了不支持的表达式");
    if (key === "$state" || key === "$bindState") {
      if (!safeStatePath(item) || !own(state, item.slice(1))) throw new Error("界面引用了未定义的表单字段");
    }
    if (key === "$computed" && (typeof item !== "string" || !own(uiFunctions, item))) throw new Error("界面使用了未注册的计算");
    expressions(item, state, depth + 1);
  }
}

export function validateUISpec(value: unknown, complete = true): UISpec {
  safeValue(value);
  const spec = value as UISpec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("界面格式不正确");
  if (Object.keys(spec).some((key) => !["catalogVersion", "state", "root", "elements"].includes(key))) throw new Error("界面包含不支持的配置");
  if (spec.catalogVersion !== undefined && spec.catalogVersion !== UI_CATALOG_VERSION) throw new Error("此界面版本暂不支持");
  const state = spec.state ?? {};
  validateUIState(state);
  if (!spec.elements || typeof spec.elements !== "object" || Array.isArray(spec.elements) || Object.keys(spec.elements).length > 150) throw new Error("界面组件数量超出限制");
  for (const [id, element] of Object.entries(spec.elements)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(id) || !element || typeof element !== "object") throw new Error("组件标识不正确");
    if (!own(uiComponents, element.type)) throw new Error(`不支持的界面组件：${String(element.type).slice(0, 60)}`);
    if (Object.keys(element).some((key) => !["type", "props", "children", "visible", "on"].includes(key))) throw new Error("界面包含不支持的组件行为");
    if (!element.props || typeof element.props !== "object" || Array.isArray(element.props)) throw new Error("组件属性格式不正确");
    expressions(element.props, state);
    const resolved = resolveElementProps(element.props, { stateModel: state, functions: uiFunctions });
    const definition = uiComponents[element.type as keyof typeof uiComponents];
    if (!definition.props.safeParse(resolved).success) throw new Error(`组件 ${element.type} 的参数不正确`);
    for (const [prop, item] of Object.entries(element.props)) {
      if (item && typeof item === "object" && "$bindState" in item) {
        if (!(prop === "value" && ["Input", "Select", "Slider"].includes(element.type) || prop === "checked" && element.type === "Checkbox")) throw new Error("组件不支持此字段绑定");
      }
    }
    if (element.visible !== undefined && typeof element.visible !== "boolean") {
      const condition = element.visible as unknown as Record<string, unknown>;
      if (!condition || Object.keys(condition).length !== 1 || !safeStatePath(condition.$state) || typeof state[condition.$state.slice(1)] !== "boolean") throw new Error("显示条件必须引用布尔字段");
    }
    if (element.children !== undefined && (!Array.isArray(element.children) || element.children.length > 150 || element.children.some((child) => typeof child !== "string"))) throw new Error("子组件格式不正确");
    const on = element.on;
    if (on) {
      if (element.type !== "Button" || Object.keys(on).some((key) => key !== "press")) throw new Error("只有按钮点击可以触发操作");
      const bindings = Array.isArray(on.press) ? on.press : [on.press];
      if (bindings.length !== 1) throw new Error("每个按钮只能执行一个操作");
      for (const binding of bindings) {
        if (!binding || Object.keys(binding).some((key) => !["action", "params"].includes(key))) throw new Error("按钮操作格式不正确");
        const params = binding.params ?? {};
        if (binding.action === "continueConversation") {
          if (Object.keys(params).some((key) => key !== "message") || typeof params.message !== "string" || !params.message.trim() || params.message.length > 2000) throw new Error("继续对话需要一条有效消息");
        } else if (binding.action === "setState") {
          if (Object.keys(params).some((key) => !["statePath", "value"].includes(key)) || !safeStatePath(params.statePath) || !own(state, params.statePath.slice(1))) throw new Error("状态操作引用了未定义字段");
          validateUIState({ ...state, [params.statePath.slice(1)]: params.value });
          if (typeof params.value !== typeof state[params.statePath.slice(1)]) throw new Error("状态操作不能改变字段类型");
        } else throw new Error("未注册的按钮操作");
      }
    }
  }
  let expanded = 0;
  function walk(id: string, parents: Set<string>): void {
    if (++expanded > 400 || parents.size > 16 || parents.has(id)) throw new Error("界面组件引用存在循环或层级过深");
    const element = own(spec.elements, id) ? spec.elements[id] : undefined;
    if (!element) { if (complete) throw new Error("界面缺少引用的组件"); return; }
    for (const child of element.children ?? []) walk(child, new Set([...parents, id]));
  }
  if (typeof spec.root !== "string" || !own(spec.elements, spec.root)) { if (complete) throw new Error("界面缺少主组件"); }
  else walk(spec.root, new Set());
  // Validate disconnected subtrees too: they may become reachable in later patches.
  for (const id of Object.keys(spec.elements)) walk(id, new Set());
  return spec;
}

export function validateStateForSpec(state: UIState, spec: UISpec): void {
  validateUIState(state);
  const initial = spec.state ?? {};
  if (Object.keys(state).length !== Object.keys(initial).length || Object.keys(state).some((key) => !own(initial, key) || typeof state[key] !== typeof initial[key])) throw new Error("表单字段与界面定义不一致");
}

export function createUICompiler() {
  let source = "", consumed = 0, patches = 0;
  let current: Record<string, unknown> = {};
  let error: string | undefined;
  function update(body: string, complete: boolean): { spec: UISpec | null; error?: string } {
    if (!body.startsWith(source)) { current = {}; consumed = 0; patches = 0; error = undefined; }
    source = body;
    if (new TextEncoder().encode(body).length > UI_MAX_BYTES) return { spec: null, error: "界面内容过长" };
    try {
      if (error) return { spec: null, error };
      const trimmed = body.trim();
      let full: Record<string, unknown> | null = null;
      if (trimmed.startsWith("{")) { try { const parsed = JSON.parse(trimmed); if (parsed && !own(parsed, "op")) full = parsed; } catch { /* JSONL or an incomplete full spec. */ } }
      const firstLine = body.trimStart().split("\n")[0] ?? "";
      let patchStream = false;
      if (body.includes("\n") || complete) { try { patchStream = own(JSON.parse(firstLine), "op"); } catch { /* Wait for a whole JSON document. */ } }
      if (full || !patchStream) {
        if (complete) current = JSON.parse(trimmed) as Record<string, unknown>;
      } else {
        while (consumed < body.length) {
          const end = body.indexOf("\n", consumed);
          if (end < 0 && !complete) break;
          const next = end < 0 ? body.length : end + 1;
          const line = body.slice(consumed, end < 0 ? body.length : end).trim();
          consumed = next;
          if (!line) continue;
          if (++patches > 500) throw new Error("界面更新次数过多");
          const patch = JSON.parse(line) as Record<string, unknown>;
          if (!patch || typeof patch !== "object" || !["add", "replace", "remove"].includes(String(patch.op)) || typeof patch.path !== "string" || Object.keys(patch).some((key) => !["op", "path", "value"].includes(key)) || patch.op !== "remove" && !own(patch, "value")) throw new Error("不支持的界面更新");
          const paths = patch.path.split("/").slice(1);
          if (!patch.path.startsWith("/") || paths.length > 8 || paths.some((key) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) || unsafe.has(key)) || !["catalogVersion", "state", "root", "elements"].includes(paths[0]!)) throw new Error("界面更新路径不正确");
          safeValue(patch.value);
          // Restrict patches to object properties; arrays are assigned atomically.
          let parent: unknown = current;
          for (const key of paths.slice(0, -1)) {
            if (!parent || typeof parent !== "object" || Array.isArray(parent) || !own(parent, key)) throw new Error("界面更新的父节点尚未定义");
            parent = (parent as Record<string, unknown>)[key];
          }
          if (!parent || typeof parent !== "object" || Array.isArray(parent)) throw new Error("界面更新只能写入对象字段");
          if (patch.op !== "add" && !own(parent, paths.at(-1)!)) throw new Error("界面更新的目标不存在");
          const compiler = createSpecStreamCompiler(structuredClone(current));
          const candidate = compiler.push(`${JSON.stringify(patch)}\n`).result;
          safeValue(candidate);
          if (candidate.elements && candidate.root) validateUISpec(candidate, false);
          current = candidate;
        }
      }
      if (!current.elements || !current.root) {
        if (complete) throw new Error("界面生成尚未完成");
        return { spec: null };
      }
      return { spec: validateUISpec(current, complete), ...(error ? { error } : {}) };
    } catch (err) {
      error = err instanceof Error ? err.message : "界面暂时无法显示";
      return { spec: null, error };
    }
  }
  return { update };
}

export async function uiContentHash(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content.replace(/\r\n/g, "\n")));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
