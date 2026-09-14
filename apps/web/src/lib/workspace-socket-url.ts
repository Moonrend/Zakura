/** Resolve server tickets through the current reverse proxy when configured locally. */
export function workspaceSocketUrl(url: string, currentUrl: string): string {
  const current = new URL(currentUrl);
  const target = new URL(url, current);
  if (["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(target.hostname)) {
    target.protocol = current.protocol === "https:" ? "wss:" : "ws:";
    target.hostname = current.hostname;
    // URL.host = "example.com" retains an existing :3000 port. Clear it explicitly.
    target.port = current.port;
  } else {
    target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
  }
  return target.toString();
}
