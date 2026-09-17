/** Only the first-party device consent page may resume after tenant login. */
export function rememberBotLoginReturn() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next?.startsWith("/console/zakurabot/authorize?user_code=")) {
    sessionStorage.setItem("zakura.bot-login-return", next);
  }
}

export function consumeBotLoginReturn(): string | null {
  const next = sessionStorage.getItem("zakura.bot-login-return");
  sessionStorage.removeItem("zakura.bot-login-return");
  if (!next) return null;
  const url = new URL(next, window.location.origin);
  return url.origin === window.location.origin && url.pathname === "/console/zakurabot/authorize"
    ? `${url.pathname}${url.search}` : null;
}
