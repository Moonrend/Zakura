import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../../db/schema.js";
import type { AppConfig } from "../../config.js";
import { McpUpstreamOauthService } from "../../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "../generic-mcp.js";

type GithubProduct = "repos" | "issues" | "pulls" | "search";
const PRODUCTS: GithubProduct[] = ["repos", "issues", "pulls", "search"];

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "GitHub",
  required: ["product"],
  properties: {
    product: { type: "string", enum: PRODUCTS },
    oauthAccessToken: { type: "string", format: "password" },
    oauthRefreshToken: { type: "string", format: "password" },
    oauthExpiresAt: { type: "number" },
    oauthClientId: { type: "string" },
    oauthClientSecret: { type: "string", format: "password" },
    oauthTokenEndpoint: { type: "string" },
    authRequired: { type: "boolean" },
  },
};

let appConfigRef: AppConfig | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbRef: any = null;

export function injectGithubRuntime(config: AppConfig, db: unknown): void {
  appConfigRef = config;
  dbRef = db;
}

export function githubBuiltinUrl(product: GithubProduct): string {
  return `zakura://github/${product}`;
}

export function resolveGithubProduct(value: string): GithubProduct | null {
  const raw = value.trim().toLowerCase();
  if (PRODUCTS.includes(raw as GithubProduct)) return raw as GithubProduct;
  const matched = raw.match(/^zakura:\/\/github\/(repos|issues|pulls|search)$/);
  return matched ? (matched[1] as GithubProduct) : null;
}

function parseProduct(config: Record<string, unknown>): GithubProduct {
  const value =
    typeof config.product === "string"
      ? config.product
      : typeof config.mcpUrl === "string"
        ? config.mcpUrl
        : "";
  const product = resolveGithubProduct(value);
  if (!product) throw new Error("config.product 须为 repos | issues | pulls | search");
  return product;
}

