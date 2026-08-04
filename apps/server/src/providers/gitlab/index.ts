import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["projects", "issues"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  projects: [
    { name: "list_projects", description: "List GitLab projects.", inputSchema: { type: "object", properties: { search: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_project", description: "Get a project by id or path.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    { name: "get_current_user", description: "Get the authenticated GitLab user.", inputSchema: { type: "object", properties: {} } },
  ],
  issues: [
    { name: "list_issues", description: "List project issues.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, state: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "create_issue", description: "Create a project issue.", inputSchema: { type: "object", required: ["project_id", "title"], properties: { project_id: { type: "string" }, title: { type: "string" }, description: { type: "string" } } } },
  ],
};

async function gitlabFetch<T>(
  token: string,
  path: string,
  init?: RequestInit & { json?: unknown },
) {
  return restJson<T>(`https://gitlab.com/api/v4${path}`, token, init);
}

const factory = createOauthRestProvider({
  id: "gitlab",
  name: "GitLab",
  description: "平台直接调用 GitLab REST API，提供项目与 Issues 工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await gitlabFetch(token, "/user");
  },
  async callTool(product, name, token, args) {
    const perPage = int(args, "per_page", 20);
    if (product === "projects") {
      if (name === "get_current_user") return gitlabFetch(token, "/user");
      if (name === "list_projects") {
        const qs = new URLSearchParams({ membership: "true" });
        if (str(args, "search")) qs.set("search", str(args, "search"));
        if (perPage) qs.set("per_page", String(perPage));
        return gitlabFetch(token, `/projects?${qs}`);
      }
      if (name === "get_project") {
        return gitlabFetch(token, `/projects/${encodeURIComponent(str(args, "id"))}`);
      }
    }
    if (product === "issues") {
      const projectId = encodeURIComponent(str(args, "project_id"));
      if (name === "list_issues") {
        const qs = new URLSearchParams();
        if (str(args, "state")) qs.set("state", str(args, "state"));
        if (perPage) qs.set("per_page", String(perPage));
        return gitlabFetch(token, `/projects/${projectId}/issues?${qs}`);
      }
      if (name === "create_issue") {
        return gitlabFetch(token, `/projects/${projectId}/issues`, {
          method: "POST",
          json: {
            title: str(args, "title"),
            description: str(args, "description") || undefined,
          },
        });
      }
    }
    throw new Error(`Unknown GitLab tool: ${name}`);
  },
});

export const createGitlabProvider = factory.createProvider;
export const injectGitlabRuntime = factory.injectRuntime;
export const resolveGitlabProduct = factory.resolveProduct;
export const gitlabBuiltinUrl = factory.builtinUrl;
