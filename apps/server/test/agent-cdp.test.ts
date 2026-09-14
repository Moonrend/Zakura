import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it, type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { AgentBrowserService } from "../src/services/agent-cdp.js";
import { makePng } from "./helpers/png.js";

async function fixture(t: TestContext) {
  const pages = ["a", "b"].map((id) => ({ id, type: "page", title: `Page ${id}`, url: `https://example.test/${id}`, webSocketDebuggerUrl: "" }));
  const commands: Array<{ tab: string; method: string; params: Record<string, any> }> = [];
  const state = { surfaceFails: false, disconnect: "", evaluateError: false, loader: 1, empty: false };
  const png = makePng(80, 60);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/json/new")) {
      state.empty = false;
      res.end(JSON.stringify(pages[0]));
    } else if (req.url === "/json/list") res.end(JSON.stringify(state.empty ? [] : pages));
    else if (req.url?.startsWith("/json/close/")) res.end("true");
    else res.end(JSON.stringify({ Browser: "Test Chromium" }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const tab = req.url!.split("/").at(-1)!;
    ws.on("message", (raw) => {
      const { id, method, params } = JSON.parse(raw.toString());
      commands.push({ tab, method, params });
      if (state.disconnect === method) {
        state.disconnect = "";
        ws.close();
        return;
      }
      let result: unknown = {};
      if (method === "Page.captureScreenshot") {
        if (state.surfaceFails && params.fromSurface !== false) {
          ws.send(JSON.stringify({ id, error: { message: "Unable to capture screenshot from surface" } }));
          return;
        }
        result = { data: png };
      } else if (method === "Page.getFrameTree") result = { frameTree: { frame: { id: tab, loaderId: `loader-${state.loader}` } } };
      else if (method === "Page.getLayoutMetrics") result = { cssContentSize: { width: 80, height: 600 }, cssVisualViewport: { clientWidth: 80, clientHeight: 60, pageX: 0, pageY: 0 } };
      else if (method === "Page.navigate") {
        if (params.url === "bad:") result = { errorText: "net::ERR_NAME_NOT_RESOLVED" };
        else {
          pages.find((p) => p.id === tab)!.url = params.url;
          state.loader++;
          result = { loaderId: `loader-${state.loader}` };
        }
      } else if (method === "Runtime.evaluate") {
        if (state.evaluateError) result = { exceptionDetails: { text: "Uncaught", exception: { description: "Error: broken script" } } };
        else if (params.expression === "document.title") result = { result: { value: `Page ${tab}` } };
        else result = { result: { value: { url: pages.find((p) => p.id === tab)!.url, title: `Page ${tab}`, readyState: "complete", viewport: { width: 80, height: 60, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } } } };
      } else if (method === "Accessibility.getFullAXTree") result = { nodes: [
        { nodeId: "root", role: { value: "RootWebArea" }, name: { value: `Page ${tab}` }, childIds: ["input"] },
        { nodeId: "input", role: { value: "textbox" }, name: { value: "Name" }, backendDOMNodeId: 42 },
      ] };
      else if (method === "DOM.resolveNode") result = { object: { objectId: "object-42" } };
      else if (method === "DOM.getBoxModel") result = { model: { content: [1, 1, 20, 1, 20, 20, 1, 20] } };
      else if (method === "Runtime.callFunctionOn") result = { result: { value: { x: 10, y: 10 } } };
      ws.send(JSON.stringify({ id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  for (const page of pages) page.webSocketDebuggerUrl = `ws://0.0.0.0:9222/devtools/page/${page.id}`;
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { service: new AgentBrowserService(async () => base), commands, state, png };
}

describe("browser CDP regression coverage", () => {
  it("works without a global WebSocket (Node 20)", async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: undefined });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor); else delete (globalThis as any).WebSocket; });
    const { service } = await fixture(t);
    assert.equal((await service.observe("agent", { observe: "get_title" })).title, "Page a");
  });

  it("keeps the selected tab across actions and observations", async (t) => {
    const { service } = await fixture(t);
    await service.action("agent", { action: "tab_select", tab_index: 1 });
    const result = await service.observe("agent", { observe: "get_title" });
    assert.equal(result.title, "Page b");
  });

  it("fills the supplied value through a snapshot ref with Unicode intact", async (t) => {
    const { service, commands } = await fixture(t);
    const snapshot = await service.observe("agent", { observe: "snapshot" });
    const ref = snapshot.items!.find((item) => item.role === "textbox")!.ref;
    await service.action("agent", { action: "fill", ref, value: "你好 🌍" });
    assert.ok(commands.some((c) => c.method === "Input.insertText" && c.params.text === "你好 🌍"));
  });

  it("rejects stale refs without typing into the currently focused element", async (t) => {
    const { service, commands } = await fixture(t);
    await assert.rejects(service.action("agent", { action: "fill", ref: "e999", value: "do not type" }), /ref|snapshot/);
    assert.ok(!commands.some((c) => c.method.startsWith("Input.")));
  });

  it("falls back to a viewport screenshot when surface capture fails", async (t) => {
    const { service, state, commands, png } = await fixture(t);
    state.surfaceFails = true;
    const result = await service.observe("agent", { observe: "screenshot", full_page: true });
    assert.equal(result.base64Full, png);
    assert.equal(result.width, 80);
    assert.equal(result.height, 60);
    assert.ok(commands.some((c) => c.method === "Page.captureScreenshot" && c.params.fromSurface === false));
  });

  it("reconnects a failed read without replaying a mutating action", async (t) => {
    const { service, state, commands } = await fixture(t);
    state.disconnect = "Runtime.evaluate";
    assert.equal((await service.observe("agent", { observe: "get_title" })).title, "Page a");
    await service.observe("agent", { observe: "snapshot" });
    state.disconnect = "Input.dispatchMouseEvent";
    await assert.rejects(service.action("agent", { action: "click", ref: "e2" }), /closed|connection|observe/i);
    assert.equal(commands.filter((c) => c.method === "Input.dispatchMouseEvent").length, 1);
  });

  it("reports navigation and evaluation errors instead of success", async (t) => {
    const { service, state } = await fixture(t);
    await assert.rejects(service.action("agent", { action: "navigate", url: "bad:" }), /ERR_NAME_NOT_RESOLVED/);
    state.evaluateError = true;
    await assert.rejects(service.observe("agent", { observe: "evaluate", script: "throw new Error('broken script')" }), /broken script/);
  });

  it("can create a page when Chromium has no open tabs", async (t) => {
    const { service, state } = await fixture(t);
    state.empty = true;
    assert.equal((await service.observe("agent", { observe: "get_title" })).title, "Page a");
  });
});
