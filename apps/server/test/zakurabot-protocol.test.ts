import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createZakurabotChat } from "../src/services/zakurabot-adapter.js";
import { callRemoteChannelTool, type RemoteChannelSessionHandle } from "../src/services/remote-channel-tools.js";
import { encodeZakurabotReply, zakurabotClientFrameSchema, type ZakurabotServerFrame } from "../src/services/zakurabot-protocol.js";

describe("zakurabot v1 contract", () => {
  it("validates hello, stable send ids, interrupts and pings", () => {
    for (const frame of [
      { type: "hello", protocol: 1, token: "zbot_test", client: { name: "zakura-bot", version: "1.0" } },
      { type: "send", agentId: "a", clientMessageId: "u-1", text: " hello " },
      { type: "send", agentId: "a", clientMessageId: "u-file", attachments: [{ fileId: "file-1" }] },
      { type: "interrupt", agentId: "a" }, { type: "ping" },
    ]) assert.ok(zakurabotClientFrameSchema.safeParse(frame).success);
    for (const frame of [
      { type: "hello", protocol: 2, token: "t", client: { name: "app", version: "1" } },
      { type: "send", agentId: "__proto__", clientMessageId: "u", text: "hello" },
      { type: "send", agentId: "a", clientMessageId: "constructor", text: "hello" },
      { type: "send", agentId: "a", clientMessageId: "u", text: " " },
      { type: "send", agentId: "a", clientMessageId: "u", text: "x".repeat(4001) },
      { type: "send", agentId: "a", text: "missing id" }, null, [],
      { type: "send", agentId: "a", clientMessageId: "u", attachments: [{ fileId: "file-1", path: "/etc/passwd" }] },
      { type: "send", agentId: "a", clientMessageId: "u", attachments: [{ fileId: "file-1" }, { fileId: "file-1" }] },
      { type: "send", agentId: "a", clientMessageId: "u", attachments: Array(9).fill({ fileId: "file-1" }) },
    ]) assert.equal(zakurabotClientFrameSchema.safeParse(frame).success, false);
  });

  it("preserves raw text, cards, buttons and all attachments in one reply", async () => {
    const paths: string[] = [];
    const reply = await encodeZakurabotReply({
      text: "report", kind: "raw", actions: [{ label: "Open", url: "https://example.com", style: "primary" }],
      card: { title: "Done", subtitle: "Build", text: "Success", imageUrl: "https://example.com/banner.png",
        fields: [{ label: "Status", value: "OK" }], table: { headers: ["Task"], rows: [["Test"]] },
        images: [{ url: "https://example.com/card.png", alt: "chart" }],
        links: [{ label: "Logs", url: "https://example.com/logs" }] },
      attachments: ["reports/check.txt", { path: "/workspace/chart.png", name: "Chart", type: "image" },
        "https://example.com/file.pdf", { url: "https://example.com/audio.mp3", type: "audio" }],
    }, async (path) => { paths.push(path); return { url: `https://zakura.test/shared/${paths.length}`, name: path.split("/").pop()! }; });
    assert.deepEqual(paths, ["/workspace/reports/check.txt", "/workspace/chart.png"]);
    assert.equal(reply.kind, "raw");
    assert.equal(reply.actions?.[0]?.style, "primary");
    assert.deepEqual(reply.card?.table?.rows, [["Test"]]);
    assert.deepEqual(reply.attachments?.map((a) => a.type), ["file", "image", "file", "audio"]);
    assert.equal(reply.attachments?.[1]?.name, "Chart");
    assert.equal(JSON.stringify(reply).includes("/workspace/"), false);
  });

  it("rejects malformed payloads and unsafe remote URLs", async () => {
    const publish = async () => { throw new Error("Unexpected file publication"); };
    for (const payload of [
      {}, { kind: "card", text: "no card" }, { card: {} },
      { text: "x", actions: [{ label: "Go", url: "javascript:alert(1)" }] },
      { card: { imageUrl: "data:image/png;base64,test" } },
      { attachments: ["https://user:password@example.com/file"] },
      { attachments: [{ url: "file:///etc/passwd" }] },
      { attachments: Array(9).fill("https://example.com/a.png") },
    ]) await assert.rejects(encodeZakurabotReply(payload, publish));
  });

  it("uses the native encoder for every post tool and quotes the inbound message", async () => {
    const frames: ZakurabotServerFrame[] = [];
    const chat = createZakurabotChat({ agentId: "a", deviceId: "d", deviceName: "Phone", threadId: "thread",
      post: async (frame) => { frames.push(frame); }, history: async () => [],
      publishFile: async () => ({ url: "https://example.com/file", name: "file" }) });
    const handle: RemoteChannelSessionHandle = { chat, platform: "zakurabot", bindingId: "b",
      threadId: "thread", channelId: "thread", inboundMessageId: "user-1" };
    const reply = await callRemoteChannelTool(handle, "chat_reply", { text: "Hello" });
    assert.equal(reply.isError, false);
    assert.equal(handle.chatReplySuccessCount, 1);
    assert.equal(frames[0]?.type, "chat_reply");
    if (frames[0]?.type === "chat_reply") assert.equal(frames[0].payload.reply_to, "user-1");
    for (const [tool, args] of [
      ["chat_post_message", { text: "Thread" }],
      ["chat_post_channel_message", { kind: "card", card: { title: "Card" } }],
      ["chat_send_direct_message", { userId: "d", actions: [{ label: "Go", url: "https://example.com" }] }],
    ] as const) assert.equal((await callRemoteChannelTool(handle, tool, args)).isError, false);
    assert.equal(frames.filter((f) => f.type === "chat_reply").length, 4);
    for (const [tool, args] of [
      ["chat_reply", { text: "Invented", interaction: { type: "approval", requestId: "fake", title: "Fake", status: "pending" } }],
      ["chat_post_message", { text: "x", threadId: "another-device" }],
      ["chat_post_channel_message", { text: "x", channelId: "another-tenant" }],
      ["chat_send_direct_message", { text: "x", userId: "another-device" }],
    ] as const) assert.equal((await callRemoteChannelTool(handle, tool, args)).isError, true);
    assert.equal(frames.filter((f) => f.type === "chat_reply").length, 4);
  });
});
