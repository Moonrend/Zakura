export function describeUserAgent(ua: string | null | undefined): {
  label: string;
  os: string;
  browser: string;
} {
  if (!ua?.trim()) return { label: "未知设备", os: "", browser: "" };
  const os = /Windows NT/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua) && !/Edg\//i.test(ua)
      ? "Chrome"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Safari\//i.test(ua) && !/Chrome\//i.test(ua)
          ? "Safari"
          : "";
  const label = [browser, os].filter(Boolean).join(" · ") || "浏览器";
  return { label, os, browser };
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
