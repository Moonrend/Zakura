/**
 * ponytail: runnable check for oauth-login pure helpers.
 * Run: node packages/saas/src/server/oauth-login.selfcheck.mjs
 */
function isSyntheticEmail(email) {
  return email.endsWith(".oauth");
}
function isLoginOauthProviderId(value) {
  return ["zerocat", "google", "github", "microsoft"].includes(value);
}
function asEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}
function parseHighlightedMethod(value) {
  if (value === "auto" || value === "password") return value;
  if (typeof value === "string" && isLoginOauthProviderId(value)) return value;
  return "auto";
}
function resolveHighlightedMethod({ stored, passwordLoginEnabled, readyProviderIds }) {
  if (stored === "auto") return "auto";
  if (stored === "password") return passwordLoginEnabled ? "password" : "auto";
  return readyProviderIds.includes(stored) ? stored : "auto";
}

if (!isSyntheticEmail("alice@zerocat.oauth")) throw new Error("synthetic detect failed");
if (isSyntheticEmail("alice@gmail.com")) throw new Error("real email flagged synthetic");
if (!isLoginOauthProviderId("google")) throw new Error("google id rejected");
if (isLoginOauthProviderId("twitter")) throw new Error("unknown id accepted");
if (asEmail("  Foo@Bar.COM ") !== "foo@bar.com") throw new Error("email normalize failed");
if (parseHighlightedMethod("github") !== "github") throw new Error("highlight parse failed");
if (
  resolveHighlightedMethod({
    stored: "google",
    passwordLoginEnabled: true,
    readyProviderIds: ["github"],
  }) !== "auto"
) {
  throw new Error("highlight resolve should fall back");
}
console.log("oauth-login.selfcheck ok");
