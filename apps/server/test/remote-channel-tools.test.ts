import assert from "node:assert/strict";
import { waitForRemoteRun } from "../src/services/remote-channel-stream.js";
import {
  CHAT_POST_MESSAGE,
  CHAT_REPLY,
  callRemoteChannelTool,
  encodePostable,
  isRemoteChannelToolName,
  listRemoteChannelToolDefinitions,
  remoteChannelPromptBlock,
  RemoteChannelSessionRegistry,
} from "../src/services/remote-channel-tools.js";

assert.equal(isRemoteChannelToolName(CHAT_REPLY), true);
assert.equal(isRemoteChannelToolName(CHAT_POST_MESSAGE), true);
assert.equal(isRemoteChannelToolName("delegate_to_agent"), false);

const posts: Array<{ threadId: string; message: unknown }> = [];
const chat = {
  thread(threadId: string) {
    return {
      id: threadId,
      channelId: "slack:C1",
      isDM: false,
      async post(message: unknown) {
        posts.push({ threadId, message });
        return { id: `m-${posts.length}`, threadId };
      },
      async startTyping() {},
      adapter: {
        async addReaction() {},
      },
    };
  },
  channel(channelId: string) {
    return {
      id: channelId,
      async post(message: unknown) {
        posts.push({ threadId: `${channelId}:root`, message });
        return { id: `c-${posts.length}`, threadId: `${channelId}:root` };
      },
    };
  },
  async openDM(userId: string) {
    return {
      id: `slack:D-${userId}`,
      async post(message: unknown) {
        posts.push({ threadId: `slack:D-${userId}`, message });
        return { id: `d-${posts.length}`, threadId: `slack:D-${userId}` };
      },
    };
  },
};

const registry = new RemoteChannelSessionRegistry();
registry.bind("session-1", {
  chat,
  threadId: "slack:C1:111.222",
  channelId: "slack:C1",
  platform: "slack",
  bindingId: "binding-1",
});

const handle = registry.get("session-1");
assert.ok(handle);
const defs = listRemoteChannelToolDefinitions(handle);
assert.ok(defs.some((d) => d.function.name === CHAT_REPLY));
assert.ok(defs.some((d) => d.function.name === CHAT_POST_MESSAGE));
const replyDesc = defs.find((d) => d.function.name === CHAT_REPLY)!.function.description;
assert.match(replyDesc, /stay silent/i);
assert.match(replyDesc, /multiple times|multiple bubbles/i);
assert.match(replyDesc, /attachments/i);

const prompt = remoteChannelPromptBlock(handle);
assert.match(prompt, /Zakura Agent/);
assert.match(prompt, /chat_reply/);
assert.match(prompt, /stay silent/i);
assert.match(prompt, /attachments/);

assert.deepEqual(await encodePostable({ text: "hello **world**" }), { markdown: "hello **world**" });
assert.deepEqual(await encodePostable({ kind: "raw", text: "plain" }), { raw: "plain" });
assert.deepEqual(await encodePostable({ format: "raw", text: "plain" }), { raw: "plain" });
assert.deepEqual(await encodePostable({ message: "legacy" }), { markdown: "legacy" });

const withUrl = (await encodePostable({
  text: "图",
  attachments: ["https://example.com/a.png"],
})) as { markdown: string; attachments: Array<{ url?: string; type?: string }> };
assert.equal(withUrl.markdown, "图");
assert.equal(withUrl.attachments[0]!.url, "https://example.com/a.png");
assert.equal(withUrl.attachments[0]!.type, "image");

const withFile = (await encodePostable(
  { text: "报告", attachments: ["/workspace/out/report.pdf"] },
  {
    readWorkspaceFile: async (path) => {
      assert.equal(path, "/workspace/out/report.pdf");
      return { data: Buffer.from("%PDF"), name: "report.pdf" };
    },
  },
)) as { markdown: string; files: Array<{ filename: string }> };
assert.equal(withFile.files[0]!.filename, "report.pdf");

const card = (await encodePostable({
  kind: "card",
  card: {
    title: "部署",
    text: "已完成",
    fields: [{ label: "环境", value: "prod" }],
    links: [{ label: "打开", url: "https://example.com" }],
  },
})) as { type?: string; title?: string; children?: unknown[] };
assert.equal(card.type, "card");
assert.equal(card.title, "部署");
assert.ok(Array.isArray(card.children) && card.children.length >= 2);

const withButtons = (await encodePostable({
  text: "选一个",
  actions: [{ label: "打开", url: "https://example.com" }],
})) as { type?: string };
assert.equal(withButtons.type, "card");

