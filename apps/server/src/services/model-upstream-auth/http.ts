export type JsonHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
  getJson: (
    url: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
  postForm: (
    url: string,
    body: Record<string, string>,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
};

export function defaultJsonHttp(): JsonHttp {
  return {
    async postJson(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async getJson(url, headers) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async postForm(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...headers,
        },
        body: new URLSearchParams(body).toString(),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
  };
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
