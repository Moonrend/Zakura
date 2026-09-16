import assert from "node:assert/strict";
import { waitForRemoteRun } from "../src/services/remote-channel-stream.js";
import {
  CHAT_POST_MESSAGE,
  CHAT_REPLY,
  callRemoteChannelTool,
  encodePostable,
  formatRemoteInboundPrefix,
  isRemoteChannelToolName,
  listRemoteChannelToolDefinitions,
  maybeAutoChatReplyOnSilentRun,
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
assert.match(replyDesc, /assistant 文本不会出现/);
assert.match(replyDesc, /可多次调用|短确认/);
assert.match(replyDesc, /attachments/);

const prompt = remoteChannelPromptBlock(handle);
assert.match(prompt, /远程消息通道/);
assert.match(prompt, /chat_reply/);
assert.match(prompt, /assistant 文本不会出现/);
assert.match(prompt, /你现在在哪/);
assert.match(prompt, /slack/);
assert.match(prompt, /频道（名称未知）|频道顶层/);

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


{
  const rich = {
    chat,
    threadId: "slack:C1:111.222",
    channelId: "slack:C1",
    platform: "slack",
    bindingId: "b",
    isDM: false,
    channelName: "eng",
    isThread: true,
    sender: { userId: "U1", userName: "alice", fullName: "Alice Wang" },
    trigger: "mention" as const,
    permalink: "https://example.slack.com/archives/C1/p1",
  };
  const richPrompt = remoteChannelPromptBlock(rich);
  assert.match(richPrompt, /#eng/);
  assert.match(richPrompt, /线程内回复/);
  assert.match(richPrompt, /Alice Wang/);
  assert.match(richPrompt, /@alice/);
  assert.match(richPrompt, /@提及/);
  assert.match(richPrompt, /https:\/\/example\.slack\.com/);
  assert.match(richPrompt, /chat_get_channel_info/);
  assert.match(richPrompt, /不要对用户复述内部 id/);

  const dmPrompt = remoteChannelPromptBlock({
    ...rich,
    isDM: true,
    channelName: undefined,
    isThread: false,
    trigger: "dm",
    permalink: undefined,
  });
  assert.match(dmPrompt, /私信（DM）/);
  assert.match(dmPrompt, /一对一对话/);
  assert.match(dmPrompt, /触发：私信/);
  assert.doesNotMatch(dmPrompt, /#eng/);

  const barePrompt = remoteChannelPromptBlock({
    chat,
    threadId: "t",
    channelId: "c",
    platform: "telegram",
    bindingId: "b",
  });
  assert.match(barePrompt, /telegram/);
  assert.match(barePrompt, /未知用户|触发：未知/);

  const prefix = formatRemoteInboundPrefix(rich);
  assert.equal(prefix, "[来源: slack · #eng·线程 · Alice Wang · 触发:mention]");
  const dmPrefix = formatRemoteInboundPrefix({
    platform: "slack",
    isDM: true,
    sender: { userName: "bob" },
    trigger: "dm",
  });
  assert.equal(dmPrefix, "[来源: slack · DM · bob · 触发:dm]");
}

{
  const silentPosts: unknown[] = [];
  const silentChat = {
    thread(threadId: string) {
      return {
        id: threadId,
        channelId: "slack:C1",
        isDM: false,
        async post(message: unknown) {
          silentPosts.push(message);
          return { id: `s-${silentPosts.length}`, threadId };
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
  const silentHandle = {
    chat: silentChat,
    threadId: "slack:C1:1",
    channelId: "slack:C1",
    platform: "slack",
    bindingId: "b",
    chatReplySuccessCount: 0,
    autoFallbackPosted: false,
  };
  const first = await maybeAutoChatReplyOnSilentRun(silentHandle, "模型写了但没调工具");
  assert.equal(first.posted, true);
  assert.equal(first.reason, "auto_fallback");
  assert.equal(silentPosts.length, 1);
  assert.deepEqual(silentPosts[0], { markdown: "模型写了但没调工具" });
  assert.equal(silentHandle.chatReplySuccessCount, 1);

  const second = await maybeAutoChatReplyOnSilentRun(silentHandle, "又一次");
  assert.equal(second.posted, false);
  assert.equal(second.reason, "already_replied");
  assert.equal(silentPosts.length, 1);

  const emptyHandle = {
    ...silentHandle,
    chatReplySuccessCount: 0,
    autoFallbackPosted: false,
  };
  const empty = await maybeAutoChatReplyOnSilentRun(emptyHandle, "   ");
  assert.equal(empty.posted, true);
  assert.match(String((silentPosts[1] as { markdown?: string }).markdown), /未发出可见回复/);

  const skipped = {
    ...silentHandle,
    chatReplySuccessCount: 2,
    autoFallbackPosted: false,
  };
  const skip = await maybeAutoChatReplyOnSilentRun(skipped, "不应发出");
  assert.equal(skip.posted, false);
  assert.equal(skip.reason, "already_replied");
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
  const autoPosts: unknown[] = [];
  const autoChat = {
    thread(threadId: string) {
      return {
        id: threadId,
        channelId: "c",
        isDM: true,
        async post(message: unknown) {
          autoPosts.push(message);
          return { id: `a-${autoPosts.length}`, threadId };
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
  const autoHandle = {
    chat: autoChat,
    threadId: "dm:1",
    channelId: "dm:1",
    platform: "telegram",
    bindingId: "b",
    chatReplySuccessCount: 0,
    autoFallbackPosted: false,
  };
  const thread = {
    id: "dm:1",
    async post(message: unknown) {
      autoPosts.push(message);
    },
    async startTyping() {},
  };
  const done = waitForRemoteRun(thread as never, store as never, "sess", "run-auto", {
    remoteHandle: autoHandle,
  });
  await new Promise((r) => setTimeout(r, 10));
  store.emit({
    sessionId: "sess",
    type: "assistant_message",
    runId: "run-auto",
    payload: { content: "自动补发正文" },
  });
  store.emit({
    sessionId: "sess",
    type: "run_end",
    runId: "run-auto",
    payload: { runId: "run-auto", status: "completed" },
  });
  await done;
  assert.equal(autoPosts.length, 1);
  assert.deepEqual(autoPosts[0], { markdown: "自动补发正文" });
  assert.equal(autoHandle.chatReplySuccessCount, 1);

  // 已有 chat_reply 时不补发
  const noPosts: unknown[] = [];
  const noChat = {
    thread(threadId: string) {
      return {
        id: threadId,
        channelId: "c",
        isDM: true,
        async post(message: unknown) {
          noPosts.push(message);
          return { id: `n-${noPosts.length}`, threadId };
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
  const repliedHandle = {
    chat: noChat,
    threadId: "dm:2",
    channelId: "dm:2",
    platform: "telegram",
    bindingId: "b",
    chatReplySuccessCount: 1,
    autoFallbackPosted: false,
  };
  const thread2 = {
    id: "dm:2",
    async post() {},
    async startTyping() {},
  };
  const history2: any[] = [];
  const listeners2 = new Map<string, Set<(e: any) => void>>();
  const store2 = {
    subscribe(sessionId: string, listener: (e: any) => void) {
      let set = listeners2.get(sessionId);
      if (!set) {
        set = new Set();
        listeners2.set(sessionId, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    async listEvents(sessionId: string) {
      return history2.filter((e) => e.sessionId === sessionId);
    },
    emit(event: any) {
      history2.push(event);
      for (const fn of listeners2.get(event.sessionId) ?? []) fn(event);
    },
  };
  const done2 = waitForRemoteRun(thread2 as never, store2 as never, "sess2", "run-ok", {
    remoteHandle: repliedHandle,
  });
  await new Promise((r) => setTimeout(r, 10));
  store2.emit({
    sessionId: "sess2",
    type: "assistant_message",
    runId: "run-ok",
    payload: { content: "不应再发" },
  });
  store2.emit({
    sessionId: "sess2",
    type: "run_end",
    runId: "run-ok",
    payload: { runId: "run-ok", status: "completed" },
  });
  await done2;
  assert.equal(noPosts.length, 0);
}

console.log("remote-channel-tools self-check ok");