const replied = await callRemoteChannelTool(handle, CHAT_REPLY, {
  text: "hello **world**",
});
assert.equal(replied.isError, false);
const repliedText = replied.content[0];
assert.equal(repliedText?.type, "text");
const repliedPayload = JSON.parse(repliedText!.text);
assert.equal(repliedPayload.ok, true);
assert.equal(repliedPayload.delivered, "current_conversation");
assert.equal(posts.length, 1);
assert.equal(posts[0]!.threadId, "slack:C1:111.222");
assert.deepEqual(posts[0]!.message, { markdown: "hello **world**" });

const again = await callRemoteChannelTool(handle, CHAT_REPLY, {
  kind: "card",
  card: { title: "进度", text: "还在跑" },
});
assert.equal(again.isError, false);
assert.equal(posts.length, 2);
assert.equal((posts[1]!.message as { type?: string }).type, "card");

const other = await callRemoteChannelTool(handle, CHAT_POST_MESSAGE, {
  message: "elsewhere",
  threadId: "slack:C1:999.000",
});
assert.equal(other.isError, false);
assert.equal(posts[2]!.threadId, "slack:C1:999.000");

{
  const quotes: Array<{ target: unknown; message: unknown }> = [];
  const quoting = {
    thread(threadId: string) {
      return {
        id: threadId,
        channelId: "slack:C1",
        isDM: false,
        async post() {
          return { id: "posted", threadId };
        },
        async reply(target: string) {
          quotes.push({ target, message: true });
          return { id: "quoted", threadId };
        },
        async startTyping() {},
        adapter: { async addReaction() {} },
      };
    },
    channel() {
      return { id: "c", async post() { return { id: "x", threadId: "c" }; } };
    },
    async openDM() {
      return { id: "d", async post() { return { id: "x", threadId: "d" }; } };
    },
  };
  const quoted = await callRemoteChannelTool(
    {
      chat: quoting,
      threadId: "slack:C1:111.222",
      channelId: "slack:C1",
      platform: "slack",
      bindingId: "b",
      inboundMessageId: "in-9",
    },
    CHAT_REPLY,
    { text: "quoted" },
  );
  assert.equal(quoted.isError, false);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.target, "in-9");
}

{
  const listeners = new Map<string, Set<(e: any) => void>>();
  const history: any[] = [];
  const store = {
    subscribe(sessionId: string, listener: (e: any) => void) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    async listEvents(sessionId: string) {
      return history.filter((e) => e.sessionId === sessionId);
    },
    emit(event: any) {
      history.push(event);
      for (const fn of listeners.get(event.sessionId) ?? []) fn(event);
    },
  };

  const threadPosts: unknown[] = [];
  const typing: number[] = [];
  const thread = {
    id: "slack:C1:1",
    async post(message: unknown) {
      threadPosts.push(message);
      return { id: `msg-${threadPosts.length}` };
    },
    async startTyping() {
      typing.push(Date.now());
    },
  };

  const done = waitForRemoteRun(thread as never, store as never, "sess", "run-2", {
    typingPulseMs: 50,
  });
  await new Promise((r) => setTimeout(r, 10));
  store.emit({
    id: "d1",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-2",
    payload: { messageId: "m", delta: "should not post" },
  });
  store.emit({
    id: "end",
    sessionId: "sess",
    type: "run_end",
    runId: "run-2",
    payload: { runId: "run-2", status: "completed" },
  });
  await done;
  assert.equal(threadPosts.length, 0);
  assert.ok(typing.length >= 1);
}

{
  const listeners = new Map<string, Set<(e: any) => void>>();
  const history: any[] = [];
  const store = {
    subscribe(sessionId: string, listener: (e: any) => void) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    async listEvents(sessionId: string) {
      return history.filter((e) => e.sessionId === sessionId);
    },
    emit(event: any) {
      history.push(event);
      for (const fn of listeners.get(event.sessionId) ?? []) fn(event);
    },
  };
  const threadPosts: unknown[] = [];
  const thread = {
    id: "t",
    async post(message: unknown) {
      threadPosts.push(message);
    },
    async startTyping() {},
  };
  const done = waitForRemoteRun(thread as never, store as never, "sess", "run-err");
  await new Promise((r) => setTimeout(r, 10));
  store.emit({
    sessionId: "sess",
    type: "run_error",
    runId: "run-err",
    payload: { message: "boom" },
  });
  await done;
  assert.equal(threadPosts.length, 1);
  assert.match(String((threadPosts[0] as { markdown?: string }).markdown), /boom/);
}

console.log("remote-channel-tools self-check ok");
