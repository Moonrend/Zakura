# Bot messages and user context

User messages accept an optional `context` alongside visible content:

```json
{
  "messageId": "client-message-id",
  "content": "Hello",
  "context": {
    "prefix": "Sender: Ada",
    "suffix": "Reply in the bot conversation"
  }
}
```

`content` remains the visible body. Zakura's timeline shows the wrapper when the user expands message details. Model input joins prefix, content and suffix with blank lines, as one user-role message. Wrappers do not become system-role messages. HTTP submission, queued messages, edits, retries, history reconstruction and ACP submission retain the wrapper. Omitting it preserves the existing plain-message behavior.

## Zakura Bot delivery

The WebSocket v1 gateway resolves the signed-in user's thread automatically. It records sender metadata in the prefix and delivery instructions in the suffix. User admission and its receipt are committed in the same transaction. Attachments arrive as `{fileId}` references and are resolved under tenant/user/binding/agent scope before the runtime receives their workspace paths.

`chat_reply({text})` creates a separate Markdown bot message. A successful send atomically writes:

- A `bot_message` event in the session, with `messageId`, `content`, `platform`, `botName` and optional `toolCallId` / `sourceMessageId`.
- A durable `chat_reply` frame in `zakurabot_messages`.

The main web timeline renders `bot_message` as its own bot bubble. A successful linked tool card is replaced by that bubble; failed sends keep their tool result. A final answer sent automatically carries its `sourceMessageId`, so it does not also appear as an ordinary assistant answer. Reasoning remains available in Zakura.

When no explicit `chat_reply` has been sent in the run, the normal final answer is delivered automatically. Replies survive socket disconnects. Reconnect replays the latest 100 frames, then continues from the stored sequence. Reusing an accepted client message id replays its receipt; changing text or attachment identities under that id is rejected.

## Automatic context maintenance

The chat runtime checks context size before model requests and summarizes older work when the history budget is exceeded. User boundaries are preferred; long single turns may compact completed tool rounds without separating calls from results. The summary includes prior summaries and relevant task constraints. A provider context-length rejection triggers a smaller-context retry. If the summary request itself is too large, it is split recursively into smaller fragments and combined.

Persisted summaries at user boundaries include `anchorMessageId` so regenerated or edited branches do not inherit another branch's summary. Compression within the current tool loop is applied to that run's in-memory context. Original events remain intact for inspection. The client does not need to start a fresh session or invoke compaction. ACP adapters continue to own their internal context management.

## Relevant checks

- `TestMessageContext*`: HTTP submission, retry and queue preservation.
- `TestCompaction*`: tool pairing, branch scope, long tool turns and oversized summary recovery.
- `TestBotMessage*` / `TestChatReply*`: durable delivery, idempotency, attachment ownership and fallback suppression.
- `apps/web/src/lib/cloud-agent.test.ts`: visible body, details, bot projection and duplicate suppression.

The corresponding client contract and UI behavior are documented in Zakura-bot's `docs/architecture.md` and `docs/ux-grokbot.md`.
