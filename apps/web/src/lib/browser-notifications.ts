/**
 * 连接器浏览器通知：偏好默认开启；权限请求走 idle，不挡首屏。
 */

const PREF_KEY = "zakura_connector_notifications";

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

/** 不 await、不挡渲染；仅在 preference 开且 permission=default 时请求一次。 */
export function requestNotificationPermissionIdle(): void {
  if (typeof window === "undefined") return;
  if (!connectorNotificationsEnabled()) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;

  const run = () => {
    if (!connectorNotificationsEnabled()) return;
    if (Notification.permission !== "default") return;
    void Notification.requestPermission().catch(() => undefined);
  };

  const ric = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === "function") {
    ric(run, { timeout: 4000 });
  } else {
    window.setTimeout(run, 1500);
  }
}

/** 用户手势路径：打开开关时立刻请求。 */
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
      renotify: Boolean(input.tag),
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
