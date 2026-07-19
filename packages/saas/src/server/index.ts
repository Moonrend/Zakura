export { registerSaasRoutes } from "./routes.js";
export { registerSaasUser, RegisterError, type RegisterSchema } from "./register-user.js";
export {
  ZEROCAT_DEFAULTS,
  ZEROCAT_PROVIDER,
  loadZerocatConfig,
  type ZerocatOauthPublicConfig,
} from "./oauth-zerocat.js";
export type { SaasApp, SaasHostDeps, SaasSession, SaasTenantRole } from "./types.js";

/** Marker used by host loaders / health checks. */
export const SAAS_SERVER_MODULE = "@zakura/saas/server" as const;
