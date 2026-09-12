import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { Db } from "../../db/client.js";
import {
  newId,
  scimUserMappings,
  tenantMemberships,
  tenantScimTokens,
  users,
} from "../../db/schema.js";
import { hashToken, newSecretToken, parseJsonObject } from "./util.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = "ScimError";
  }
}

export function scimErrorBody(err: ScimError) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(err.status),
    detail: err.message,
    ...(err.scimType ? { scimType: err.scimType } : {}),
  };
}

export async function authenticateScim(db: Db, bearer: string | null) {
  if (!bearer) throw new ScimError("Unauthorized", 401);
  const tokenHash = hashToken(bearer);
  const row = await db.query.tenantScimTokens.findFirst({
    where: and(eq(tenantScimTokens.tokenHash, tokenHash), isNull(tenantScimTokens.revokedAt)),
  });
  if (!row) throw new ScimError("Unauthorized", 401);
  await db.update(tenantScimTokens).set({ lastUsedAt: new Date() }).where(eq(tenantScimTokens.id, row.id));
  return row;
}

export async function listScimTokens(db: Db, tenantId: string) {
  const rows = await db.query.tenantScimTokens.findMany({
    where: and(eq(tenantScimTokens.tenantId, tenantId), isNull(tenantScimTokens.revokedAt)),
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    groupRoleMap: parseJsonObject(row.groupRoleMap),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createScimToken(
  db: Db,
  tenantId: string,
  input?: { name?: string; groupRoleMap?: Record<string, string> },
) {
  const raw = newSecretToken("scim");
  const [row] = await db
    .insert(tenantScimTokens)
    .values({
      id: newId(),
      tenantId,
      name: input?.name?.trim() || "SCIM",
      tokenHash: hashToken(raw),
      tokenPrefix: raw.slice(0, 12),
      groupRoleMap: JSON.stringify(input?.groupRoleMap ?? { Admins: "admin" }),
      createdAt: new Date(),
    })
    .returning();
  return { token: raw, id: row.id, name: row.name, tokenPrefix: row.tokenPrefix };
}

export async function revokeScimToken(db: Db, tenantId: string, tokenId: string) {
  await db
    .update(tenantScimTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tenantScimTokens.id, tokenId), eq(tenantScimTokens.tenantId, tenantId)));
}

export async function patchScimTokenMap(
  db: Db,
  tenantId: string,
  tokenId: string,
  groupRoleMap: Record<string, string>,
) {
  await db
    .update(tenantScimTokens)
    .set({ groupRoleMap: JSON.stringify(groupRoleMap) })
    .where(and(eq(tenantScimTokens.id, tokenId), eq(tenantScimTokens.tenantId, tenantId)));
}

type ScimUser = {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string };
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean }>;
  active: boolean;
  meta: { resourceType: string };
};

function toScimUser(input: {
  mappingId: string;
  externalId: string;
  email: string;
  name: string | null;
  active: boolean;
}): ScimUser {
  return {
    schemas: [USER_SCHEMA],
    id: input.mappingId,
    externalId: input.externalId,
    userName: input.email,
    name: { formatted: input.name ?? input.email },
    displayName: input.name ?? input.email,
    emails: [{ value: input.email, primary: true }],
    active: input.active,
    meta: { resourceType: "User" },
  };
}

export function parseScimFilter(filter: string | undefined): { email?: string } {
  if (!filter) return {};
  const match = /(?:userName|emails\.value)\s+eq\s+"([^"]+)"/i.exec(filter);
  return match?.[1] ? { email: match[1].toLowerCase() } : {};
}

async function loadMappedUser(db: Db, tenantId: string, mappingId: string) {
  const mapping = await db.query.scimUserMappings.findFirst({
    where: and(eq(scimUserMappings.id, mappingId), eq(scimUserMappings.tenantId, tenantId)),
  });
  if (!mapping) throw new ScimError("User not found", 404);
  const user = await db.query.users.findFirst({ where: eq(users.id, mapping.userId) });
  if (!user) throw new ScimError("User not found", 404);
  const membership = await db.query.tenantMemberships.findFirst({
    where: and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, user.id)),
  });
  return { mapping, user, membership };
}

