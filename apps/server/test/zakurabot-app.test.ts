import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { agents, zakurabotFiles } from "../src/db/schema.js";
import { ZAKURABOT_MAX_FILE_BYTES, type ZakurabotFileView } from "../src/services/zakurabot-protocol.js";
import { isZakurabotAppPath } from "../src/api/zakurabot-app-routes.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot scoped App API", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => fetch(`${h.url}/api/zakurabot/${path}`, { headers: headers(token) });
  const upload = (agentId: string, token: string, content = "File for the agent", name = "notes.txt") => {
    const form = new FormData();
    form.set("file", new Blob([content], { type: "text/plain" }), name);
    return fetch(`${h.url}/api/zakurabot/agents/${agentId}/files`, { method: "POST", headers: headers(token), body: form });
  };

  it("lists only granted bots with capabilities and rejects sessions on device endpoints", async () => {
    const ctx = await h.access(2), other = await h.access();
    const response = await get("agents", ctx.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const list = await response.json() as { agents: { id: string; bindingId: string; capabilities: { files: boolean } }[] };
    assert.deepEqual(list.agents.map((agent) => agent.id).sort(), ctx.bindings.map((binding) => binding.agentId).sort());
    assert.ok(list.agents.every((agent) => agent.bindingId && agent.capabilities.files));
    assert.equal((await (await get("bots", ctx.token)).json()).bots.length, 2);
    assert.equal((await get(`agents/${other.bindings[0]!.agentId}`, ctx.token)).status, 403);
    assert.equal((await get("agents", h.adminToken(ctx.tenantId))).status, 401);
    assert.equal((await get("devices", ctx.token)).status, 401);
    assert.equal(isZakurabotAppPath("/api/agents"), false);
    assert.equal(isZakurabotAppPath("/api/zakurabot/devices"), false);
    assert.equal(isZakurabotAppPath("/api/zakurabot/authorization"), false);
    assert.equal(isZakurabotAppPath("/api/zakurabot/agents/a/fs/download"), false);
  });

  it("uploads privately, forwards file metadata to the runtime, deduplicates sends, and enforces device/agent/tenant boundaries", async () => {
    const ctx = await h.access(2), other = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const peer = await h.channel.issueDevice(ctx.tenantId, { name: "Peer", bindingIds: [ctx.bindings[0]!.id], expiresInDays: 1 });
    const response = await upload(agentId, ctx.token, "Read this report", "../report.txt");
    assert.equal(response.status, 201);
    const { file } = await response.json() as { file: ZakurabotFileView };
    assert.equal(file.name, "report.txt");
    assert.equal(file.size, Buffer.byteLength("Read this report"));
    assert.equal(JSON.stringify(file).includes("/workspace"), false);
    assert.equal((await fetch(file.url)).status, 401);
    const downloaded = await fetch(file.url, { headers: headers(ctx.token) });
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    assert.equal(await downloaded.text(), "Read this report");
    assert.equal((await fetch(file.url, { headers: headers(peer.token) })).status, 404);
    assert.equal((await get(`agents/${ctx.bindings[1]!.agentId}/files/${file.id}`, ctx.token)).status, 404);
    assert.equal((await get(`agents/${other.bindings[0]!.agentId}/files/${file.id}`, other.token)).status, 404);
    assert.equal((await upload(other.bindings[0]!.agentId, ctx.token)).status, 403);

    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    const frame = { type: "send", agentId, clientMessageId: "file-message", text: "Read the attachment", attachments: [{ fileId: file.id }] };
    socket.send(frame);
    const echo = await socket.wait("message", (message) => message.message.clientMessageId === frame.clientMessageId);
    assert.equal(echo.message.attachments?.[0]?.id, file.id);
    const run = await h.waitForRun(frame.clientMessageId);
    assert.equal(run.attachments[0]?.name, file.name);
    assert.match(run.attachments[0]!.path, /^\/workspace\/uploads\/zakurabot\//);
    assert.equal(JSON.stringify(echo).includes(run.attachments[0]!.path), false);
    await run.tool("chat_reply", { text: "Read it" });
    await run.finish();
    const count = h.runs.length;
    const row = await h.db.query.zakurabotFiles.findFirst({ where: eq(zakurabotFiles.id, file.id) });
    const fs = await h.workspaceFs.forAgentBinding({ id: agentId });
    await fs.delete(row!.path);
    socket.send(frame);
    socket.send({ type: "ping" });
    await socket.wait("pong");
    assert.equal(h.runs.length, count, "accepted file sends stay idempotent even after the agent moves the file");
    socket.send({ ...frame, attachments: undefined });
    await socket.wait("error", (error) => error.clientMessageId === frame.clientMessageId);
    const history = await (await get(`agents/${agentId}/history`, ctx.token)).json();
    assert.equal(history.messages.filter((message: { type: string }) => message.type === "message").length, 1);
  });

  it("accepts attachment-only messages, rejects foreign files and enforces byte/capability limits", async () => {
    const ctx = await h.access(), other = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    assert.equal((await upload(agentId, ctx.token, "")).status, 413);
    assert.equal((await upload(agentId, ctx.token, "x".repeat(ZAKURABOT_MAX_FILE_BYTES + 1))).status, 413);
    const { file } = await (await upload(agentId, ctx.token)).json() as { file: ZakurabotFileView };
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "file-only", attachments: [{ fileId: file.id }] });
    const echo = await socket.wait("message");
    assert.match(echo.message.text, /notes\.txt/);
    assert.equal((await h.waitForRun("file-only")).attachments.length, 1);
    const foreign = await h.connect(other.token);
    await foreign.wait("ready");
    foreign.send({ type: "send", agentId: other.bindings[0]!.agentId, clientMessageId: "foreign-file", text: "hello", attachments: [{ fileId: file.id }] });
    await foreign.wait("error", (error) => error.clientMessageId === "foreign-file");
    assert.equal(h.runs.some((run) => run.handle.inboundMessageId === "foreign-file"), false);
    await h.db.update(agents).set({ enableFs: false }).where(eq(agents.id, agentId));
    assert.equal((await upload(agentId, ctx.token)).status, 403);
    assert.equal((await fetch(file.url, { headers: headers(ctx.token) })).status, 403);
  });

  it("rejects malformed uploads and missing files without accepting a turn", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const endpoint = `${h.url}/api/zakurabot/agents/${agentId}/files`;
    const duplicate = new FormData();
    duplicate.append("file", new Blob(["one"]), "one.txt");
    duplicate.append("file", new Blob(["two"]), "two.txt");
    assert.equal((await fetch(endpoint, { method: "POST", headers: headers(ctx.token), body: duplicate })).status, 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers: headers(ctx.token), body: "not a file" })).status, 400);
    assert.equal((await upload(agentId, ctx.token, "hello", "界".repeat(90))).status, 400);
    const { file } = await (await upload(agentId, ctx.token, "hello", "报告's (1).txt")).json() as { file: ZakurabotFileView };
    const download = await fetch(file.url, { headers: headers(ctx.token) });
    assert.match(download.headers.get("content-disposition")!, /%27s%20%281%29\.txt$/);
    assert.equal(await download.text(), "hello");
    const row = await h.db.query.zakurabotFiles.findFirst({ where: eq(zakurabotFiles.id, file.id) });
    await (await h.workspaceFs.forAgentBinding({ id: agentId })).delete(row!.path);
    assert.equal((await fetch(file.url, { headers: headers(ctx.token) })).status, 404);
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "missing-upload", attachments: [{ fileId: file.id }] });
    const error = await socket.wait("error", (frame) => frame.clientMessageId === "missing-upload");
    assert.match(error.message, /upload it again/);
    assert.equal(JSON.stringify(error).includes(row!.path), false);
    assert.equal(h.runs.some((run) => run.handle.inboundMessageId === "missing-upload"), false);
  });

  it("rechecks device access when a workspace upload or download finishes", async () => {
    const original = h.workspaceFs.forAgentBinding;
    const uploadOwner = await h.access();
    h.workspaceFs.forAgentBinding = async (binding) => {
      const fs = await original(binding);
      const write = fs.writeBytes.bind(fs);
      fs.writeBytes = async (...args) => {
        const result = await write(...args);
        await h.store.revokeDevice(uploadOwner.tenantId, uploadOwner.device.id);
        return result;
      };
      return fs;
    };
    try { assert.equal((await upload(uploadOwner.bindings[0]!.agentId, uploadOwner.token)).status, 401); }
    finally { h.workspaceFs.forAgentBinding = original; }

    const downloadOwner = await h.access();
    const { file } = await (await upload(downloadOwner.bindings[0]!.agentId, downloadOwner.token)).json() as { file: ZakurabotFileView };
    h.workspaceFs.forAgentBinding = async (binding) => {
      const fs = await original(binding);
      const read = fs.readBytes.bind(fs);
      fs.readBytes = async (...args) => {
        const result = await read(...args);
        await h.store.revokeDevice(downloadOwner.tenantId, downloadOwner.device.id);
        return result;
      };
      return fs;
    };
    try {
      const response = await fetch(file.url, { headers: headers(downloadOwner.token) });
      assert.equal(response.status, 401);
      assert.equal((await response.text()).includes("File for the agent"), false);
    } finally { h.workspaceFs.forAgentBinding = original; }
  });

});
