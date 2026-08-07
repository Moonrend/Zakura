/**
 * 浏览器通知连接器：偏好默认开启；权限需用户手势授权。
 */

const PREF_KEY = "zakura_connector_notifications";

export const BROWSER_NOTIFICATIONS_REF = "browser-notifications";

export function connectorNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(PREF_KEY) !== "0";
}

export function setConnectorNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PREF_KEY, enabled ? "1" : "0");
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/** 用户手势路径：立刻请求权限。 */
export function requestNotificationPermissionNow(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return Promise.resolve("unsupported");
  }
  if (Notification.permission !== "default") {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission().catch(() => Notification.permission);
}

export function showConnectorNotification(input: {
  title: string;
  body?: string;
  tag?: string;
  onClickUrl?: string;
}): boolean {
  if (!connectorNotificationsEnabled()) return false;
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  // 前台页已有 SSE/聊天 UI，避免叠弹
  if (document.visibilityState === "visible") return false;

  try {
    const n = new Notification(input.title, {
      body: input.body?.slice(0, 180) || undefined,
      tag: input.tag,
    });
    if (input.onClickUrl) {
      n.onclick = () => {
        window.focus();
        window.location.assign(input.onClickUrl!);
        n.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}
