/**
 * Lightweight Chrome DevTools Protocol client for agent Browser Use.
 * Connects to Chromium through a workspace endpoint/tunnel; keeps tab and ref state.
 */
import WebSocket from "ws";
import { pngDimensions } from "./agent-screenshot.js";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
}

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class CdpConnectionError extends Error {}

class CdpSession {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id == null) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(`CDP ${p.method}: ${msg.error.message ?? "unknown error"}`));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        /* ignore */
      }
    });
    this.ws.addEventListener("close", () => this.fail(new CdpConnectionError("CDP connection closed")));
    this.ws.addEventListener("error", (event) => this.fail(new CdpConnectionError(`CDP connection failed: ${event.message}`)));
  }

  private fail(error: Error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new CdpConnectionError("CDP session closed");
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new CdpConnectionError(`CDP timeout: ${method}`));
        }
      }, 45_000);
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (err) {
        this.fail(new CdpConnectionError(`CDP send failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  close(): void {
    this.fail(new CdpConnectionError("CDP session closed"));
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitWsOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", opened);
      ws.removeEventListener("error", failed);
      ws.removeEventListener("close", failed);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new CdpConnectionError("CDP WebSocket connection failed")); };
    const timer = setTimeout(() => {
      cleanup();
      // Keep an error listener during terminate (ws may emit a handshake error).
      ws.on("error", () => undefined);
      ws.terminate();
      reject(new CdpConnectionError("CDP WebSocket open timeout"));
    }, 10_000);
    ws.addEventListener("open", opened);
    ws.addEventListener("error", failed);
    ws.addEventListener("close", failed);
  });
}

export async function listCdpTargets(cdpBaseUrl: string): Promise<CdpTarget[]> {
  const base = cdpBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CDP /json/list failed: ${res.status}`);
  const targets = await res.json();
  if (!Array.isArray(targets)) throw new Error("CDP /json/list returned an invalid target list");
  return targets as CdpTarget[];
}

export async function cdpReady(cdpBaseUrl: string): Promise<boolean> {
  try {
    await listCdpTargets(cdpBaseUrl);
    return true; // An empty browser is ready; openSession can create a page.
  } catch {
    return false;
  }
}

async function openSession(cdpBaseUrl: string, targetId?: string): Promise<{
  session: CdpSession;
  target: CdpTarget;
}> {
  const targets = await listCdpTargets(cdpBaseUrl);
  let page = targetId
    ? targets.find((t) => t.id === targetId && t.type === "page")
    : targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (targetId && !page) throw new Error("Selected browser tab is no longer available. Use tab_list and tab_select, then observe a new snapshot.");

  if (!page?.webSocketDebuggerUrl) {
    // Create a new tab
    const base = cdpBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Some Chrome versions use GET
      const res2 = await fetch(`${base}/json/new?about:blank`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res2.ok) throw new Error("No CDP page target and failed to create tab");
      page = (await res2.json()) as CdpTarget;
    } else {
      page = (await res.json()) as CdpTarget;
    }
  }

  let wsUrl = page.webSocketDebuggerUrl!;
  // Docker publishes host port; Chrome may advertise 0.0.0.0 or container IP — rewrite to cdp base host
  try {
    const base = new URL(cdpBaseUrl);
    const u = new URL(wsUrl);
    u.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    u.hostname = base.hostname;
    u.port = base.port;
    wsUrl = u.toString();
  } catch {
    /* keep */
  }

  const ws = new WebSocket(wsUrl, { maxPayload: 16 * 1024 * 1024 });
  const session = new CdpSession(ws);
  try {
    await waitWsOpen(ws);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("DOM.enable");
    await session.send("Accessibility.enable");
    return { session, target: page };
  } catch (err) {
    session.close();
    throw err;
  }
}

