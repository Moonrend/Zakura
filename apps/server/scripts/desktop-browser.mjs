// SPDX-License-Identifier: AGPL-3.0-or-later
// A dependency-free CDP driver for the isolated desktop integration fixture.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const target = new URL(args.get("--url"));
if (target.hostname !== "127.0.0.1" || !args.get("--chrome")) {
  throw new Error("a loopback fixture URL and an explicit Chrome binary are required");
}
const profile = await mkdtemp(path.join(tmpdir(), "zakura-desktop-browser-"));
const chrome = spawn(args.get("--chrome"), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const exited = new Promise(resolve => chrome.once("exit", resolve));
let logs = "";
chrome.stderr.on("data", data => { logs = (logs + data).slice(-20000); });
let browser, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    const waiting = pending.get(value.id);
    if (!waiting) return;
    pending.delete(value.id);
    clearTimeout(waiting.timer);
    if (value.error) waiting.reject(new Error(JSON.stringify(value.error)));
    else waiting.resolve(value.result);
  });
  socket.addEventListener("close", () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("Chrome disconnected"));
    }
    pending.clear();
  });
  return {
    async call(method, params = {}) {
      const callID = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(callID); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
        pending.set(callID, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: callID, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

try {
  const devtools = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${logs}`)), 15000);
    const inspect = () => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(logs);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    chrome.stderr.on("data", inspect);
    chrome.once("error", err => { clearTimeout(timer); reject(err); });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${logs}`)); });
    inspect();
  });
  browser = await cdp(devtools);
  const endpoint = new URL(devtools);
  const response = await fetch(`http://${endpoint.host}/json/new?${encodeURIComponent(target.href)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome target creation failed: ${response.status}`);
  const info = await response.json();
  page = await cdp(info.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const value = await page.call("Runtime.evaluate", { expression: "typeof window.verifyDesktop === 'function'", returnByValue: true });
    if (value.result?.value) { ready = true; break; }
    await sleep(100);
  }
  if (!ready) throw new Error("noVNC fixture module failed to load");
  const result = await page.call("Runtime.evaluate", { expression: "window.verifyDesktop()", awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value));
} finally {
  page?.close();
  if (browser) {
    await browser.call("Browser.close").catch(() => {});
    browser.close();
  } else {
    chrome.kill();
  }
  await Promise.race([exited, sleep(5000).then(() => chrome.kill())]);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
