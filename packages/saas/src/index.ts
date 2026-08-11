/** @zakura/saas — SaaS edition helpers (safe to import from OSS builds when package is present). */

export type ZakuraEdition = "oss" | "saas";

export const SAAS_PACKAGE = "@zakura/saas";

/** Web routes that exist only in the SaaS edition (also listed in strip-manifest.json). */
export const SAAS_WEB_ROUTES = [
  "/register",
  "/invite",
  "/dashboard/admin",
  "/dashboard/settings/members",
  "/dashboard/settings/tenants",
  "/console/oauth/[provider]/callback",
] as const;