function flattenAxTree(root: unknown): BrowserSnapshotNode[] {
  const out: BrowserSnapshotNode[] = [];
  let counter = 0;

  const walk = (node: unknown, depth: number) => {
    if (out.length >= 200) return;
    if (!node || typeof node !== "object") return;
    const n = node as {
      role?: { value?: string };
      name?: { value?: string };
      value?: { value?: string };
      description?: { value?: string };
      backendDOMNodeId?: number;
      childIds?: string[];
      children?: unknown[];
      ignored?: boolean;
    };

    const role = n.role?.value ?? "unknown";
    const name = n.name?.value ?? "";
    const interesting =
      !n.ignored &&
      role !== "none" &&
      role !== "InlineTextBox" &&
      role !== "generic" &&
      (name ||
        [
          "button",
          "link",
          "textbox",
          "searchbox",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "menuitem",
          "tab",
          "heading",
          "img",
          "WebArea",
        ].includes(role));

    if (interesting) {
      counter += 1;
      out.push({
        ref: `e${counter}`,
        role,
        name: name.slice(0, 200),
        value: n.value?.value,
        description: n.description?.value,
        backendDOMNodeId: n.backendDOMNodeId,
        depth,
      });
    }

    const children = Array.isArray(n.children) ? n.children : [];
    for (const c of children) walk(c, depth + 1);
  };

  walk(root, 0);
  return out.slice(0, 200);
}

