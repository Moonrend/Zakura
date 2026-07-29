import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  apiError,
  httpSse,
  isRetryableModelError,
  UpstreamHttpError,
  withModelRetries,
} from "../src/model-router/http.js";
import {
  executeWithFallback,
  registerBuiltinModelAdapters,
} from "../src/model-router/index.js";
import type { ResolvedRoute } from "../src/model-router/types.js";

describe("isRetryableModelError", () => {
  it("classifies network interruptions as retryable", () => {
    assert.equal(isRetryableModelError(new TypeError("terminated")), true);
    assert.equal(isRetryableModelError(new TypeError("fetch failed")), true);
    assert.equal(
      isRetryableModelError(
        new Error("chat(stream) 连接中断: fetch failed", {
          cause: new TypeError("fetch failed"),
        }),
      ),
      true,
    );
    assert.equal(isRetryableModelError(new Error("chat(stream) 流空闲超时（120000ms 无数据）")), true);
    const withCode = Object.assign(new Error("request failed"), { code: "ECONNRESET" });
    assert.equal(isRetryableModelError(withCode), true);
  });

  it("classifies upstream HTTP status", () => {
    assert.equal(isRetryableModelError(apiError("chat", 429, null, "rate limited")), true);
    assert.equal(isRetryableModelError(apiError("chat", 503, null, "unavailable")), true);
    assert.equal(isRetryableModelError(apiError("chat", 400, null, "bad request")), false);
    assert.equal(isRetryableModelError(apiError("chat", 401, null, "unauthorized")), false);
  });

  it("uses the innermost UpstreamHttpError over message heuristics", () => {
    const err = new Error("aborted while calling upstream", {
      cause: new UpstreamHttpError("chat HTTP 400: invalid", 400),
    });
    assert.equal(isRetryableModelError(err), false);
  });

  it("treats plain business errors as non-retryable", () => {
    assert.equal(isRetryableModelError(new Error("参数无效")), false);
  });
});

describe("withModelRetries", () => {
  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const result = await withModelRetries(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("terminated");
        return "ok";
      },
      { attempts: 2, baseDelayMs: 5 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await assert.rejects(
      withModelRetries(
        async () => {
          calls += 1;
          throw apiError("chat", 400, null, "bad");
        },
        { attempts: 3, baseDelayMs: 5 },
      ),
      /HTTP 400/,
    );
    assert.equal(calls, 1);
  });

  it("stops when shouldRetry returns false", async () => {
    let calls = 0;
    await assert.rejects(
      withModelRetries(
        async () => {
          calls += 1;
          throw new TypeError("terminated");
        },
        { attempts: 3, baseDelayMs: 5, shouldRetry: () => false },
      ),
      /terminated/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await assert.rejects(
      withModelRetries(
        async () => {
          calls += 1;
          throw new TypeError("terminated");
        },
        { attempts: 3, baseDelayMs: 5 },
      ),
      /terminated/,
    );
    assert.equal(calls, 3);
  });
});

function makeRoute(slug: string): ResolvedRoute {
  return {
    routeId: `id-${slug}`,
    routeSlug: slug,
    alias: slug,
    capability: "chat",
    model: slug,
    weight: 100,
    options: {},
    upstream: {
      id: `up-${slug}`,
      protocol: "custom",
      config: { baseUrl: "http://127.0.0.1:1" },
    },
  };
}

