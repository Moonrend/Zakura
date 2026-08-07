"use client";

import { useEffect } from "react";
import {
  requestNotificationPermissionIdle,
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

/** 全局挂载：登录后空闲请求通知权限，并订阅连接器入站。不挡首屏。 */
export function ConnectorBrowserNotifications() {
  useEffect(() => {
    let unsub: (() => void) | undefined;

    const arm = () => {
      if (!hasSession()) {
        unsub?.();
        unsub = undefined;
        return;
      }
      if (unsub) return;
      requestNotificationPermissionIdle();
      unsub = subscribePlatformEvents((ev) => {
        if (ev.type !== "connector_inbound") return;
        const label = platformLabel(ev.platform);
        showConnectorNotification({
          title: ev.title?.trim() || `${label} 新消息`,
          body: ev.preview || `来自 ${label} 的连接器消息`,
          tag: `connector:${ev.sessionId}`,
          onClickUrl: `/chat?agent=${encodeURIComponent(ev.agentId)}&session=${encodeURIComponent(ev.sessionId)}`,
        });
      });
    };

    arm();
    window.addEventListener("zakura_session_changed", arm);
    return () => {
      window.removeEventListener("zakura_session_changed", arm);
      unsub?.();
    };
  }, []);

  return null;
}
