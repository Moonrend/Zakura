import assert from "node:assert/strict";
import {
  isRemoteSenderAllowed,
  RemoteAgentIngress,
} from "../src/services/remote-agent-ingress.js";
import {
  agentChannelBindings,
  agentChannelEvents,
  agentChannelThreads,
} from "../src/db/schema.js";

assert.equal(
  isRemoteSenderAllowed({ allowedUsers: ["U123"] }, "U123"),
  true,
);
assert.equal(
  isRemoteSenderAllowed({ allowedEmails: ["*@trusted.example.com"] }, "user-1", "alice@trusted.example.com"),
  true,
);
assert.equal(
  isRemoteSenderAllowed({ allowedEmails: ["alice@example.com"] }, "user-1", "bob@example.com"),
  false,
);
assert.equal(isRemoteSenderAllowed({}, "anonymous"), false);
assert.equal(isRemoteSenderAllowed({ allowAll: true }, "anonymous"), true);

class FakeDb {
  private readonly rows = new Map<object, any[]>([
    [
      agentChannelBindings,
      [
        {
          id: "binding-1",
          tenantId: "tenant-1",
          agentId: "agent-1",
          platform: "slack",
          profileKey: "remote-slack:binding-1",
          label: "Slack",
          enabled: true,
          settingsJson: JSON.stringify({ allowAll: true }),
          configEnc: "",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    ],
    [agentChannelThreads, []],
    [agentChannelEvents, []],
  ]);

  select() {
    const db = this;
    return {
      from(table: object) {
        const builder = {
          where() {
            return builder;
          },
          limit(count: number) {
            return Promise.resolve((db.rows.get(table) ?? []).slice(0, count));
          },
        };
        return builder;
      },
    };
  }

  insert(table: object) {
    const db = this;
    let value: any;
    let ignoreConflict = false;
    const builder = {
      values(next: any) {
        value = next;
        return builder;
      },
      onConflictDoNothing() {
        ignoreConflict = true;
        return builder;
      },
      async returning() {
        const rows = db.rows.get(table) ?? [];
        const conflict =
          table === agentChannelEvents &&
          rows.some((row) => row.bindingId === value.bindingId && row.externalEventId === value.externalEventId);
        if (conflict && ignoreConflict) return [];
        if (table === agentChannelThreads && rows.some((row) => row.externalThreadKey === value.externalThreadKey)) {
          throw new Error("unique violation");
        }
        rows.push(value);
        db.rows.set(table, rows);
        return [value];
      },
    };
    return builder;
  }

  update() {
    return {
      set() {
        return {
          where: async () => ({}),
        };
      },
    };
  }

  delete(table: object) {
    const db = this;
    return {
      where: async () => {
        db.rows.set(table, []);
      },
    };
  }
}

{
  const db = new FakeDb();
  let sessionCount = 0;
  let runCount = 0;
  let lastSessionInput: any = null;
  const store = {
    async createSession(input: any) {
      sessionCount += 1;
      lastSessionInput = input;
      return { id: `session-${sessionCount}`, ...input };
    },
    async getSession() {
      return null;
    },
    async deleteSession() {
      return true;
    },
  };
  const ingress = new RemoteAgentIngress(
    db as never,
    {
      get: async () => ({
        id: "agent-1",
        configJson: JSON.stringify({ cloud: { model: "gpt-test", modelRouteId: "route-1" } }),
      }),
    } as never,
    store as never,
    { startTurn: async () => ({ runId: `run-${++runCount}` }) },
    { secret: "test-secret-key-32-bytes-minimum!!" } as never,
  );
  const input = {
    tenantId: "tenant-1",
    bindingId: "binding-1",
    platform: "slack",
    externalEventId: "event-1",
    externalThreadKey: "thread-1",
    externalUserKey: "user-1",
    text: "hello",
  };
  const first = await ingress.handleInbound(input);
  const duplicate = await ingress.handleInbound(input);
  const otherUser = await ingress.handleInbound({
    ...input,
    externalEventId: "event-2",
    externalUserKey: "user-2",
  });
  assert.equal(first.accepted && !first.duplicate, true);
  assert.equal(duplicate.accepted && duplicate.duplicate, true);
  assert.deepEqual(otherUser, { accepted: false, reason: "forbidden" });
  assert.equal(sessionCount, 1);
  assert.equal(runCount, 1);
  assert.equal(lastSessionInput.model, "gpt-test");
  assert.equal(lastSessionInput.modelRouteId, "route-1");
}

{
  const db = new FakeDb();
  (db as any).rows.get(agentChannelBindings)[0].settingsJson = JSON.stringify({
    allowAll: true,
    model: "binding-model",
    modelRouteId: "binding-route",
  });
  let lastSessionInput: any = null;
  const ingress = new RemoteAgentIngress(
    db as never,
    {
      get: async () => ({
        id: "agent-1",
        configJson: JSON.stringify({ cloud: { model: "agent-model" } }),
      }),
    } as never,
    {
      async createSession(input: any) {
        lastSessionInput = input;
        return { id: "session-binding", ...input };
      },
      async getSession() {
        return null;
      },
      async deleteSession() {
        return true;
      },
    } as never,
    { startTurn: async () => ({ runId: "run-binding" }) },
    { secret: "test-secret-key-32-bytes-minimum!!" } as never,
  );
  const result = await ingress.handleInbound({
    tenantId: "tenant-1",
    bindingId: "binding-1",
    platform: "slack",
    externalEventId: "event-binding",
    externalThreadKey: "thread-binding",
    externalUserKey: "user-1",
    text: "hi",
  });
  assert.equal(result.accepted && !("duplicate" in result && result.duplicate), true);
  assert.equal(lastSessionInput.model, "binding-model");
  assert.equal(lastSessionInput.modelRouteId, "binding-route");
}

console.log("remote-agent-ingress self-check ok");
