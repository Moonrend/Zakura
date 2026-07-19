/**
 * Lightweight Chrome DevTools Protocol client for agent Browser Use.
 * Connects to Chromium inside the workspace container via published host port.
 */

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
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

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
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? "CDP error"));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        /* ignore */
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error("CDP session closed");
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45_000);
    });
  }

  close(): void {
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
    const t = setTimeout(() => reject(new Error("WebSocket open timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("WebSocket connection failed"));
    });
  });
}

export async function listCdpTargets(cdpBaseUrl: string): Promise<CdpTarget[]> {
  const base = cdpBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CDP /json/list failed: ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

export async function cdpReady(cdpBaseUrl: string): Promise<boolean> {
  try {
    const targets = await listCdpTargets(cdpBaseUrl);
    return targets.length > 0;
  } catch {
    return false;
  }
}

async function openSession(cdpBaseUrl: string, targetId?: string): Promise<{
  session: CdpSession;
  target: CdpTarget;
}> {
  const targets = await listCdpTargets(cdpBaseUrl);
  let page =
    (targetId ? targets.find((t) => t.id === targetId) : undefined) ??
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
    targets.find((t) => t.webSocketDebuggerUrl);

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
    u.hostname = base.hostname;
    u.port = base.port;
    wsUrl = u.toString();
  } catch {
    /* keep */
  }

  const ws = new WebSocket(wsUrl);
  await waitWsOpen(ws);
  const session = new CdpSession(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable").catch(() => undefined);
  await session.send("Accessibility.enable").catch(() => undefined);
  return { session, target: page };
}

function flattenAxTree(root: unknown): BrowserSnapshotNode[] {
  const out: BrowserSnapshotNode[] = [];
  let counter = 0;

  const walk = (node: unknown, depth: number) => {
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

async function resolveRefClickable(
  session: CdpSession,
  refMap: Map<string, BrowserSnapshotNode>,
  ref: string,
): Promise<{ x: number; y: number } | null> {
  const node = refMap.get(ref);
  if (!node?.backendDOMNodeId) return null;
  try {
    const box = await session.send<{
      model?: { content?: number[] };
    }>("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
    const content = box.model?.content;
    if (!content || content.length < 8) return null;
    // content quad: x1,y1,x2,y2,x3,y3,x4,y4
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
    const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
    return { x, y };
  } catch {
    return null;
  }
}

async function clickAt(session: CdpSession, x: number, y: number, double = false) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  const click = async () => {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: double ? 2 : 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: double ? 2 : 1,
    });
  };
  await click();
  if (double) await click();
}

async function typeText(session: CdpSession, text: string) {
  for (const ch of text) {
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      unmodifiedText: ch,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      text: ch,
      unmodifiedText: ch,
    });
  }
}

/** Per-agent last snapshot refs (in-process). */
const agentRefMaps = new Map<string, Map<string, BrowserSnapshotNode>>();

export type CdpResolveResult = {
  url: string | null;
  reason?: string;
};

export type CdpResolver = (agentId: string) => Promise<string | null | CdpResolveResult>;

export class AgentBrowserService {
  constructor(private readonly getCdpBaseUrl: CdpResolver) {}

