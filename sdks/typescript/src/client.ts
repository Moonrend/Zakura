// SPDX-License-Identifier: AGPL-3.0-only
export type Query = Record<
  string,
  string | number | boolean | readonly (string | number | boolean)[] | undefined
>;
export type TokenProvider =
  string | ((signal: AbortSignal) => string | Promise<string>);
export type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;
export type ClientOptions = {
  baseURL: string;
  token?: TokenProvider;
  fetch?: Fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};
export type CallOptions = {
  query?: Query;
  headers?: HeadersInit;
  json?: unknown;
  raw?: Uint8Array;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export class APIError extends Error {
  readonly status: number;
  readonly body: Uint8Array;
  readonly requestID: string | null;
  constructor(
    method: string,
    path: string,
    response: Response,
    body: Uint8Array,
  ) {
    super(`Zakura ${method} ${path} returned HTTP ${response.status}`);
    this.name = "APIError";
    this.status = response.status;
    this.body = body;
    this.requestID = response.headers.get("X-Request-ID");
  }
}
export class SDKResponse {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly body: Uint8Array,
  ) {}
  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }
  text(): string {
    return new TextDecoder().decode(this.body);
  }
}
function finite(value: number, min: number, max: number, name: string) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function copyOptions(options: CallOptions): CallOptions {
  const copy = {
    ...options,
    query: structuredClone(options.query),
    headers: new Headers(options.headers),
    raw: options.raw?.slice(),
  };
  if (Object.hasOwn(options, "json")) copy.json = structuredClone(options.json);
  return copy;
}
function encodeSegment(value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    new TextEncoder().encode(value).length > 4096
  )
    throw new Error("Path parameter is empty or too large");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
}
function routePath(
  path: string,
  parameters: Readonly<Record<string, string>>,
): string {
  if (!path.startsWith("/") || /[?#]/.test(path))
    throw new Error("Route must be an absolute path without query or fragment");
  for (const [name, value] of Object.entries(parameters)) {
    const marker = `{${name}}`;
    if (!path.includes(marker))
      throw new Error(`Unexpected path parameter ${name}`);
    path = path.split(marker).join(encodeSegment(value));
  }
  if (/[{}]/.test(path)) throw new Error("Required path parameter is missing");
  return path;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      length += next.value.length;
      if (length > limit)
        throw new Error("Response exceeds configured byte limit");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class Client {
  readonly baseURL: string;
  private readonly options: Required<
    Omit<ClientOptions, "baseURL" | "token">
  > & { token: TokenProvider };
  constructor(options: ClientOptions) {
    const url = new URL(options.baseURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Base URL must be absolute HTTP(S) without credentials, query or fragment",
      );
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.options = {
      fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
      token: options.token ?? "",
      timeoutMs: finite(options.timeoutMs ?? 30000, 1, 86400000, "timeout"),
      maxResponseBytes: finite(
        options.maxResponseBytes ?? 8 * 1024 * 1024,
        1,
        1024 ** 3,
        "byte limit",
      ),
      maxAttempts: finite(options.maxAttempts ?? 1, 1, 8, "attempts"),
      baseDelayMs: finite(
        options.baseDelayMs ?? 250,
        0,
        86400000,
        "retry delay",
      ),
      maxDelayMs: finite(options.maxDelayMs ?? 2000, 1, 86400000, "retry cap"),
    };
    if (
      !Number.isInteger(this.options.maxAttempts) ||
      !Number.isInteger(this.options.maxResponseBytes)
    )
      throw new Error("Attempts and byte limit must be integers");
  }
  async build(
    method: string,
    path: string,
    params: Readonly<Record<string, string>>,
    options: CallOptions = {},
    signal = options.signal ?? new AbortController().signal,
  ): Promise<Request> {
    const expanded = routePath(path, params);
    const url = new URL(this.baseURL + expanded);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined)
        for (const item of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, String(item));
    }
    const headers = new Headers(options.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const token =
      typeof this.options.token === "function"
        ? await abortable(Promise.resolve(this.options.token(signal)), signal)
        : this.options.token;
    if (/[\r\n]/.test(token))
      throw new Error("Token contains newline characters");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let body: BodyInit | undefined;
    if (Object.hasOwn(options, "json")) {
      if (options.raw !== undefined)
        throw new Error("JSON and raw bodies are mutually exclusive");
      body = JSON.stringify(options.json);
      if (body === undefined) throw new Error("JSON body cannot be serialized");
      headers.set("Content-Type", "application/json");
    } else if (options.raw !== undefined) {
      body = options.raw.slice() as Uint8Array<ArrayBuffer>;
      if (options.contentType) headers.set("Content-Type", options.contentType);
    }
    return new Request(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal,
    });
  }
  async execute(
    method: string,
    path: string,
    params: Readonly<Record<string, string>>,
    options: CallOptions = {},
  ): Promise<SDKResponse> {
    const timeout = finite(
      options.timeoutMs ?? this.options.timeoutMs,
      1,
      86400000,
      "timeout",
    );
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Request deadline exceeded")),
      timeout,
    );
    const attempts =
      method === "GET" || method === "HEAD" ? this.options.maxAttempts : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        controller.signal.throwIfAborted();
        const request = await this.build(
          method,
          path,
          params,
          options,
          controller.signal,
        );
        const response = await abortable(
          this.options.fetch(request),
          controller.signal,
        );
        const body = await readBounded(
          response,
          this.options.maxResponseBytes,
          controller.signal,
        );
        if (response.ok)
          return new SDKResponse(
            response.status,
            new Headers(response.headers),
            body,
          );
        if (
          attempt + 1 === attempts ||
          ![429, 502, 503, 504].includes(response.status)
        )
          throw new APIError(method, path, response, body);
        let delay = this.options.baseDelayMs * 2 ** attempt;
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter !== null) {
          const numeric = Number(retryAfter);
          const candidate =
            retryAfter.trim() !== "" && Number.isFinite(numeric)
              ? numeric * 1000
              : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(candidate)) delay = candidate;
        }
        await wait(
          Math.min(Math.max(0, delay), this.options.maxDelayMs),
          controller.signal,
        );
      }
      throw new Error("Unreachable retry state");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
