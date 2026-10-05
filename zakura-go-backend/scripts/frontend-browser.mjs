import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const screenshots = "artifacts/go-backend-browser";
await mkdir(screenshots, { recursive: true });
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  const text = message.text();
  // The preserved account shell intentionally probes optional avatar/image
  // resources and lets their 404 responses fall back to generated initials.
  // Chromium reports those expected misses as console errors; HTTP 5xx and
  // actual JavaScript exceptions remain hard failures below.
  if (message.type() === "error" && !/Failed to load resource:.*404 \(Not Found\)/.test(text)) {
    errors.push(`console: ${text}`);
  }
});
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 400) {
    const pathname = new URL(response.url()).pathname;
    const expectedMissingAvatar = response.status() === 404 && /\/api\/users\/[^/]+\/avatar$/.test(pathname);
    if (!expectedMissingAvatar) errors.push(`${response.status()} ${pathname}`);
  }
});

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForURL("**/setup");
  await page.locator("#email").fill("browser-admin@example.test");
  await page.locator("#password").fill("browser-contract-password");
  await page.locator("#adminName").fill("Browser Admin");
  await page.getByRole("button", { name: "开始使用" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByText("开始使用", { exact: true }).waitFor();
  await page.getByText("稍后设置", { exact: true }).click();
  await page.waitForURL("**/dashboard/agents", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  if (!body.trim()) errors.push("agents dashboard rendered an empty document");
  if (body.includes("Application error") || body.includes("环境准备失败") || body.includes("无法连接 API")) {
    errors.push("frontend error boundary rendered");
  }
  await page.screenshot({ path: `${screenshots}/agents-dashboard.png`, fullPage: true });

  const verifyPage = async (path, expectedHeading, expectedPath = path) => {
    const before = errors.length;
    const response = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) errors.push(`${path} navigation returned ${response?.status() ?? "no response"}`);
    try {
      await page.locator("h1").filter({ hasText: expectedHeading }).first().waitFor({
        state: "visible",
        timeout: 15_000,
      });
    } catch {
      errors.push(`${path} did not render heading ${JSON.stringify(expectedHeading)}`);
    }
    if (new URL(page.url()).pathname !== expectedPath) {
      errors.push(`${path} unexpectedly navigated to ${new URL(page.url()).pathname}`);
    }
    const text = await page.locator("body").innerText();
    if (!text.trim()) errors.push(`${path} rendered an empty document`);
    if (text.includes("Application error") || text.includes("环境准备失败") || text.includes("无法连接 API") || text.includes("加载失败") || text.includes("不存在或无权访问")) {
      errors.push(`${path} rendered the frontend error boundary`);
    }
    if (errors.length > before) throw new Error(errors.slice(before).join("\n"));
    const file = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: `${screenshots}/${file}.png`, fullPage: true });
  };

  // Exercise the preserved frontend's highest-value platform/runtime callers,
  // rather than treating one successful dashboard navigation as compatibility.
  for (const [path, heading, renderedPath] of [
    ["/dashboard/settings/account", "账户"],
    ["/dashboard/settings/team", "团队设置"],
    ["/dashboard/settings/identity", "身份"],
    ["/dashboard/settings/usage", "成员用量"],
    ["/dashboard/settings/oauth-clients", "OAuth 客户端"],
    ["/dashboard/keys", "API Keys"],
    ["/dashboard/admin/users", "用户"],
    ["/dashboard/admin/tenants", "团队"],
    ["/dashboard/admin/runners", "共享 Runner"],
    ["/dashboard/admin/auth", "登录与认证"],
    ["/dashboard/admin/platform", "平台服务"],
    ["/dashboard/admin/agent-defaults", "Agent 默认网页工具"],
    ["/dashboard/models", "模型"],
    ["/dashboard/mcp", "Agents", "/dashboard/agents"],
    ["/dashboard/connections", "Agents", "/dashboard/agents"],
  ]) await verifyPage(path, heading, renderedPath);

  const agent = await page.evaluate(async () => {
    const token = localStorage.getItem("zakura_session");
    const response = await fetch("/api/agents", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] ?? null : null;
  });
  if (!agent?.id) throw new Error("onboarding did not leave a browser-visible default agent");
  for (const [path, heading] of [
    [`/dashboard/agents/${encodeURIComponent(agent.id)}/overview`, agent.name],
    [`/dashboard/agents/${encodeURIComponent(agent.id)}/settings`, "设置"],
    [`/dashboard/agents/${encodeURIComponent(agent.id)}/memory`, "记忆"],
    [`/dashboard/spaces/${encodeURIComponent(agent.spaceId)}/settings/gateway`, "AI Gateway"],
  ]) await verifyPage(path, heading);

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("preserved frontend setup, onboarding, admin/settings, runtime, realtime and agent-detail flows passed");
} finally {
  await browser.close();
}