export async function scimGetUser(db: Db, tenantId: string, id: string) {
  const { mapping, user, membership } = await loadMappedUser(db, tenantId, id);
  return toScimUser({
    mappingId: mapping.id,
    externalId: mapping.externalId,
    email: user.email,
    name: user.name,
    active: membership?.status === "active" && !user.suspendedAt,
  });
}

export async function scimListUsers(
  db: Db,
  tenantId: string,
  query: { filter?: string; startIndex?: number; count?: number },
) {
  const parsed = parseScimFilter(query.filter);
  const startIndex = Math.max(query.startIndex ?? 1, 1);
  const count = Math.min(Math.max(query.count ?? 100, 1), 200);
  const mappings = await db.query.scimUserMappings.findMany({
    where: eq(scimUserMappings.tenantId, tenantId),
  });
  const resources: ScimUser[] = [];
  for (const mapping of mappings) {
    const user = await db.query.users.findFirst({ where: eq(users.id, mapping.userId) });
    if (!user) continue;
    if (parsed.email && user.email !== parsed.email) continue;
    const membership = await db.query.tenantMemberships.findFirst({
      where: and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, user.id)),
    });
    resources.push(
      toScimUser({
        mappingId: mapping.id,
        externalId: mapping.externalId,
        email: user.email,
        name: user.name,
        active: membership?.status === "active" && !user.suspendedAt,
      }),
    );
  }
  const slice = resources.slice(startIndex - 1, startIndex - 1 + count);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex,
    itemsPerPage: slice.length,
    Resources: slice,
  };
}

export function membershipStatusFromScimActive(active: boolean): "active" | "suspended" {
  return active ? "active" : "suspended";
}

export function readScimUserPayload(body: Record<string, unknown>) {
  const userName = String(body.userName ?? "").trim().toLowerCase();
  const emails = body.emails as Array<{ value?: string }> | undefined;
  const email = (emails?.[0]?.value || userName).trim().toLowerCase();
  if (!email || !email.includes("@")) throw new ScimError("userName/email required", 400);
  const nameObj = body.name as { formatted?: string; givenName?: string; familyName?: string } | undefined;
  const name =
    (typeof body.displayName === "string" && body.displayName) ||
    nameObj?.formatted ||
    [nameObj?.givenName, nameObj?.familyName].filter(Boolean).join(" ") ||
    email.split("@")[0];
  const active = body.active !== false;
  const externalId = String(body.externalId ?? email);
  return { email, name, active, externalId };
}

export async function scimCreateUser(db: Db, tenantId: string, body: Record<string, unknown>, defaultRole = "member") {
  const payload = readScimUserPayload(body);
  const existingMap = await db.query.scimUserMappings.findFirst({
    where: and(eq(scimUserMappings.tenantId, tenantId), eq(scimUserMappings.externalId, payload.externalId)),
  });
  if (existingMap) throw new ScimError("User already exists", 409, "uniqueness");

  let user = await db.query.users.findFirst({ where: eq(users.email, payload.email) });
  const now = new Date();
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        id: newId(),
        email: payload.email,
        name: payload.name,
        passwordHash: await bcrypt.hash(newSecretToken("tmp", 18), 10),
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    user = created;
  }
  let membership = await db.query.tenantMemberships.findFirst({
    where: and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, user.id)),
  });
  if (!membership) {
    const [created] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(),
        tenantId,
        userId: user.id,
        role: defaultRole === "admin" ? "admin" : "member",
        status: membershipStatusFromScimActive(payload.active),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    membership = created;
  } else if (!payload.active && membership.status === "active") {
    await db
      .update(tenantMemberships)
      .set({ status: membershipStatusFromScimActive(false), updatedAt: now })
      .where(eq(tenantMemberships.id, membership.id));
  }
  const [mapping] = await db
    .insert(scimUserMappings)
    .values({
      id: newId(),
      tenantId,
      userId: user.id,
      externalId: payload.externalId,
      createdAt: now,
    })
    .returning();
  return toScimUser({
    mappingId: mapping.id,
    externalId: mapping.externalId,
    email: user.email,
    name: user.name,
    active: payload.active,
  });
}

