import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { AgentBrowserService } from "../src/services/agent-cdp.js";

// Optional real-browser checks. No external website, credentials or Docker required.
const options = {
  skip: !process.env.ZAKURA_TEST_CHROMIUM,
  timeout: 30_000,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zakura-chromium-test-"));
  const server = createServer((req, res) => {
    if (req.url === "/never-finish.js") return;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>${req.url}</title>
      <label>Name <input id="name" value="old"></label>
      <input id="disabled" disabled value="keep">
      <label>Choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
      <button id="counter" onclick="window.clicks.push(event.detail)">Count</button>
      <div style="height:1500px"></div><button id="below" onclick="window.belowClicked=true">Below fold</button>
      <script>window.clicks=[]</script>${req.url === "/loading" ? '<script src="/never-finish.js"></script>' : ''}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chrome = spawn(process.env.ZAKURA_TEST_CHROMIUM!, [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=0", "--window-size=800,600", `--user-data-dir=${root}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => {
    chrome.kill("SIGKILL");
    if (chrome.exitCode === null) await new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Chromium children can finish profile writes just after the main PID exits.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const base = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${log}`)), 10_000);
    chrome.once("error", (err) => { clearTimeout(timer); reject(err); });
    chrome.once("exit", () => { clearTimeout(timer); reject(new Error(log)); });
    chrome.stderr.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-8000);
      const match = log.match(/DevTools listening on ws:\/\/([^/]+)/);
      if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
    });
  });
  const browser = new AgentBrowserService(async () => base);
  const read = async (script: string) => (await browser.observe("agent", { observe: "evaluate", script })).result;
  return { browser, url, read };
}

it("operates a real Chromium page across screenshots, refs, navigation and tabs", options, async (t) => {
  const { browser, url, read } = await fixture(t);
  await browser.action("agent", { action: "navigate", url: `${url}/one` });
  const snapshot = await browser.observe("agent", { observe: "snapshot" });
  const ref = (name: string) => snapshot.items.find((item: { name: string; role: string }) => item.name.trim() === name && ["textbox", "combobox", "button"].includes(item.role))?.ref;
  assert.ok(ref("Name"));
  await browser.action("agent", { action: "fill", ref: ref("Name"), value: "你好 🌍\"$" });
  assert.equal(await read("document.querySelector('#name').value"), "你好 🌍\"$");
  await browser.action("agent", { action: "fill", ref: ref("Name"), text: "" });
  assert.equal(await read("document.querySelector('#name').value"), "");
  await browser.action("agent", { action: "focus", ref: ref("Name") });
  await browser.action("agent", { action: "type", text: "again" });
  assert.equal(await read("document.querySelector('#name').value"), "again");
  await assert.rejects(browser.action("agent", { action: "fill", selector: "#disabled", text: "wrong field" }), /not editable/);
  assert.equal(await read("document.querySelector('#name').value"), "again");
  await browser.action("agent", { action: "select", ref: ref("Choice"), value: "b" });
  assert.equal(await read("document.querySelector('#choice').value"), "b");
  await browser.action("agent", { action: "double_click", ref: ref("Count") });
  assert.deepEqual(await read("window.clicks"), [1, 2]);
  await browser.action("agent", { action: "click", ref: ref("Below fold"), screenshot: true });
  assert.equal(await read("window.belowClicked"), true);
  const shot = await browser.observe("agent", { observe: "screenshot" });
  assert.equal(shot.width, shot.viewport.width);
  assert.equal(shot.height, shot.viewport.height);
  const full = await browser.observe("agent", { observe: "screenshot", full_page: true });
  assert.ok(full.height > shot.height);
  await browser.action("agent", { action: "navigate", url: `${url}/two` });
  await assert.rejects(browser.action("agent", { action: "fill", ref: ref("Name"), value: "stale" }), /stale|snapshot/i);
  await browser.action("agent", { action: "go_back" });
  assert.equal((await browser.observe("agent", { observe: "get_url" })).url, `${url}/one`);
  await browser.action("agent", { action: "reload" });
  await browser.action("agent", { action: "tab_new", url: `${url}/new-tab` });
  assert.equal((await browser.observe("agent", { observe: "get_url" })).url, `${url}/new-tab`);
  const tabs = (await browser.observe("agent", { observe: "tab_list" })).tabs;
  const original = tabs.find((tab: { url: string }) => tab.url === `${url}/one`);
  await browser.action("agent", { action: "tab_select", tab_index: original.index });
  assert.equal((await browser.observe("agent", { observe: "get_url" })).url, `${url}/one`);
});

it("navigates same-document history entries without waiting for a new loader", options, async (t) => {
  const { browser, url, read } = await fixture(t);
  await browser.action("agent", { action: "navigate", url: `${url}/history` });
  await read("history.pushState({step:1}, '', '#one'); history.pushState({step:2}, '', '#two')");
  const back = await browser.action("agent", { action: "go_back", timeout: 500 });
  assert.equal(back.url, `${url}/history#one`);
  const forward = await browser.action("agent", { action: "go_forward", timeout: 500 });
  assert.equal(forward.url, `${url}/history#two`);
  await read("history.pushState({step:3}, '', location.href)");
  await browser.action("agent", { action: "go_back", timeout: 500 });
  assert.equal(await read("history.state.step"), 2);
});

it("captures the current screen after a navigation times out on a stalled resource", options, async (t) => {
  const { browser, url } = await fixture(t);
  await assert.rejects(browser.action("agent", { action: "navigate", url: `${url}/loading`, timeout: 500 }), /did not finish loading/);
  const shot = await browser.observe("agent", { observe: "screenshot", timeout: 500 });
  assert.equal(shot.readyState, "loading");
  assert.ok(shot.base64Full.length > 100);
  const snapshot = await browser.observe("agent", { observe: "snapshot", timeout: 500 });
  assert.ok(snapshot.items.some((item: { name: string }) => item.name.trim() === "Name"));
});
