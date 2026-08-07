"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  connectorNotificationsEnabled,
  notificationPermission,
  requestNotificationPermissionNow,
  setConnectorNotificationsEnabled,
  showConnectorNotification,
} from "@/lib/browser-notifications";
import { subscribePlatformEvents } from "@/lib/platform-events";

const PLATFORM_LABEL: Record<string, string> = {
  email: "邮件",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  feishu: "飞书",
  wecom: "企业微信",
};

function platformLabel(platform: string) {
  return PLATFORM_LABEL[platform] ?? platform;
}

function hasSession(): boolean {
  return Boolean(localStorage.getItem("zakura_session"));
}

function shouldPromptPermission(): boolean {
  if (!hasSession()) return false;
  if (!connectorNotificationsEnabled()) return false;
  return notificationPermission() === "default";
}

/** 全局挂载：登录后主动引导授权，并订阅连接器入站通知。 */
export function ConnectorBrowserNotifications() {
  const [showPrompt, setShowPrompt] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const refreshPrompt = useCallback(() => {
    setShowPrompt(shouldPromptPermission());
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const arm = () => {
      if (!hasSession()) {
        unsub?.();
        unsub = undefined;
        setShowPrompt(false);
        return;
      }
      refreshPrompt();
      if (unsub) return;
      unsub = subscribePlatformEvents((ev) => {
        if (ev.type === "connector_inbound") {
          const label = platformLabel(ev.platform);
          showConnectorNotification({
            title: ev.title?.trim() || `${label} 新消息`,
            body: ev.preview || `来自 ${label} 的连接器消息`,
            tag: `connector:${ev.sessionId}`,
            onClickUrl: `/chat?agent=${encodeURIComponent(ev.agentId)}&session=${encodeURIComponent(ev.sessionId)}`,
          });
          return;
        }
        if (ev.type === "browser_notify") {
          showConnectorNotification({
            title: ev.title?.trim() || "通知",
            body: ev.body,
            tag: `browser-notify:${ev.agentId}:${ev.ts}`,
            onClickUrl:
              ev.url?.trim() ||
              (ev.agentId && ev.agentId !== "unknown"
                ? `/chat?agent=${encodeURIComponent(ev.agentId)}`
                : undefined),
          });
        }
      });
    };

    arm();
    window.addEventListener("zakura_session_changed", arm);
    window.addEventListener("zakura_notification_pref_changed", refreshPrompt);
    return () => {
      window.removeEventListener("zakura_session_changed", arm);
      window.removeEventListener("zakura_notification_pref_changed", refreshPrompt);
      unsub?.();
    };
  }, [refreshPrompt]);

  async function enable() {
    setRequesting(true);
    try {
      setConnectorNotificationsEnabled(true);
      const perm = await requestNotificationPermissionNow();
      if (perm === "granted") {
        setShowPrompt(false);
      } else if (perm === "denied") {
        setConnectorNotificationsEnabled(false);
        setShowPrompt(false);
      } else {
        refreshPrompt();
      }
      window.dispatchEvent(new Event("zakura_notification_pref_changed"));
    } finally {
      setRequesting(false);
    }
  }

  function dismiss() {
    setConnectorNotificationsEnabled(false);
    setShowPrompt(false);
    window.dispatchEvent(new Event("zakura_notification_pref_changed"));
  }

  return showPrompt ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-border bg-background p-3 shadow-lg">
        <Bell className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">开启浏览器通知</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            后台时可及时收到连接器入站与 Agent 通知。默认已安装到全部 Agent。
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" disabled={requesting} onClick={() => void enable()}>
              允许通知
            </Button>
            <Button size="sm" variant="ghost" disabled={requesting} onClick={dismiss}>
              暂不
            </Button>
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="关闭"
          onClick={dismiss}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  ) : null;
}
