/**
 * Backward-compatible ZeroCat OAuth wrappers.
 * New code should use oauth-login.ts directly.
 */
import {
  completeOauthLogin,
  loadLoginPolicy,
  loadProviderConfig,
  redirectUriFor as redirectUriForProvider,
  saveLoginPolicy,
  saveProviderConfig,
  startOauthLogin,
  type OauthLoginDeps,
  type OauthLoginResult,
  type OauthSchema,
  type ProviderPatch,
  type ProviderPublicConfig,
} from "./oauth-login.js";

export type { OauthSchema, OauthLoginResult };
export type ZerocatOauthDeps = OauthLoginDeps;

export const ZEROCAT_PROVIDER = "zerocat" as const;

export const ZEROCAT_DEFAULTS = {
  authorizeUrl: "https://api.zcservice.houlang.cloud/oauth/authorize",
  tokenUrl: "https://api.zcservice.houlang.cloud/oauth/token",
  userinfoUrl: "https://api.zcservice.houlang.cloud/oauth/userinfo",
  scope: "user:read",
} as const;

export const OAUTH_SETTINGS_KEY = "auth.oauth.zerocat";

export type ZerocatOauthPublicConfig = Omit<ProviderPublicConfig, "id" | "name" | "ready"> & {
  disablePasswordLogin: boolean;
};

export type ZerocatOauthPatch = ProviderPatch & {
  disablePasswordLogin?: boolean;
};

/** @deprecated use redirectUriFor(webPublicUrl, "zerocat") from oauth-login */
export function redirectUriFor(webPublicUrl: string): string {
  return redirectUriForProvider(webPublicUrl, "zerocat");
}

export async function loadZerocatConfig(
  deps: Pick<
    OauthLoginDeps,
    "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson"
  >,
): Promise<{
  stored: Awaited<ReturnType<typeof loadProviderConfig>>["stored"] & {
    disablePasswordLogin: boolean;
  };
  public: ZerocatOauthPublicConfig;
  clientSecret: string | null;
}> {
  const loaded = await loadProviderConfig(deps, "zerocat");
  const policy = await loadLoginPolicy(deps);
  const disablePasswordLogin =
    policy.stored.disablePasswordLogin || !!loaded.stored.disablePasswordLogin;

  return {
    stored: { ...loaded.stored, disablePasswordLogin },
    clientSecret: loaded.clientSecret,
    public: {
      enabled: loaded.public.ready,
      clientId: loaded.public.clientId,
      hasClientSecret: loaded.public.hasClientSecret,
      authorizeUrl: loaded.public.authorizeUrl,
      tokenUrl: loaded.public.tokenUrl,
      userinfoUrl: loaded.public.userinfoUrl,
      scope: loaded.public.scope,
      allowRegistration: loaded.public.allowRegistration,
      disablePasswordLogin: !!(disablePasswordLogin && loaded.public.ready),
      redirectUri: loaded.public.redirectUri,
    },
  };
}

export async function saveZerocatConfig(
  deps: OauthLoginDeps,
  patch: ZerocatOauthPatch,
): Promise<ZerocatOauthPublicConfig> {
  const { disablePasswordLogin, ...providerPatch } = patch;
  await saveProviderConfig(deps, "zerocat", providerPatch);

  if (disablePasswordLogin !== undefined) {
    await saveLoginPolicy(deps, { disablePasswordLogin });
  }

  return (await loadZerocatConfig(deps)).public;
}

export async function startZerocatOauth(
  deps: OauthLoginDeps,
): Promise<{ authorizeUrl: string }> {
  return startOauthLogin(deps, "zerocat");
}

export async function completeZerocatOauth(
  deps: OauthLoginDeps,
  input: { code: string; state: string },
): Promise<OauthLoginResult> {
  return completeOauthLogin(deps, "zerocat", input);
}
