import type { Hono } from "hono";
import type { Db } from "../db/client.js";
import { extractBearer } from "../services/auth.js";
import { SecurityAuditService } from "../services/identity/audit.js";
import { parseJsonObject } from "../services/identity/util.js";
import {
  ScimError,
  authenticateScim,
  listScimGroups,
  scimCreateUser,
  scimDeleteUser,
  scimErrorBody,
  scimGetUser,
  scimListUsers,
  scimPatchGroup,
  scimPatchUser,
  scimReplaceUser,
} from "../services/identity/scim.js";

function scimStatus(status: number): 400 | 401 | 403 | 404 | 409 | 500 {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409) return status;
  return 500;
}

export function registerScimRoutes(app: Hono, deps: { db: Db; audit: SecurityAuditService }) {
  const { db, audit } = deps;

  app.use("/scim/v2/*", async (c, next) => {
    c.header("content-type", "application/scim+json");
    await next();
  });

  async function withToken(c: { req: { header: (name: string) => string | undefined } }) {
    return authenticateScim(db, extractBearer(c.req.header("authorization")));
  }

  app.get("/scim/v2/ServiceProviderConfig", (c) =>
    c.json({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      filter: { supported: true, maxResults: 200 },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", specUri: "https://www.rfc-editor.org/rfc/rfc6750.html" }],
    }),
  );

  app.get("/scim/v2/Users", async (c) => {
    try {
      const token = await withToken(c);
      return c.json(
        await scimListUsers(db, token.tenantId, {
          filter: c.req.query("filter") ?? undefined,
          startIndex: Number(c.req.query("startIndex") ?? 1),
          count: Number(c.req.query("count") ?? 100),
        }),
      );
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.get("/scim/v2/Users/:id", async (c) => {
    try {
      const token = await withToken(c);
      return c.json(await scimGetUser(db, token.tenantId, c.req.param("id")));
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.post("/scim/v2/Users", async (c) => {
    try {
      const token = await withToken(c);
      const body = (await c.req.json()) as Record<string, unknown>;
      const user = await scimCreateUser(db, token.tenantId, body);
      await audit.append(token.tenantId, "scim.user_create", {
        actor: { type: "scim", id: token.id },
        targetType: "user",
        targetId: user.id,
        detail: { userName: user.userName },
      });
      return c.json(user, 201);
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.put("/scim/v2/Users/:id", async (c) => {
    try {
      const token = await withToken(c);
      const body = (await c.req.json()) as Record<string, unknown>;
      const user = await scimReplaceUser(db, token.tenantId, c.req.param("id"), body);
      await audit.append(token.tenantId, "scim.user_replace", {
        actor: { type: "scim", id: token.id },
        targetType: "user",
        targetId: user.id,
      });
      return c.json(user);
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.patch("/scim/v2/Users/:id", async (c) => {
    try {
      const token = await withToken(c);
      const body = (await c.req.json()) as Record<string, unknown>;
      const user = await scimPatchUser(db, token.tenantId, c.req.param("id"), body);
      await audit.append(token.tenantId, "scim.user_patch", {
        actor: { type: "scim", id: token.id },
        targetType: "user",
        targetId: user.id,
      });
      return c.json(user);
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.delete("/scim/v2/Users/:id", async (c) => {
    try {
      const token = await withToken(c);
      await scimDeleteUser(db, token.tenantId, c.req.param("id"));
      await audit.append(token.tenantId, "scim.user_delete", {
        actor: { type: "scim", id: token.id },
        targetType: "user",
        targetId: c.req.param("id"),
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.get("/scim/v2/Groups", async (c) => {
    try {
      const token = await withToken(c);
      return c.json(listScimGroups(parseJsonObject(token.groupRoleMap)));
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });

  app.patch("/scim/v2/Groups/:id", async (c) => {
    try {
      const token = await withToken(c);
      const body = (await c.req.json()) as Record<string, unknown>;
      const group = await scimPatchGroup(
        db,
        token.tenantId,
        c.req.param("id"),
        parseJsonObject(token.groupRoleMap),
        body,
      );
      await audit.append(token.tenantId, "scim.group_patch", {
        actor: { type: "scim", id: token.id },
        targetType: "group",
        targetId: c.req.param("id"),
      });
      return c.json(group);
    } catch (err) {
      if (err instanceof ScimError) return c.json(scimErrorBody(err), scimStatus(err.status));
      throw err;
    }
  });
}
