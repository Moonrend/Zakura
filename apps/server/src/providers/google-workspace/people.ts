import type { McpToolDef } from "@zakura/shared";
import { googleFetch } from "./client.js";

type Person = {
  resourceName?: string;
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  photos?: Array<{ url?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
};

function mapPersonBrief(p: Person) {
  return {
    name: p.names?.[0]?.displayName ?? "",
    email: p.emailAddresses?.[0]?.value ?? "",
    resourceName: p.resourceName,
    organization: p.organizations?.[0]?.name,
    title: p.organizations?.[0]?.title,
    phone: p.phoneNumbers?.[0]?.value,
  };
}

export const peopleToolDefs: McpToolDef[] = [
  {
    name: "get_user_profile",
    description: "Get profile info about yourself (display name and email).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_contacts",
    description:
      "List the authenticated user's personal contacts (People connections). Paginated.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Default 30, max 100" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "search_contacts",
    description:
      "Search the user's personal contacts. Present results to the user for confirmation before using emails in other tools.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", description: "Default 10, max 30" },
      },
    },
  },
  {
    name: "search_directory_people",
    description:
      "Search the Google Workspace directory. Present results for confirmation before using further.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", description: "Default 10, max 30" },
      },
    },
  },
];

export async function callPeopleTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_user_profile": {
      const me = await googleFetch<Person>(
        token,
        "https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses",
      );
      return {
        name: me.names?.[0]?.displayName ?? "",
        emailAddress: me.emailAddresses?.[0]?.value ?? "",
      };
    }
    case "list_contacts": {
      const pageSize = Math.min(Math.max(Number(args.pageSize) || 30, 1), 100);
      const params = new URLSearchParams({
        pageSize: String(pageSize),
        personFields: "names,emailAddresses,organizations,phoneNumbers",
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const res = await googleFetch<{
        connections?: Person[];
        nextPageToken?: string;
        totalPeople?: number;
      }>(token, `https://people.googleapis.com/v1/people/me/connections?${params}`);
      return {
        results: (res.connections ?? []).map(mapPersonBrief),
        nextPageToken: res.nextPageToken,
        totalPeople: res.totalPeople,
      };
    }
    case "search_contacts": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query required");
      const maxResults = Math.min(Math.max(Number(args.maxResults) || 10, 1), 30);
      const params = new URLSearchParams({
        query,
        pageSize: String(maxResults),
        readMask: "names,emailAddresses,organizations,phoneNumbers",
      });
      const res = await googleFetch<{ results?: Array<{ person?: Person }> }>(
        token,
        `https://people.googleapis.com/v1/people:searchContacts?${params}`,
      );
      return {
        results: (res.results ?? [])
          .map((r) => (r.person ? mapPersonBrief(r.person) : null))
          .filter(Boolean),
      };
    }
    case "search_directory_people": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query required");
      const maxResults = Math.min(Math.max(Number(args.maxResults) || 10, 1), 30);
      const url =
        `https://people.googleapis.com/v1/people:searchDirectoryPeople?` +
        `query=${encodeURIComponent(query)}` +
        `&pageSize=${maxResults}` +
        `&readMask=${encodeURIComponent("names,emailAddresses,organizations,phoneNumbers")}` +
        `&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`;
      const res = await googleFetch<{ people?: Person[] }>(token, url);
      return {
        results: (res.people ?? []).map(mapPersonBrief),
      };
    }
    default:
      throw new Error(`Unknown people tool: ${name}`);
  }
}