async function ghFetch<T>(
  token: string,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

const toolDefs: Record<GithubProduct, McpToolDef[]> = {
  repos: [
    { name: "list_repos", description: "List repositories for the authenticated user.", inputSchema: { type: "object", properties: { visibility: { type: "string" }, sort: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_repo", description: "Get a repository by owner/repo.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" } } } },
    { name: "list_branches", description: "List branches in a repository.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "integer" } } } },
  ],
  issues: [
    { name: "list_issues", description: "List issues in a repository.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_issue", description: "Get an issue by number.", inputSchema: { type: "object", required: ["owner", "repo", "issue_number"], properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" } } } },
    { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", required: ["owner", "repo", "title"], properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } } } },
    { name: "create_issue_comment", description: "Comment on an issue.", inputSchema: { type: "object", required: ["owner", "repo", "issue_number", "body"], properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" }, body: { type: "string" } } } },
  ],
  pulls: [
    { name: "list_pulls", description: "List pull requests.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_pull", description: "Get a pull request.", inputSchema: { type: "object", required: ["owner", "repo", "pull_number"], properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer" } } } },
    { name: "create_pull", description: "Create a pull request.", inputSchema: { type: "object", required: ["owner", "repo", "title", "head", "base"], properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } } } },
  ],
  search: [
    { name: "search_repositories", description: "Search repositories.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "search_issues", description: "Search issues and pull requests.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "search_code", description: "Search code across GitHub.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
  ],
};

function str(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? String(input[key]).trim() : "";
}

function int(input: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (typeof input[key] === "number") return input[key] as number;
  if (typeof input[key] === "string" && input[key]) return Number(input[key]);
  return fallback;
}

async function callGithubTool(
  token: string,
  product: GithubProduct,
  name: string,
  input: Record<string, unknown>,
) {
  const owner = str(input, "owner");
  const repo = str(input, "repo");
  const perPage = int(input, "per_page", 30);
  if (product === "repos") {
    if (name === "list_repos") {
      const qs = new URLSearchParams();
      if (str(input, "visibility")) qs.set("visibility", str(input, "visibility"));
      if (str(input, "sort")) qs.set("sort", str(input, "sort"));
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/user/repos?${qs}`);
    }
    if (name === "get_repo") return ghFetch(token, `/repos/${owner}/${repo}`);
    if (name === "list_branches") {
      return ghFetch(token, `/repos/${owner}/${repo}/branches?per_page=${perPage ?? 30}`);
    }
  }
  if (product === "issues") {
    if (name === "list_issues") {
      const qs = new URLSearchParams({ state: str(input, "state") || "open" });
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/repos/${owner}/${repo}/issues?${qs}`);
    }
    if (name === "get_issue") {
      return ghFetch(token, `/repos/${owner}/${repo}/issues/${int(input, "issue_number")}`);
    }
    if (name === "create_issue") {
      return ghFetch(token, `/repos/${owner}/${repo}/issues`, {
        method: "POST",
        json: { title: str(input, "title"), body: str(input, "body") || undefined },
      });
    }
    if (name === "create_issue_comment") {
      return ghFetch(
        token,
        `/repos/${owner}/${repo}/issues/${int(input, "issue_number")}/comments`,
        { method: "POST", json: { body: str(input, "body") } },
      );
    }
  }
  if (product === "pulls") {
    if (name === "list_pulls") {
      const qs = new URLSearchParams({ state: str(input, "state") || "open" });
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/repos/${owner}/${repo}/pulls?${qs}`);
    }
    if (name === "get_pull") {
      return ghFetch(token, `/repos/${owner}/${repo}/pulls/${int(input, "pull_number")}`);
    }
    if (name === "create_pull") {
      return ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        json: {
          title: str(input, "title"),
          head: str(input, "head"),
          base: str(input, "base"),
          body: str(input, "body") || undefined,
        },
      });
    }
  }
  if (product === "search") {
    const q = encodeURIComponent(str(input, "q"));
    const page = perPage ? `&per_page=${perPage}` : "";
    if (name === "search_repositories") return ghFetch(token, `/search/repositories?q=${q}${page}`);
    if (name === "search_issues") return ghFetch(token, `/search/issues?q=${q}${page}`);
    if (name === "search_code") return ghFetch(token, `/search/code?q=${q}${page}`);
  }
  throw new Error(`Unknown GitHub tool: ${name}`);
}

async function accessToken(handle: InstanceHandle): Promise<string> {
  let current = { ...handle.config };
  const expiresAt = Number(current.oauthExpiresAt ?? 0);
  if (
    (!current.oauthAccessToken || expiresAt <= Math.floor(Date.now() / 1000) + 120) &&
    current.oauthRefreshToken &&
    current.oauthClientId &&
    appConfigRef
  ) {
    const tokenEndpoint = String(current.oauthTokenEndpoint ?? "").trim();
    if (!tokenEndpoint) throw new Error("GitHub OAuth 配置缺少 token endpoint");
    const tokens = await new McpUpstreamOauthService(appConfigRef).refresh({
      accessToken: String(current.oauthAccessToken ?? ""),
      refreshToken: String(current.oauthRefreshToken),
      expiresAt,
      clientId: String(current.oauthClientId),
      clientSecret:
        typeof current.oauthClientSecret === "string" ? current.oauthClientSecret : undefined,
      tokenEndpoint,
    });
    current = applyOauthTokensToConfig(current, tokens);
    current.authRequired = false;
    handle.config = current;
    if (dbRef) {
      const { encryptJson } = await import("@zakura/core");
      await dbRef
        .update(componentInstances)
        .set({ configEnc: encryptJson(appConfigRef.secret, current), updatedAt: new Date() })
        .where(eq(componentInstances.id, handle.id));
    }
  }
  const token = String(current.oauthAccessToken ?? "").trim();
  if (!token) throw new Error("AUTH_REQUIRED: 请先完成 GitHub OAuth 授权");
  return token;
}

export function createGithubProvider(): ProviderPlugin {
  return {
    id: "github",
    name: "GitHub",
    description: "平台直接调用 GitHub REST API，提供仓库、Issues、PR 与搜索工具。",
    version: "1.0.0",
    category: "connector",
    capabilities: ["tools", "builtin"],
    configSchema,
    validateConfig(config) {
      const product = parseProduct(config);
      return { ...config, product, mcpUrl: githubBuiltinUrl(product) };
    },
    createRuntimeSpec(config) {
      return { containers: [], endpointTemplate: githubBuiltinUrl(parseProduct(config)) };
    },
    async healthCheck(handle) {
      try {
        const token = await accessToken(handle);
        await ghFetch(token, "/user");
        return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
      } catch (error) {
        return {
          status: "unhealthy",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listTools(handle) {
      return toolDefs[parseProduct(handle.config)];
    },
    async callTool(handle, name, args) {
      try {
        return textResult(
          JSON.stringify(
            await callGithubTool(
              await accessToken(handle),
              parseProduct(handle.config),
              name,
              args,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
