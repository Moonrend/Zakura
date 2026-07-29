import type { ModelUpstreamConfig, ModelUpstreamProtocol } from "@zakura/shared";

export function buildHeaders(
  cfg: ModelUpstreamConfig,
  protocol: ModelUpstreamProtocol,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(cfg.extraHeaders ?? {}),
  };
  if (cfg.apiKey) {
    if (protocol === "azure-openai") {
      headers["api-key"] = cfg.apiKey;
    } else if (protocol !== "gemini") {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
  }
  return headers;
}

/** 上游 HTTP 错误：携带 status 供重试分类 */
export class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

/**
 * 调用方主动中断（用户取消 Run / 父任务取消）。
 * 与网络瞬时中断区分：绝不重试、绝不故障转移，直接向上冒泡走取消收尾。
 */
export class ModelCallAbortedError extends Error {
  readonly aborted = true;
  constructor(message = "调用已被取消") {
    super(message);
    this.name = "ModelCallAbortedError";
  }
}

/** 是否为「调用方主动取消」引发的错误（含 cause 链） */
export function isAbortError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; cur && i < 6; i += 1) {
    if (cur instanceof ModelCallAbortedError) return true;
    if ((cur as { aborted?: unknown })?.aborted === true) return true;
    cur = cur instanceof Error ? cur.cause : null;
  }
  return false;
}

/** 收集 err 及其 cause 链上的全部 message，便于匹配底层网络错误 */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 6; i += 1) {
    if (cur instanceof Error) {
      parts.push(cur.name, cur.message);
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") parts.push(code);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

const TRANSIENT_NETWORK_RE =
  /terminated|fetch failed|other side closed|socket hang up|socket idle|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR|TimeoutError|连接超时|空闲超时|aborted/i;

/**
 * 是否为可安全重试的瞬时错误：
 * 网络层中断/超时，或上游 408/429/5xx。
 * 4xx 业务错误（无效请求、鉴权失败等）不重试。
 */
export function isRetryableModelError(err: unknown): boolean {
  // 主动取消不是瞬时故障：必须先于网络正则判断（正则含 aborted）
  if (isAbortError(err)) return false;
  let cur: unknown = err;
  for (let i = 0; cur instanceof Error && i < 6; i += 1) {
    if (cur instanceof UpstreamHttpError) {
      return cur.status === 408 || cur.status === 429 || cur.status >= 500;
    }
    cur = cur.cause;
  }
  return TRANSIENT_NETWORK_RE.test(errorChainText(err));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 瞬时错误自动重试：默认最多 attempts 次（含首次），指数退避。
 * shouldRetry 返回 false 时立即抛出（如流已输出增量，重试会导致重复文本）。
 */
export async function withModelRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: {
    attempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
    onRetry?: (err: unknown, attempt: number) => void;
  },
): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? 2);
  const baseDelayMs = opts?.baseDelayMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable =
        attempt < attempts &&
        (opts?.shouldRetry
          ? opts.shouldRetry(err, attempt)
          : isRetryableModelError(err));
      if (!retryable) throw err;
      opts?.onRetry?.(err, attempt);
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const timeoutMs = init.timeoutMs ?? 60000;
  const { timeoutMs: _drop, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}

/**
 * 发起 SSE 请求并逐条回调 `data:` 负载（已去掉前缀与空行）。
 * 非 2xx 时读取错误体并抛出 apiError；`event:` 行被忽略，
 * 各协议依据负载 JSON 内的 type 字段自行分发。
 *
 * 超时模型：timeoutMs 仅约束「建立连接直至响应头」；流式读取阶段
 * 采用空闲超时（两次数据块之间的最大间隔），长回复不再被总时长掐断。
 *
 * init.signal 为调用方的中断信号（用户取消 Run）：触发时立即断开上游连接，
 * 并抛出 ModelCallAbortedError（不可重试），与超时/网络中断区分开。
 */
export async function httpSse(
  prefix: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; idleTimeoutMs?: number },
  onData: (payload: string) => void | boolean,
): Promise<void> {
  const timeoutMs = init.timeoutMs ?? 60000;
  const idleTimeoutMs = init.idleTimeoutMs ?? Math.max(timeoutMs, 120_000);
  const { timeoutMs: _drop, idleTimeoutMs: _drop2, signal: external, ...rest } = init;

  const ctrl = new AbortController();
  const abortedByCaller = () =>
    ctrl.abort(new ModelCallAbortedError(`${prefix} 已被调用方取消`));
  if (external?.aborted) abortedByCaller();
  external?.addEventListener("abort", abortedByCaller, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => ctrl.abort(new Error(`${prefix} 连接超时（${timeoutMs}ms）`)),
    timeoutMs,
  );
  const armIdle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => ctrl.abort(new Error(`${prefix} 流空闲超时（${idleTimeoutMs}ms 无数据）`)),
      idleTimeoutMs,
    );
  };

  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      throw apiError(prefix, res.status, data, text);
    }
    armIdle();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let shouldStop = false;
    const consume = (final: boolean) => {
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload && onData(payload) === false) {
          shouldStop = true;
          return;
        }
      }
      // 尾部无换行的最后一行也不能丢
      if (final) {
        const line = buffer.replace(/\r$/, "");
        buffer = "";
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && onData(payload) === false) {
            shouldStop = true;
          }
        }
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      consume(false);
      if (shouldStop) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!shouldStop) {
      buffer += decoder.decode();
      consume(true);
    }
  } catch (err) {
    // Abort 时 fetch/read 抛出的往往是 DOMException/TypeError，
    // 换成我们自己带上下文的原因；网络层错误统一加前缀便于定位。
    const reason = ctrl.signal.aborted ? ctrl.signal.reason : null;
    if (reason instanceof Error) throw reason;
    if (err instanceof UpstreamHttpError) throw err;
    // 仅包装网络层错误（undici 的 fetch failed/terminated 等是 TypeError），
    // onData 回调抛出的业务错误原样透出
    if (
      (err instanceof TypeError || err instanceof DOMException) &&
      !String((err as Error).message).startsWith(prefix)
    ) {
      throw new Error(`${prefix} 连接中断: ${(err as Error).message}`, { cause: err });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", abortedByCaller);
  }
}

export function apiError(prefix: string, status: number, data: unknown, text: string): Error {
  const msg =
    data && typeof data === "object" && data !== null && "error" in data
      ? String((data as { error?: { message?: string } }).error?.message ?? text)
      : text.slice(0, 500);
  return new UpstreamHttpError(`${prefix} HTTP ${status}: ${msg}`, status);
}

/** 限制并发，避免 Gemini 逐条 embed 时打满连接 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