  async observe(
    agentId: string,
    args: {
      observe: string;
      ref?: string;
      selector?: string;
      script?: string;
      full_page?: boolean;
    },
  ) {
    const base = await this.requireCdp(agentId);
    const { session, target } = await openSession(base);
    try {
      switch (args.observe) {
        case "get_url":
          return { url: target.url, title: target.title };
        case "get_title": {
          const r = await session.send<{ result?: { value?: string } }>("Runtime.evaluate", {
            expression: "document.title",
            returnByValue: true,
          });
          return { title: r.result?.value ?? target.title, url: target.url };
        }
        case "tab_list": {
          const tabs = await listCdpTargets(base);
          return {
            tabs: tabs
              .filter((t) => t.type === "page")
              .map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url })),
          };
        }
        case "screenshot": {
          const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: Boolean(args.full_page),
          });
          return {
            format: "png",
            base64Length: shot.data.length,
            base64Full: shot.data,
            url: target.url,
          };
        }
        case "get_content": {
          const expr = args.selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`
            : `document.body ? document.body.innerText : ''`;
          const r = await session.send<{ result?: { value?: string } }>("Runtime.evaluate", {
            expression: expr,
            returnByValue: true,
          });
          const text = String(r.result?.value ?? "").slice(0, 50_000);
          return { text, url: target.url, truncated: text.length >= 50_000 };
        }
        case "get_html": {
          const expr = args.selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return el ? el.outerHTML : ''; })()`
            : `document.documentElement ? document.documentElement.outerHTML : ''`;
          const r = await session.send<{ result?: { value?: string } }>("Runtime.evaluate", {
            expression: expr,
            returnByValue: true,
          });
          const html = String(r.result?.value ?? "").slice(0, 80_000);
          return { html, url: target.url, truncated: html.length >= 80_000 };
        }
        case "evaluate": {
          if (!args.script) throw new Error("script required for evaluate");
          const r = await session.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            {
              expression: args.script,
              returnByValue: true,
              awaitPromise: true,
            },
          );
          if (r.exceptionDetails) {
            return { error: r.exceptionDetails, url: target.url };
          }
          return { result: r.result?.value, url: target.url };
        }
        case "snapshot":
        case "screenshot_annotate":
        default: {
          const ax = await session.send<{ nodes?: unknown[] }>("Accessibility.getFullAXTree");
          // CDP returns flat nodes with childIds; build tree roots
          const nodes = ax.nodes ?? [];
          const byId = new Map<string, Record<string, unknown>>();
          for (const raw of nodes) {
            const n = raw as { nodeId?: string; childIds?: string[] };
            if (n.nodeId) byId.set(n.nodeId, { ...(raw as object), children: [] });
          }
          for (const raw of nodes) {
            const n = raw as { nodeId?: string; childIds?: string[] };
            if (!n.nodeId) continue;
            const parent = byId.get(n.nodeId);
            if (!parent) continue;
            const kids: unknown[] = [];
            for (const cid of n.childIds ?? []) {
              const child = byId.get(cid);
              if (child) kids.push(child);
            }
            parent.children = kids;
          }
          const root =
            [...byId.values()].find((n) => (n.role as { value?: string })?.value === "RootWebArea") ??
            [...byId.values()].find((n) => (n.role as { value?: string })?.value === "WebArea") ??
            [...byId.values()][0];

          const flat = flattenAxTree(root);
          const map = new Map(flat.map((f) => [f.ref, f]));
          agentRefMaps.set(agentId, map);

          const lines = flat.map(
            (f) =>
              `${"  ".repeat(Math.min(f.depth, 6))}${f.ref} [${f.role}] ${f.name}${f.value ? ` = ${f.value}` : ""}`,
          );

          let screenshot: string | undefined;
          if (args.observe === "screenshot_annotate") {
            const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
            });
            screenshot = shot.data;
          }

          return {
            url: target.url,
            title: target.title,
            count: flat.length,
            snapshot: lines.join("\n"),
            items: flat.map(({ ref, role, name, value }) => ({ ref, role, name, value })),
            ...(screenshot
              ? { screenshotBase64Length: screenshot.length, screenshotBase64Full: screenshot }
              : {}),
          };
        }
      }
    } finally {
      session.close();
    }
  }

  async action(
    agentId: string,
    args: {
      action: string;
      url?: string;
      ref?: string;
      selector?: string;
      text?: string;
      key?: string;
      value?: string;
      direction?: string;
      amount?: number;
      tab_index?: number;
      timeout?: number;
    },
  ) {
    const base = await this.requireCdp(agentId);
    const action = args.action;

    if (action === "tab_new") {
      const url = args.url || "about:blank";
      const res = await fetch(`${base.replace(/\/$/, "")}/json/new?${encodeURIComponent(url)}`, {
        method: "PUT",
        signal: AbortSignal.timeout(10_000),
      }).catch(async () =>
        fetch(`${base.replace(/\/$/, "")}/json/new?${encodeURIComponent(url)}`, {
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!res.ok) throw new Error(`tab_new failed: ${res.status}`);
      const t = (await res.json()) as CdpTarget;
      return { ok: true, tab: { id: t.id, url: t.url, title: t.title } };
    }

    if (action === "tab_select" || action === "tab_close") {
      const tabs = (await listCdpTargets(base)).filter((t) => t.type === "page");
      const idx = args.tab_index ?? 0;
      const tab = tabs[idx];
      if (!tab) throw new Error(`No tab at index ${idx}`);
      if (action === "tab_close") {
        await fetch(`${base.replace(/\/$/, "")}/json/close/${tab.id}`, {
          signal: AbortSignal.timeout(5000),
        });
        return { ok: true, closed: tab.id };
      }
      // Activate: connect and bring to front
      const { session } = await openSession(base, tab.id);
      try {
        await session.send("Page.bringToFront").catch(() => undefined);
        return { ok: true, selected: { id: tab.id, url: tab.url, title: tab.title } };
      } finally {
        session.close();
      }
    }

    const { session, target } = await openSession(base);
    try {
      const refMap = agentRefMaps.get(agentId) ?? new Map();

      switch (action) {
        case "navigate": {
          if (!args.url) throw new Error("url required for navigate");
          await session.send("Page.navigate", { url: args.url });
          await session.send("Runtime.evaluate", {
            expression: `new Promise(r => { if (document.readyState === 'complete') r(true); else window.addEventListener('load', () => r(true)); setTimeout(() => r(false), ${args.timeout ?? 8000}); })`,
            awaitPromise: true,
            returnByValue: true,
          });
          const tabs = await listCdpTargets(base);
          const cur = tabs.find((t) => t.id === target.id) ?? tabs.find((t) => t.type === "page");
          return { ok: true, url: cur?.url ?? args.url, title: cur?.title };
        }
        case "go_back":
          await session.send("Runtime.evaluate", {
            expression: "history.back()",
            returnByValue: true,
          });
          return { ok: true };
        case "go_forward":
          await session.send("Runtime.evaluate", {
            expression: "history.forward()",
            returnByValue: true,
          });
          return { ok: true };
        case "reload":
          await session.send("Page.reload");
          return { ok: true };
        case "wait":
          await new Promise((r) => setTimeout(r, Math.min(45_000, args.timeout ?? 1000)));
          return { ok: true, waitedMs: args.timeout ?? 1000 };
        case "click":
        case "double_click":
        case "focus":
        case "hover": {
          let point: { x: number; y: number } | null = null;
          if (args.ref) point = await resolveRefClickable(session, refMap, args.ref);
          if (!point && args.selector) {
            const r = await session.send<{ result?: { value?: { x: number; y: number } | null } }>(
              "Runtime.evaluate",
              {
                expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`,
                returnByValue: true,
              },
            );
            point = r.result?.value ?? null;
          }
          if (!point) throw new Error("Could not resolve ref/selector to coordinates; run browser_observe snapshot first");
          if (action === "hover" || action === "focus") {
            await session.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: point.x,
              y: point.y,
            });
            if (action === "focus" && args.selector) {
              await session.send("Runtime.evaluate", {
                expression: `document.querySelector(${JSON.stringify(args.selector)})?.focus()`,
              });
            }
            return { ok: true, x: point.x, y: point.y };
          }
          await clickAt(session, point.x, point.y, action === "double_click");
          return { ok: true, x: point.x, y: point.y };
        }
        case "type":
        case "fill": {
          if (args.ref || args.selector) {
            // focus first
            let point: { x: number; y: number } | null = null;
            if (args.ref) point = await resolveRefClickable(session, refMap, args.ref);
            if (!point && args.selector) {
              const r = await session.send<{
                result?: { value?: { x: number; y: number } | null };
              }>("Runtime.evaluate", {
                expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return null; el.focus(); const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`,
                returnByValue: true,
              });
              point = r.result?.value ?? null;
            }
            if (point) await clickAt(session, point.x, point.y);
          }
          if (action === "fill") {
            // Select all + type
            await session.send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "a",
              code: "KeyA",
              modifiers: 2, // ctrl
              windowsVirtualKeyCode: 65,
            });
            await session.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "a",
              code: "KeyA",
              modifiers: 2,
              windowsVirtualKeyCode: 65,
            });
          }
          await typeText(session, String(args.text ?? ""));
          return { ok: true };
        }
        case "press": {
          const key = String(args.key ?? "Enter");
          // Simple key names
          await session.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            text: key.length === 1 ? key : undefined,
          });
          await session.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
          });
          return { ok: true, key };
        }
        case "select": {
          if (!args.selector && !args.ref) throw new Error("selector or ref required for select");
          const sel = args.selector
            ? `document.querySelector(${JSON.stringify(args.selector)})`
            : null;
          if (!sel) throw new Error("select currently requires selector");
          await session.send("Runtime.evaluate", {
            expression: `(() => { const el = ${sel}; if (!el) throw new Error('not found'); el.value = ${JSON.stringify(args.value ?? "")}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`,
            returnByValue: true,
          });
          return { ok: true };
        }
        case "scroll":
        case "scroll_into_view": {
          if (args.ref || args.selector) {
            if (args.selector) {
              await session.send("Runtime.evaluate", {
                expression: `document.querySelector(${JSON.stringify(args.selector)})?.scrollIntoView({ block: 'center' })`,
              });
            } else if (args.ref) {
              const point = await resolveRefClickable(session, refMap, args.ref);
              if (point) {
                await session.send("Runtime.evaluate", {
                  expression: `window.scrollBy(0, ${point.y - 200})`,
                });
              }
            }
            return { ok: true };
          }
          const dir = args.direction ?? "down";
          const amount = args.amount ?? 500;
          const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
          const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
          await session.send("Runtime.evaluate", {
            expression: `window.scrollBy(${dx}, ${dy})`,
          });
          return { ok: true, dx, dy };
        }
        default:
          throw new Error(`Unknown browser action: ${action}`);
      }
    } finally {
      session.close();
    }
  }

  private async requireCdp(agentId: string): Promise<string> {
    const raw = await this.getCdpBaseUrl(agentId);
    const base = typeof raw === "string" || raw == null ? raw : raw.url;
    const reason =
      typeof raw === "object" && raw && "reason" in raw ? raw.reason : undefined;

    if (!base) {
      throw new Error(
        reason && reason !== "ok"
          ? reason
          : "Browser CDP 不可用。请确认 Agent 已开启浏览器，并已启动工作区。",
      );
    }
    const ready = await cdpReady(base);
    if (!ready) {
      throw new Error(
        `Chromium CDP 尚未就绪（${base}）。请稍等几秒后重试，或到工作区页查看启动日志。`,
      );
    }
    return base;
  }
}