describe("executeWithFallback", () => {
  registerBuiltinModelAdapters();

  it("retries a transient error on the same route before failing over", async () => {
    const calls: string[] = [];
    const { result, route } = await executeWithFallback(
      [makeRoute("r1"), makeRoute("r2")],
      "chat",
      async (_adapter, r) => {
        calls.push(r.routeSlug);
        if (r.routeSlug === "r1") throw new TypeError("terminated");
        return "from-r2";
      },
    );
    assert.equal(result, "from-r2");
    assert.equal(route.routeSlug, "r2");
    // r1 重试一次（共 2 次）后切换到 r2
    assert.deepEqual(calls, ["r1", "r1", "r2"]);
  });

  it("does not retry non-retryable errors on the same route", async () => {
    const calls: string[] = [];
    const { result } = await executeWithFallback(
      [makeRoute("r1"), makeRoute("r2")],
      "chat",
      async (_adapter, r) => {
        calls.push(r.routeSlug);
        if (r.routeSlug === "r1") throw apiError("chat", 401, null, "unauthorized");
        return "ok";
      },
    );
    assert.equal(result, "ok");
    assert.deepEqual(calls, ["r1", "r2"]);
  });

  it("marks the aggregate error retryable when any failure was transient", async () => {
    await assert.rejects(
      executeWithFallback([makeRoute("r1")], "chat", async () => {
        throw new TypeError("terminated");
      }),
      (err: unknown) => {
        assert.match((err as Error).message, /所有 chat 路由均失败/);
        assert.equal((err as { retryable?: boolean }).retryable, true);
        return true;
      },
    );

    await assert.rejects(
      executeWithFallback([makeRoute("r1")], "chat", async () => {
        throw apiError("chat", 400, null, "bad");
      }),
      (err: unknown) => {
        assert.equal((err as { retryable?: boolean }).retryable, false);
        return true;
      },
    );
  });
});

describe("httpSse", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const encoder = new TextEncoder();

  it("parses data lines and flushes the tail line without trailing newline", async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('data: {"a":1}\n\n'));
          // 尾块没有换行结尾，历史实现会丢掉
          c.enqueue(encoder.encode("data: [DONE]"));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const payloads: string[] = [];
    await httpSse("t", "http://x", { method: "POST" }, (p) => payloads.push(p));
    assert.deepEqual(payloads, ['{"a":1}', "[DONE]"]);
  });

  it("lets the data callback stop reading without waiting for upstream close", async () => {
    let cancelled = false;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          signal?.addEventListener("abort", () => {
            try {
              c.error(signal.reason);
            } catch {
              /* already closed */
            }
          });
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const payloads: string[] = [];
    await httpSse(
      "t",
      "http://x",
      { method: "POST", idleTimeoutMs: 1000 },
      (p) => {
        payloads.push(p);
        return false;
      },
    );

    assert.deepEqual(payloads, ["[DONE]"]);
    assert.equal(cancelled, true);
  });

  it("aborts on idle timeout during streaming", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode("data: first\n"));
          signal?.addEventListener("abort", () => {
            try {
              c.error(signal.reason);
            } catch {
              /* already closed */
            }
          });
          // 之后不再有数据，也不关闭 —— 模拟挂死的上游
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const payloads: string[] = [];
    await assert.rejects(
      httpSse(
        "t",
        "http://x",
        { method: "POST", timeoutMs: 1000, idleTimeoutMs: 30 },
        (p) => payloads.push(p),
      ),
      /空闲超时/,
    );
    assert.deepEqual(payloads, ["first"]);
  });

  it("aborts when connection establishment exceeds timeoutMs", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    await assert.rejects(
      httpSse("t", "http://x", { method: "POST", timeoutMs: 20 }, () => {}),
      /连接超时/,
    );
  });

  it("throws UpstreamHttpError with status for non-2xx responses", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 503,
      })) as typeof fetch;

    await assert.rejects(
      httpSse("t", "http://x", { method: "POST" }, () => {}),
      (err: unknown) => {
        assert.ok(err instanceof UpstreamHttpError);
        assert.equal(err.status, 503);
        assert.match(err.message, /HTTP 503/);
        assert.equal(isRetryableModelError(err), true);
        return true;
      },
    );
  });

  it("wraps low-level network failures with context and stays retryable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("terminated");
    }) as typeof fetch;

    await assert.rejects(
      httpSse("chat(stream)", "http://x", { method: "POST" }, () => {}),
      (err: unknown) => {
        assert.match((err as Error).message, /chat\(stream\) 连接中断: terminated/);
        assert.equal(isRetryableModelError(err), true);
        return true;
      },
    );
  });
});
