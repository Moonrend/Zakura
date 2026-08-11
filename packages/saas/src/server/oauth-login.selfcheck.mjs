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

if (!isSyntheticEmail("alice@zerocat.oauth")) throw new Error("synthetic detect failed");
if (isSyntheticEmail("alice@gmail.com")) throw new Error("real email flagged synthetic");
if (!isLoginOauthProviderId("google")) throw new Error("google id rejected");
if (isLoginOauthProviderId("twitter")) throw new Error("unknown id accepted");
if (asEmail("  Foo@Bar.COM ") !== "foo@bar.com") throw new Error("email normalize failed");
console.log("oauth-login.selfcheck ok");
