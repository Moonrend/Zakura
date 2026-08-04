import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["issues", "projects"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  issues: [
    { name: "search_issues", description: "Search Jira issues with JQL.", inputSchema: { type: "object", required: ["jql"], properties: { jql: { type: "string" }, max_results: { type: "integer" } } } },
    { name: "get_issue", description: "Get an issue by key.", inputSchema: { type: "object", required: ["issue_key"], properties: { issue_key: { type: "string" } } } },
    { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", required: ["project_key", "summary", "issuetype"], properties: { project_key: { type: "string" }, summary: { type: "string" }, issuetype: { type: "string" }, description: { type: "string" } } } },
    { name: "add_comment", description: "Add a comment to an issue.", inputSchema: { type: "object", required: ["issue_key", "body"], properties: { issue_key: { type: "string" }, body: { type: "string" } } } },
  ],
  projects: [
    { name: "list_projects", description: "List accessible Jira projects.", inputSchema: { type: "object", properties: { max_results: { type: "integer" } } } },
    { name: "get_myself", description: "Get the authenticated Jira user.", inputSchema: { type: "object", properties: {} } },
  ],
};

async function cloudId(token: string): Promise<string> {
  const resources = await restJson<Array<{ id: string; url: string }>>(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    token,
  );
  const first = resources[0];
  if (!first?.id) throw new Error("未找到可访问的 Atlassian 站点，请确认 OAuth 授权范围");
  return first.id;
}

async function jiraFetch<T>(
  token: string,
  path: string,
  init?: RequestInit & { json?: unknown },
) {
  const id = await cloudId(token);
  return restJson<T>(`https://api.atlassian.com/ex/jira/${id}/rest/api/3${path}`, token, init);
}

const factory = createOauthRestProvider({
  id: "jira",
  name: "Jira",
  description: "平台直接调用 Jira Cloud API，提供 Issues 与 Projects 工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await jiraFetch(token, "/myself");
  },
  async callTool(product, name, token, args) {
    const maxResults = int(args, "max_results", 25);
    if (product === "issues") {
      if (name === "search_issues") {
        return jiraFetch(token, "/search/jql", {
          method: "POST",
          json: {
            jql: str(args, "jql"),
            maxResults,
            fields: ["summary", "status", "assignee", "priority", "issuetype"],
          },
        });
      }
      if (name === "get_issue") {
        return jiraFetch(token, `/issue/${encodeURIComponent(str(args, "issue_key"))}`);
      }
      if (name === "create_issue") {
        return jiraFetch(token, "/issue", {
          method: "POST",
          json: {
            fields: {
              project: { key: str(args, "project_key") },
              summary: str(args, "summary"),
              issuetype: { name: str(args, "issuetype") || "Task" },
              description: str(args, "description")
                ? {
                    type: "doc",
                    version: 1,
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: str(args, "description") }],
                      },
                    ],
                  }
                : undefined,
            },
          },
        });
      }
      if (name === "add_comment") {
        return jiraFetch(token, `/issue/${encodeURIComponent(str(args, "issue_key"))}/comment`, {
          method: "POST",
          json: {
            body: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: str(args, "body") }],
                },
              ],
            },
          },
        });
      }
    }
    if (product === "projects") {
      if (name === "list_projects") {
        return jiraFetch(token, `/project/search?maxResults=${maxResults ?? 25}`);
      }
      if (name === "get_myself") return jiraFetch(token, "/myself");
    }
    throw new Error(`Unknown Jira tool: ${name}`);
  },
});

export const createJiraProvider = factory.createProvider;
export const injectJiraRuntime = factory.injectRuntime;
export const resolveJiraProduct = factory.resolveProduct;
export const jiraBuiltinUrl = factory.builtinUrl;
