import assert from "node:assert/strict";
import { createRunTextStream, deliverRunToThread, isEmptyStreamError } from "../src/services/remote-channel-stream.js";
import {
  CHAT_POST_MESSAGE,
  callRemoteChannelTool,
  isRemoteChannelToolName,
  listRemoteChannelToolDefinitions,
  remoteChannelPromptBlock,
  RemoteChannelSessionRegistry,
} from "../src/services/remote-channel-tools.js";

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
assert.ok(defs.some((d) => d.function.name === CHAT_POST_MESSAGE));
const postDesc = defs.find((d) => d.function.name === CHAT_POST_MESSAGE)!.function.description;
assert.match(postDesc, /streamed to the current thread|do not repost/i);
assert.match(postDesc, /progress/i);

const prompt = remoteChannelPromptBlock(handle);
assert.match(prompt, /👀/);
assert.match(prompt, /streamed/i);
assert.match(prompt, /chat_post_message/);

const posted = await callRemoteChannelTool(handle, CHAT_POST_MESSAGE, {
  message: "hello **world**",
});
assert.equal(posted.isError, false);
assert.equal(posts.length, 1);
assert.equal(posts[0]!.threadId, "slack:C1:111.222");
assert.deepEqual(posts[0]!.message, { markdown: "hello **world**" });

const other = await callRemoteChannelTool(handle, CHAT_POST_MESSAGE, {
  message: "elsewhere",
  threadId: "slack:C1:999.000",
});
assert.equal(other.isError, false);
assert.equal(posts[1]!.threadId, "slack:C1:999.000");

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

  // 回补：先写入历史，再开流，应能拿到已有 delta
  store.emit({
    id: "e0",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-1",
    payload: { messageId: "m1", delta: "pre" },
  });

  const chunks: string[] = [];
  const consume = (async () => {
    for await (const chunk of createRunTextStream(store as never, "sess", "run-1")) {
      chunks.push(chunk);
    }
  })();

  await new Promise((r) => setTimeout(r, 20));
  store.emit({
    id: "e1",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-1",
    payload: { messageId: "m1", delta: "Hel" },
  });
  store.emit({
    id: "e2",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-1",
    payload: { messageId: "m1", delta: "lo" },
  });
  store.emit({
    id: "e3",
    sessionId: "sess",
    type: "reasoning_delta",
    runId: "run-1",
    payload: { messageId: "m1", delta: "secret" },
  });
  store.emit({
    id: "e4",
    sessionId: "sess",
    type: "run_end",
    runId: "run-1",
    payload: { runId: "run-1", status: "completed" },
  });
  await consume;
  assert.deepEqual(chunks, ["pre", "Hel", "lo"]);
}

{
  assert.equal(isEmptyStreamError(new Error("Telegram streaming requires text content")), true);
  assert.equal(isEmptyStreamError(new Error("other")), false);
}

{
  const edits: string[] = [];
  const posts: string[] = [];
  const thread = {
    id: "slack:C1:1",
    async post(message: any) {
      const text = String(message?.markdown ?? message ?? "");
      posts.push(text);
      return {
        id: `msg-${posts.length}`,
        async edit(next: any) {
          const t = String(next?.markdown ?? next ?? "");
          edits.push(t);
          return { id: `msg-${posts.length}`, edit: this.edit };
        },
      };
    },
    async startTyping() {},
  };

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

  const done = deliverRunToThread(thread as never, store as never, "sess", "run-2", {
    editThrottleMs: 1,
  });
  await new Promise((r) => setTimeout(r, 10));
  store.emit({
    id: "d1",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-2",
    payload: { messageId: "m", delta: "A" },
  });
  await new Promise((r) => setTimeout(r, 20));
  store.emit({
    id: "d2",
    sessionId: "sess",
    type: "assistant_delta",
    runId: "run-2",
    payload: { messageId: "m", delta: "B" },
  });
  store.emit({
    id: "end",
    sessionId: "sess",
    type: "run_end",
    runId: "run-2",
    payload: { runId: "run-2", status: "completed" },
  });
  await done;
  assert.equal(posts.length, 1);
  assert.ok(posts[0] === "A" || posts[0] === "AB");
  assert.ok(edits.includes("AB") || posts[0] === "AB");
}

console.log("remote-channel-tools self-check ok");
