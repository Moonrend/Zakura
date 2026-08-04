import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["issues", "projects", "teams"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  issues: [
    { name: "list_issues", description: "List Linear issues.", inputSchema: { type: "object", properties: { first: { type: "integer" }, query: { type: "string" } } } },
    { name: "get_issue", description: "Get an issue by id.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", required: ["title", "teamId"], properties: { title: { type: "string" }, teamId: { type: "string" }, description: { type: "string" }, priority: { type: "integer" } } } },
    { name: "create_comment", description: "Comment on an issue.", inputSchema: { type: "object", required: ["issueId", "body"], properties: { issueId: { type: "string" }, body: { type: "string" } } } },
  ],
  projects: [
    { name: "list_projects", description: "List Linear projects.", inputSchema: { type: "object", properties: { first: { type: "integer" } } } },
    { name: "get_project", description: "Get a project by id.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  ],
  teams: [
    { name: "list_teams", description: "List Linear teams.", inputSchema: { type: "object", properties: { first: { type: "integer" } } } },
    { name: "viewer", description: "Get the authenticated Linear viewer.", inputSchema: { type: "object", properties: {} } },
  ],
};

async function linearGraphql<T>(token: string, query: string, variables?: Record<string, unknown>) {
  return restJson<T>("https://api.linear.app/graphql", token, {
    method: "POST",
    json: { query, variables },
  });
}

const factory = createOauthRestProvider({
  id: "linear",
  name: "Linear",
  description: "平台直接调用 Linear GraphQL API，提供 Issues、Projects 与 Teams 工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await linearGraphql(token, "{ viewer { id } }");
  },
  async callTool(product, name, token, args) {
    const first = int(args, "first", 25);
    if (product === "issues") {
      if (name === "list_issues") {
        const q = str(args, "query");
        return linearGraphql(token, `
          query($first: Int, $filter: IssueFilter) {
            issues(first: $first, filter: $filter) {
              nodes { id identifier title description state { name } url }
            }
          }`, {
          first,
          filter: q ? { searchableContent: { contains: q } } : undefined,
        });
      }
      if (name === "get_issue") {
        return linearGraphql(token, `
          query($id: String!) {
            issue(id: $id) { id identifier title description state { name } url assignee { name } }
          }`, { id: str(args, "id") });
      }
      if (name === "create_issue") {
        return linearGraphql(token, `
          mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) { success issue { id identifier title url } }
          }`, {
          input: {
            title: str(args, "title"),
            teamId: str(args, "teamId"),
            description: str(args, "description") || undefined,
            priority: int(args, "priority"),
          },
        });
      }
      if (name === "create_comment") {
        return linearGraphql(token, `
          mutation($input: CommentCreateInput!) {
            commentCreate(input: $input) { success comment { id body } }
          }`, {
          input: { issueId: str(args, "issueId"), body: str(args, "body") },
        });
      }
    }
    if (product === "projects") {
      if (name === "list_projects") {
        return linearGraphql(token, `
          query($first: Int) {
            projects(first: $first) { nodes { id name state url } }
          }`, { first });
      }
      if (name === "get_project") {
        return linearGraphql(token, `
          query($id: String!) {
            project(id: $id) { id name state description url }
          }`, { id: str(args, "id") });
      }
    }
    if (product === "teams") {
      if (name === "list_teams") {
        return linearGraphql(token, `
          query($first: Int) {
            teams(first: $first) { nodes { id name key } }
          }`, { first });
      }
      if (name === "viewer") {
        return linearGraphql(token, `{ viewer { id name email } }`);
      }
    }
    throw new Error(`Unknown Linear tool: ${name}`);
  },
});

export const createLinearProvider = factory.createProvider;
export const injectLinearRuntime = factory.injectRuntime;
export const resolveLinearProduct = factory.resolveProduct;
export const linearBuiltinUrl = factory.builtinUrl;
