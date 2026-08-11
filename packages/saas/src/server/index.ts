export { registerSaasRoutes } from "./routes.js";
export { registerSaasUser, RegisterError, type RegisterSchema } from "./register-user.js";
export {
  LOGIN_OAUTH_PROVIDERS,
  listPublicOauthProviders,
  loadLoginPolicy,
  loadProviderConfig,
  type LoginOauthProviderId,
  type ProviderPublicConfig,
} from "./oauth-login.js";
/** @deprecated Prefer loadLoginPolicy / listPublicOauthProviders */
export {
  ZEROCAT_DEFAULTS,
  ZEROCAT_PROVIDER,
  loadZerocatConfig,
  type ZerocatOauthPublicConfig,
} from "./oauth-zerocat.js";
export type { SaasApp, SaasHostDeps, SaasSession, SaasTenantRole } from "./types.js";

/** Marker used by host loaders / health checks. */
export const SAAS_SERVER_MODULE = "@zakura/saas/server" as const;