type Evaluation<T> = {
  result?: { value?: T; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

function evaluationValue<T>(result: Evaluation<T>): T {
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser JavaScript failed");
  }
  return result.result?.value as T;
}

async function evaluate<T>(session: CdpSession, expression: string): Promise<T> {
  return evaluationValue(await session.send<Evaluation<T>>("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }));
}

async function onElement<T>(session: CdpSession, objectId: string, functionDeclaration: string, values: unknown[] = []): Promise<T> {
  return evaluationValue(await session.send<Evaluation<T>>("Runtime.callFunctionOn", {
    objectId, functionDeclaration, arguments: values.map((value) => ({ value })),
    returnByValue: true, awaitPromise: true,
  }));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const coordinateSpace = "viewport CSS pixels, origin top-left of page content (excluding browser chrome)";

type BrowserState = {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
};

async function readState(session: CdpSession): Promise<BrowserState> {
  return evaluate<BrowserState>(session, `({ url: location.href, title: document.title, readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY } })`);
}

async function documentId(session: CdpSession): Promise<string> {
  const tree = await session.send<{ frameTree: { frame: { loaderId: string } } }>("Page.getFrameTree");
  return tree.frameTree.frame.loaderId;
}

function timeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 45_000) throw new Error("timeout must be an integer from 1 to 45000 milliseconds");
  return value;
}

type DocumentWait = { expected?: string; previous?: string; historyEntry?: number; allowLoading?: boolean };

async function waitForDocument(session: CdpSession, timeout: number, transition: DocumentWait = {}): Promise<BrowserState> {
  const deadline = Date.now() + timeout;
  do {
    try {
      const current = transition.expected || transition.previous ? await documentId(session) : undefined;
      const history = transition.historyEntry === undefined ? undefined
        : await session.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
      const atHistoryEntry = !history || history.entries[history.currentIndex]?.id === transition.historyEntry;
      if ((!transition.expected || current === transition.expected) && (!transition.previous || current !== transition.previous) && atHistoryEntry) {
        const state = await readState(session);
        if (transition.allowLoading || state.readyState === "complete") return state;
      }
    } catch (err) {
      // Navigation destroys contexts and BFCache restoration can briefly leave
      // Page.getNavigationHistory on an inactive frame. Retry these reads only;
      // method names such as "navigate" must not hide unrelated protocol errors.
      if (err instanceof CdpConnectionError || !/context.*destroyed|Cannot find context|Inspected target navigated|(?:frame|page) is navigating|Not attached to (?:an active )?page/i.test(String(err))) throw err;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new Error(`Browser document did not finish loading within ${timeout} ms. Use wait/observe before another action.`);
}

async function captureScreenshot(session: CdpSession, state: BrowserState, fullPage = false) {
  let cssWidth = state.viewport.width;
  let cssHeight = state.viewport.height;
  let clip: Record<string, number> | undefined;
  if (fullPage) {
    const layout = await session.send<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
    cssWidth = layout.cssContentSize.width;
    cssHeight = layout.cssContentSize.height;
    clip = { x: 0, y: 0, width: cssWidth, height: cssHeight, scale: 1 };
  }
  let shot: { data: string };
  let warning: string | undefined;
  try {
    shot = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
  } catch (err) {
    if (err instanceof CdpConnectionError) throw err;
    await session.send("Page.bringToFront");
    shot = await session.send("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false });
    warning = `Surface capture failed; returned a viewport screenshot. ${String(err).slice(0, 300)}`;
    fullPage = false;
    cssWidth = state.viewport.width;
    cssHeight = state.viewport.height;
  }
  const size = pngDimensions(shot.data);
  return {
    ...state, ...size, coordinateSpace, format: "png", base64Full: shot.data,
    fullPage, ...(warning ? { warning } : {}),
    // To click a screenshot point: pixel / screenshotScale + screenshotOrigin - viewport scroll.
    screenshotScale: { x: size.width / cssWidth, y: size.height / cssHeight },
    screenshotOrigin: { x: fullPage ? 0 : state.viewport.scrollX, y: fullPage ? 0 : state.viewport.scrollY },
  };
}

async function clickAt(session: CdpSession, x: number, y: number, double = false) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let clickCount = 1; clickCount <= (double ? 2 : 1); clickCount++) {
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
  }
}

async function pressKey(session: CdpSession, combo: string) {
  const keys: Record<string, [string, string, number]> = {
    Enter: ["Enter", "Enter", 13], Return: ["Enter", "Enter", 13], Tab: ["Tab", "Tab", 9],
    Escape: ["Escape", "Escape", 27], Esc: ["Escape", "Escape", 27], Backspace: ["Backspace", "Backspace", 8],
    Delete: ["Delete", "Delete", 46], ArrowLeft: ["ArrowLeft", "ArrowLeft", 37], ArrowUp: ["ArrowUp", "ArrowUp", 38],
    ArrowRight: ["ArrowRight", "ArrowRight", 39], ArrowDown: ["ArrowDown", "ArrowDown", 40],
    Home: ["Home", "Home", 36], End: ["End", "End", 35], PageUp: ["PageUp", "PageUp", 33], PageDown: ["PageDown", "PageDown", 34],
    Space: [" ", "Space", 32],
  };
  const parts = combo.split("+");
  const last = parts.pop()!;
  const modifiersByName: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };
  let modifiers = 0;
  for (const part of parts) {
    const bit = modifiersByName[part.toLowerCase()];
    if (!bit) throw new Error(`Unknown key modifier: ${part}`);
    modifiers |= bit;
  }
  const key = keys[last] ?? (last.length === 1
    ? [last, /^[a-z]$/i.test(last) ? `Key${last.toUpperCase()}` : /^\d$/.test(last) ? `Digit${last}` : "", last.toUpperCase().charCodeAt(0)] as [string, string, number]
    : /^F([1-9]|1\d|2[0-4])$/.test(last) ? [last, last, 111 + Number(last.slice(1))] as [string, string, number] : undefined);
  if (!key) throw new Error(`Unsupported key: ${combo}. Use Enter, Tab, ArrowDown, Control+a, etc.`);
  const params = { key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers };
  const text = !(modifiers & 7) ? (key[0] === "Enter" ? "\r" : key[0].length === 1 ? key[0] : undefined) : undefined;
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(text ? { text } : {}) });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

export type CdpResolveResult = { url: string | null; reason?: string };
export type CdpResolver = (agentId: string) => Promise<string | null | CdpResolveResult>;

type ObserveArgs = { observe: string; ref?: string; selector?: string; script?: string; full_page?: boolean; timeout?: number };
type ActionArgs = {
  action: string; url?: string; ref?: string; selector?: string; text?: string; key?: string; value?: string;
  direction?: string; amount?: number; tab_index?: number; timeout?: number; x?: number; y?: number; screenshot?: boolean;
};

type SnapshotRefs = { targetId: string; documentId: string; nodes: Map<string, BrowserSnapshotNode> };

export class AgentBrowserService {
  private selected = new Map<string, string>();
  private bases = new Map<string, string>();
  private refs = new Map<string, SnapshotRefs>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly getCdpBaseUrl: CdpResolver) {}

  private async serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(agentId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(agentId, pending);
    try { return await pending; }
    finally { if (this.queues.get(agentId) === pending) this.queues.delete(agentId); }
  }

  private async withSession<T>(agentId: string, readOnly: boolean, operation: (session: CdpSession, target: CdpTarget, base: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let session: CdpSession | undefined;
      try {
        const base = await this.requireCdp(agentId);
        const opened = await openSession(base, this.selected.get(agentId));
        session = opened.session;
        this.selected.set(agentId, opened.target.id);
        return await operation(session, opened.target, base);
      } catch (err) {
        if (err instanceof CdpConnectionError) {
          this.refs.delete(agentId);
          if (attempt === 0 && (readOnly || !session)) continue;
          if (!readOnly && session) throw new Error(`${err.message}. The browser action may have completed; reconnect with observe before repeating it.`);
        }
        throw err;
      } finally { session?.close(); }
    }
  }

  private async element(session: CdpSession, agentId: string, target: CdpTarget, args: { ref?: string; selector?: string }): Promise<string> {
    if (args.ref) {
      const snapshot = this.refs.get(agentId);
      if (!snapshot || snapshot.targetId !== target.id || snapshot.documentId !== await documentId(session)) {
        this.refs.delete(agentId);
        throw new Error("Snapshot refs are stale or belong to a different tab. Run browser_observe snapshot again.");
      }
      const node = snapshot.nodes.get(args.ref);
      if (!node?.backendDOMNodeId) throw new Error(`Unknown ref ${args.ref}; run browser_observe snapshot again.`);
      try {
        const result = await session.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
        if (result.object.objectId) return result.object.objectId;
      } catch (err) { if (err instanceof CdpConnectionError) throw err; }
      throw new Error(`Element ref ${args.ref} is no longer available. Run browser_observe snapshot again.`);
    }
    if (!args.selector) throw new Error("ref or selector required; run browser_observe snapshot first");
    const result = await session.send<Evaluation<unknown>>("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(args.selector)})` });
    evaluationValue(result);
    if (!result.result?.objectId) throw new Error(`Element not found for selector ${args.selector}`);
    return result.result.objectId;
  }

  private async point(session: CdpSession, agentId: string, target: CdpTarget, args: ActionArgs) {
    if (args.ref || args.selector) {
      const objectId = await this.element(session, agentId, target, args);
      return onElement<{ x: number; y: number }>(session, objectId, `function() {
        if (!this.isConnected) throw new Error('Element detached; observe a new snapshot');
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const b = this.getBoundingClientRect();
        const left = Math.max(0, b.left), right = Math.min(innerWidth, b.right);
        const top = Math.max(0, b.top), bottom = Math.min(innerHeight, b.bottom);
        if (right <= left || bottom <= top) throw new Error('Element is not visible; observe the page');
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }`);
    }
    const { viewport } = await readState(session);
    if (typeof args.x !== "number" || !Number.isFinite(args.x) || args.x < 0 || args.x >= viewport.width ||
        typeof args.y !== "number" || !Number.isFinite(args.y) || args.y < 0 || args.y >= viewport.height) {
      throw new Error("Provide a current ref/selector or x,y inside the viewport in CSS pixels.");
    }
    return { x: args.x, y: args.y };
  }

  private async snapshot(session: CdpSession, agentId: string, target: CdpTarget, state: BrowserState) {
    const loader = await documentId(session);
    const ax = await session.send<{ nodes?: Array<Record<string, any>> }>("Accessibility.getFullAXTree");
    const byId = new Map<string, Record<string, any>>();
    for (const node of ax.nodes ?? []) if (node.nodeId) byId.set(node.nodeId, { ...node, children: [] });
    for (const node of byId.values()) node.children = (node.childIds ?? []).map((id: string) => byId.get(id)).filter(Boolean);
    const root = [...byId.values()].find((node) => ["RootWebArea", "WebArea"].includes(node.role?.value)) ?? byId.values().next().value;
    const flat = flattenAxTree(root);
    this.refs.set(agentId, { targetId: target.id, documentId: loader, nodes: new Map(flat.map((node) => [node.ref, node])) });
    return {
      ...state, coordinateSpace, count: flat.length,
      snapshot: flat.map((node) => `${"  ".repeat(Math.min(node.depth, 6))}${node.ref} [${node.role}] ${node.name}${node.value ? ` = ${node.value}` : ""}`).join("\n"),
      items: flat.map(({ ref, role, name, value }) => ({ ref, role, name, value })),
    };
  }

  async observe(agentId: string, args: ObserveArgs): Promise<Record<string, any>> {
    return this.serial(agentId, async () => {
      const timeout = timeoutMs(args.timeout, 8000);
      if (args.observe === "tab_list") {
        const tabs = await listCdpTargets(await this.requireCdp(agentId));
        return { tabs: tabs.filter((tab) => tab.type === "page").map((tab, index) => ({ index, id: tab.id, title: tab.title, url: tab.url, selected: tab.id === this.selected.get(agentId) })) };
      }
      return this.withSession(agentId, args.observe !== "evaluate", async (session, target) => {
        if (args.observe === "evaluate") {
          if (!args.script) throw new Error("script required for evaluate");
          return { result: await evaluate(session, args.script) };
        }
        // Observation must remain possible after a navigation timeout, including
        // pages with a stalled image/script. Return their current readyState.
        const state = await waitForDocument(session, timeout, { allowLoading: true });
        switch (args.observe) {
          case "get_url": case "get_title": return { ...state, coordinateSpace };
          case "screenshot": return captureScreenshot(session, state, args.full_page);
          case "snapshot": return this.snapshot(session, agentId, target, state);
          case "screenshot_annotate":
            // Compatibility name: a snapshot plus an unmodified image, not drawn labels.
            return { ...await this.snapshot(session, agentId, target, state), ...await captureScreenshot(session, state, args.full_page) };
          case "get_content": case "get_html": {
            const html = args.observe === "get_html";
            const expression = html ? "this.outerHTML || ''" : "this.innerText || this.textContent || ''";
            const raw = args.ref || args.selector
              ? await onElement<string>(session, await this.element(session, agentId, target, args), `function() { return ${expression}; }`)
              : await evaluate<string>(session, html ? "document.documentElement?.outerHTML || ''" : "document.body?.innerText || ''");
            const limit = html ? 80_000 : 50_000;
            return { ...state, [html ? "html" : "text"]: String(raw).slice(0, limit), truncated: String(raw).length > limit };
          }
          default: throw new Error(`Unknown browser observation: ${args.observe}`);
        }
      });
    });
  }

  async action(agentId: string, args: ActionArgs): Promise<Record<string, any>> {
    return this.serial(agentId, async () => {
      const timeout = timeoutMs(args.timeout, args.action === "wait" ? 1000 : 8000);
      if (["tab_new", "tab_select", "tab_close"].includes(args.action)) {
        const base = await this.requireCdp(agentId);
        if (args.action === "tab_new") {
          const url = `${base.replace(/\/$/, "")}/json/new?${encodeURIComponent(args.url || "about:blank")}`;
          let response = await fetch(url, { method: "PUT", signal: AbortSignal.timeout(10_000) });
          if (response.status === 405) response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`tab_new failed: ${response.status}`);
          this.selected.set(agentId, ((await response.json()) as CdpTarget).id);
        } else {
          const tabs = (await listCdpTargets(base)).filter((tab) => tab.type === "page");
          const index = args.tab_index ?? 0;
          if (!Number.isInteger(index) || index < 0 || !tabs[index]) throw new Error(`No tab at index ${index}`);
          const tab = tabs[index]!;
          if (args.action === "tab_close") {
            const response = await fetch(`${base.replace(/\/$/, "")}/json/close/${encodeURIComponent(tab.id)}`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`tab_close failed: ${response.status}`);
            if (this.selected.get(agentId) === tab.id) { this.selected.delete(agentId); this.refs.delete(agentId); }
            return { ok: true, closed: tab.id };
          }
          this.selected.set(agentId, tab.id);
        }
        this.refs.delete(agentId);
        return this.withSession(agentId, false, async (session, target) => {
          await session.send("Page.bringToFront");
          const state = await waitForDocument(session, timeout);
          return { ok: true, selected: { id: target.id, url: state.url, title: state.title }, ...state, coordinateSpace,
            ...(args.screenshot ? await captureScreenshot(session, state) : {}) };
        });
      }
      return this.withSession(agentId, false, async (session, target) => {
        let state: BrowserState | undefined;
        const extra: Record<string, unknown> = {};
        switch (args.action) {
          case "navigate": {
            if (!args.url) throw new Error("url required for navigate");
            this.refs.delete(agentId);
            const navigation = await session.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url: args.url });
            if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
            state = await waitForDocument(session, timeout, { expected: navigation.loaderId });
            break;
          }
          case "reload": case "go_back": case "go_forward": {
            this.refs.delete(agentId);
            if (args.action === "reload") {
              const previous = await documentId(session);
              await session.send("Page.reload");
              state = await waitForDocument(session, timeout, { previous });
            } else {
              const history = await session.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
              const entry = history.entries[history.currentIndex + (args.action === "go_back" ? -1 : 1)];
              if (!entry) { extra.navigated = false; break; }
              await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
              // hash/pushState history changes keep the same loader. The active
              // history entry confirms navigation even when its URL is unchanged.
              state = await waitForDocument(session, timeout, { historyEntry: entry.id });
            }
            break;
          }
          case "wait": {
            const started = Date.now();
            if (!args.ref && !args.selector) await delay(timeout);
            else {
              const deadline = Date.now() + timeout;
              for (;;) {
                try {
                  const element = await this.element(session, agentId, target, args);
                  const visible = await onElement<boolean>(session, element, "function() { return this.isConnected && this.getClientRects().length > 0; }");
                  if (visible) break;
                } catch (err) { if (err instanceof CdpConnectionError || args.ref) throw err; }
                if (Date.now() >= deadline) throw new Error(`Element did not become visible within ${timeout} ms; observe the page.`);
                await delay(Math.min(100, deadline - Date.now()));
              }
            }
            extra.waitedMs = Date.now() - started;
            state = await readState(session);
            break;
          }
          case "focus": {
            const element = await this.element(session, agentId, target, args);
            await onElement(session, element, "function() { this.focus(); if (this.ownerDocument.activeElement !== this && this.getRootNode().activeElement !== this) throw new Error('Element could not be focused'); }");
            break;
          }
          case "click": case "double_click": case "hover": {
            const point = await this.point(session, agentId, target, args);
            if (args.action === "hover") await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
            else await clickAt(session, point.x, point.y, args.action === "double_click");
            Object.assign(extra, point);
            break;
          }
          case "type": case "fill": {
            const text = args.text ?? args.value;
            if (typeof text !== "string" || text.length > 20_000) throw new Error("text or value must be supplied, at most 20000 characters");
            const element = args.ref || args.selector
              ? await this.element(session, agentId, target, args)
              : (await session.send<Evaluation<unknown>>("Runtime.evaluate", { expression: "(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; })()" })).result?.objectId;
            if (!element) throw new Error("No focused editable element; observe and focus a textbox first.");
            await onElement(session, element, `function() {
              if (!this.isConnected || typeof this.focus !== 'function') throw new Error('Element is not focusable; observe a textbox ref');
              if ((!this.matches('input, textarea') && !this.isContentEditable) || this.disabled || this.readOnly) throw new Error('Element is not editable');
              if (this.tagName === 'INPUT' && !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(this.type)) throw new Error('Input does not accept typed text');
              this.focus();
              if (this.ownerDocument.activeElement !== this && this.getRootNode().activeElement !== this) throw new Error('Element could not be focused');
            }`);
            if (args.action === "fill") {
              await pressKey(session, "Control+a");
              await pressKey(session, "Backspace");
            }
            if (text) await session.send("Input.insertText", { text });
            break;
          }
          case "press": {
            if (args.ref || args.selector) {
              const element = await this.element(session, agentId, target, args);
              await onElement(session, element, "function() { this.focus(); if (this.ownerDocument.activeElement !== this && this.getRootNode().activeElement !== this) throw new Error('Element could not be focused'); }");
            }
            await pressKey(session, args.key ?? "Enter");
            break;
          }
          case "select": {
            if (typeof args.value !== "string") throw new Error("value required for select");
            const element = await this.element(session, agentId, target, args);
            await onElement(session, element, `function(value) {
              if (this.tagName !== 'SELECT') throw new Error('Element is not a select');
              if (!Array.from(this.options).some(option => option.value === value)) throw new Error('Option not found');
              this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
            }`, [args.value]);
            break;
          }
          case "scroll_into_view": {
            const element = await this.element(session, agentId, target, args);
            await onElement(session, element, "function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }");
            break;
          }
          case "scroll": {
            const direction = args.direction ?? "down";
            const amount = args.amount ?? 500;
            if (!["up", "down", "left", "right"].includes(direction) || !Number.isInteger(amount) || amount < 1 || amount > 5000) throw new Error("scroll needs a valid direction and amount from 1 to 5000 CSS pixels");
            const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
            const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
            const viewport = (await readState(session)).viewport;
            const point = args.ref || args.selector || args.x !== undefined || args.y !== undefined
              ? await this.point(session, agentId, target, args) : { x: viewport.width / 2, y: viewport.height / 2 };
            await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: dx, deltaY: dy });
            Object.assign(extra, { dx, dy });
            break;
          }
          default: throw new Error(`Unknown browser action: ${args.action}`);
        }
        state ??= await waitForDocument(session, timeout);
        let screenshot;
        if (args.screenshot) {
          try { screenshot = await captureScreenshot(session, state); }
          catch (err) { throw new Error(`${args.action} completed, but its screenshot failed. Observe before repeating the action. ${String(err)}`); }
        }
        return { ok: true, ...extra, ...state, coordinateSpace, ...screenshot };
      });
    });
  }

  private async requireCdp(agentId: string): Promise<string> {
    const raw = await this.getCdpBaseUrl(agentId);
    const base = typeof raw === "string" || raw == null ? raw : raw.url;
    if (!base) throw new Error(typeof raw === "object" && raw?.reason ? raw.reason : "Browser CDP unavailable. Enable the computer workspace and wait for Chromium to start.");
    if (!await cdpReady(base)) throw new CdpConnectionError("Chromium CDP is not ready. Check workspace display/Chrome startup logs and retry observe.");
    // Reset stale state before tab_new/tab_select sets a new selection.
    if (this.bases.has(agentId) && this.bases.get(agentId) !== base) {
      this.selected.delete(agentId);
      this.refs.delete(agentId);
    }
    this.bases.set(agentId, base);
    return base;
  }
}
