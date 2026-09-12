import type { Db } from "../../db/client.js";
import { purgeExpiredAuthTokens } from "./tokens.js";
import { purgeExpiredUserSessions } from "./sessions.js";
import { purgeExpiredSsoStates } from "./sso.js";
import { SecurityAuditService } from "./audit.js";

export async function purgeIdentityExpired(db: Db): Promise<void> {
  await purgeExpiredAuthTokens(db);
  await purgeExpiredUserSessions(db);
  await purgeExpiredSsoStates(db);
  await new SecurityAuditService(db).purgeExpired();
}
