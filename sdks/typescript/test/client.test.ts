import test from "node:test";
import assert from "node:assert/strict";
import { Client, APIError } from "../src/index.js";

test("typed route builder preserves encoding and immutable query/header copies", async () => {
  const client = new Client({
    baseURL: "https://example.test/prefix",
    token: "secret",
  });
  const query = { tag: ["one", "two"] };
  const headers = { "X-Trace": "original" };
  const base = client.agents.getApiAgentsById("猫 /?%");
  const builder = base.withQuery(query).withHeaders(headers);
  query.tag.push("mutated");
  headers["X-Trace"] = "mutated";
  const request = await builder.build();
  assert.equal(
    new URL(request.url).pathname,
    "/prefix/api/agents/%E7%8C%AB%20%2F%3F%25",
  );
  assert.equal(request.headers.get("Authorization"), "Bearer secret");
  assert.deepEqual(new URL(request.url).searchParams.getAll("tag"), [
    "one",
    "two",
  ]);
  assert.equal(request.headers.get("X-Trace"), "original");
  assert.equal(new URL((await base.build()).url).search, "");
  for (const id of ["", ".", ".."])
    await assert.rejects(client.agents.getApiAgentsById(id).build());
});
test("safe retries obey status and never retry mutations", async () => {
  let calls = 0;
  const client = new Client({
    baseURL: "https://example.test",
    maxAttempts: 3,
    baseDelayMs: 0,
    fetch: async (request) => {
      assert.equal(request.redirect, "manual");
      calls++;
      return calls === 1
        ? new Response("busy", { status: 503, headers: { "Retry-After": "0" } })
        : Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.agents.getApiAgents().json(), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    client.agents.postApiAgents().withJSON({ name: "test" }).execute(),
    APIError,
  );
  assert.equal(calls, 1);
});
test("JSON snapshots, raw bodies and null are preserved", async () => {
  const client = new Client({ baseURL: "https://example.test" });
  const body = { name: "original" };
  const builder = client.agents.postApiAgents().withJSON(body);
  body.name = "mutated";
  assert.equal(await (await builder.build()).text(), '{"name":"original"}');
  assert.equal(
    await (await client.agents.postApiAgents().withJSON(null).build()).text(),
    "null",
  );
  assert.equal(
    await (
      await client.token
        .postOauthToken()
        .withRaw(
          new TextEncoder().encode("a=b"),
          "application/x-www-form-urlencoded",
        )
        .build()
    ).text(),
    "a=b",
  );
});
test("byte bounds reject oversized streaming responses", async () => {
  const client = new Client({
    baseURL: "https://example.test",
    maxResponseBytes: 3,
    fetch: async () => new Response("long body"),
  });
  await assert.rejects(client.agents.getApiAgents().execute(), /byte limit/);
});
test("cancellation bounds a token provider or fetch that never settles", async () => {
  const waiting = new Promise<string>(() => {});
  const client = new Client({
    baseURL: "https://example.test",
    timeoutMs: 10,
    token: () => waiting,
  });
  await assert.rejects(client.agents.getApiAgents().execute(), /deadline/);
  const second = new Client({
    baseURL: "https://example.test",
    timeoutMs: 10,
    fetch: () => new Promise(() => {}),
  });
  await assert.rejects(second.agents.getApiAgents().execute(), /deadline/);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(
    second.agents.getApiAgents().withSignal(abort.signal).execute(),
    /cancelled/,
  );
});
test("pagination protects against repeated cursors and page caps", async () => {
  const client = new Client({
    baseURL: "https://example.test",
    fetch: async () => Response.json({ cursor: "same" }),
  });
  await assert.rejects(async () => {
    for await (const ignored of client.agents
      .getApiAgents()
      .pages("cursor", () => "same", 4)) {
      void ignored;
    }
  }, /repeated/);
});
test("base URL, token and numeric assumptions are validated", async () => {
  for (const baseURL of [
    "relative",
    "ftp://example.test",
    "https://user:password@example.test",
    "https://example.test?q=1",
    "https://example.test#fragment",
  ])
    assert.throws(() => new Client({ baseURL }));
  assert.throws(
    () => new Client({ baseURL: "https://example.test", maxAttempts: 1.5 }),
  );
  const client = new Client({
    baseURL: "https://example.test",
    token: "bad\nvalue",
  });
  await assert.rejects(client.agents.getApiAgents().build(), /newline/);
});

test("response cancellation cannot extend the request deadline", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => {}),
    cancel: () => new Promise(() => {}),
  });
  const client = new Client({
    baseURL: "https://example.test",
    timeoutMs: 10,
    fetch: async () => new Response(stream),
  });
  await assert.rejects(client.agents.getApiAgents().execute(), /deadline/);
  await assert.rejects(
    client.agents.postApiAgents().withJSON(undefined).build(),
    /serialized/,
  );
});

test("default Fetch returns redirects without forwarding the bearer token", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    assert.equal(request.headers.authorization, "Bearer secret");
    response.writeHead(302, { Location: "/target", "Content-Length": "0" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const client = new Client({
      baseURL: `http://127.0.0.1:${address.port}`,
      token: "secret",
    });
    await assert.rejects(
      client.agents.getApiAgents().execute(),
      (error: unknown) => error instanceof APIError && error.status === 302,
    );
    assert.deepEqual(paths, ["/api/agents"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