export class Endpoint {
  constructor(
    readonly client: Client,
    readonly method: string,
    readonly path: string,
    readonly params: Readonly<Record<string, string>>,
    readonly options: CallOptions = {},
  ) {}
  withQuery(query: Query): Endpoint {
    return this.copy({ query: structuredClone(query) });
  }
  withHeaders(headers: HeadersInit): Endpoint {
    return this.copy({ headers: new Headers(headers) });
  }
  withTimeout(timeoutMs: number): Endpoint {
    return this.copy({ timeoutMs });
  }
  withSignal(signal: AbortSignal): Endpoint {
    return this.copy({ signal });
  }
  withJSON(json: unknown): Endpoint {
    const options = copyOptions(this.options);
    delete options.raw;
    return new Endpoint(
      this.client,
      this.method,
      this.path,
      { ...this.params },
      { ...options, json: structuredClone(json) },
    );
  }
  withRaw(raw: Uint8Array, contentType: string): Endpoint {
    const options = copyOptions(this.options);
    delete options.json;
    return new Endpoint(
      this.client,
      this.method,
      this.path,
      { ...this.params },
      { ...options, raw: raw.slice(), contentType },
    );
  }
  copy(change: CallOptions): Endpoint {
    return new Endpoint(
      this.client,
      this.method,
      this.path,
      { ...this.params },
      { ...copyOptions(this.options), ...change },
    );
  }
  build(): Promise<Request> {
    return this.client.build(this.method, this.path, this.params, this.options);
  }
  execute(): Promise<SDKResponse> {
    return this.client.execute(
      this.method,
      this.path,
      this.params,
      this.options,
    );
  }
  async json<T = unknown>(): Promise<T> {
    return (await this.execute()).json<T>();
  }
  async *pages(
    cursorKey: string,
    nextCursor: (
      response: SDKResponse,
    ) => string | null | Promise<string | null>,
    maxPages = 1000,
  ): AsyncGenerator<SDKResponse> {
    if (
      this.method !== "GET" ||
      !cursorKey ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 10000
    )
      throw new Error("Invalid pagination configuration");
    let current: Endpoint = this;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const response = await current.execute();
      yield response;
      const cursor = await nextCursor(response);
      if (!cursor) return;
      if (seen.has(cursor)) throw new Error("Pagination repeated a cursor");
      seen.add(cursor);
      current = current.withQuery({
        ...current.options.query,
        [cursorKey]: cursor,
      });
    }
    throw new Error("Pagination reached configured page limit");
  }
}