export async function scimReplaceUser(db: Db, tenantId: string, id: string, body: Record<string, unknown>) {
  const { mapping, user, membership } = await loadMappedUser(db, tenantId, id);
  const payload = readScimUserPayload(body);
  await db
    .update(users)
    .set({ name: payload.name, email: payload.email, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  if (membership) {
    await db
      .update(tenantMemberships)
      .set({ status: membershipStatusFromScimActive(payload.active), updatedAt: new Date() })
      .where(eq(tenantMemberships.id, membership.id));
  }
  if (payload.externalId !== mapping.externalId) {
    await db
      .update(scimUserMappings)
      .set({ externalId: payload.externalId })
      .where(eq(scimUserMappings.id, mapping.id));
  }
  return toScimUser({
    mappingId: mapping.id,
    externalId: payload.externalId,
    email: payload.email,
    name: payload.name,
    active: payload.active,
  });
}

export async function scimPatchUser(db: Db, tenantId: string, id: string, body: Record<string, unknown>) {
  const ops = (body.Operations ?? body.operations) as Array<{ op?: string; path?: string; value?: unknown }> | undefined;
  if (!Array.isArray(ops)) return scimReplaceUser(db, tenantId, id, body);
  const { mapping, user, membership } = await loadMappedUser(db, tenantId, id);
  let active = membership?.status === "active";
  let name = user.name;
  let email = user.email;
  for (const op of ops) {
    const path = (op.path ?? "").toLowerCase();
    if ((op.op ?? "").toLowerCase() === "replace" && (path === "active" || !path)) {
      if (path === "active") active = Boolean(op.value);
      else if (op.value && typeof op.value === "object") {
        const value = op.value as Record<string, unknown>;
        if ("active" in value) active = Boolean(value.active);
        if (typeof value.displayName === "string") name = value.displayName;
        if (typeof value.userName === "string") email = value.userName.toLowerCase();
      }
    }
  }
  await db.update(users).set({ name, email, updatedAt: new Date() }).where(eq(users.id, user.id));
  if (membership) {
    await db
      .update(tenantMemberships)
      .set({ status: membershipStatusFromScimActive(active), updatedAt: new Date() })
      .where(eq(tenantMemberships.id, membership.id));
  }
  return toScimUser({
    mappingId: mapping.id,
    externalId: mapping.externalId,
    email,
    name,
    active,
  });
}

export async function scimDeleteUser(db: Db, tenantId: string, id: string) {
  const { membership } = await loadMappedUser(db, tenantId, id);
  if (membership) {
    await db
      .update(tenantMemberships)
      .set({ status: membershipStatusFromScimActive(false), updatedAt: new Date() })
      .where(eq(tenantMemberships.id, membership.id));
  }
}

function groupId(name: string): string {
  return hashToken(`group:${name}`).slice(0, 24);
}

export function listScimGroups(groupRoleMap: Record<string, unknown>) {
  const resources = Object.keys(groupRoleMap).map((displayName) => ({
    schemas: [GROUP_SCHEMA],
    id: groupId(displayName),
    displayName,
    meta: { resourceType: "Group" },
  }));
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export async function scimPatchGroup(
  db: Db,
  tenantId: string,
  id: string,
  groupRoleMap: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  const entry = Object.entries(groupRoleMap).find(([name]) => groupId(name) === id);
  if (!entry) throw new ScimError("Group not found", 404);
  const role = entry[1] === "admin" ? "admin" : "member";
  const ops = (body.Operations ?? body.operations) as Array<{ op?: string; path?: string; value?: unknown }> | undefined;
  const members: Array<{ value?: string }> = [];
  for (const op of ops ?? []) {
    if ((op.path ?? "").toLowerCase() === "members" && Array.isArray(op.value)) {
      members.push(...(op.value as Array<{ value?: string }>));
    }
  }
  for (const member of members) {
    if (!member.value) continue;
    const mapping = await db.query.scimUserMappings.findFirst({
      where: and(eq(scimUserMappings.tenantId, tenantId), eq(scimUserMappings.id, member.value)),
    });
    if (!mapping) continue;
    await db
      .update(tenantMemberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, mapping.userId)));
  }
  return { schemas: [GROUP_SCHEMA], id, displayName: entry[0], meta: { resourceType: "Group" } };
}
