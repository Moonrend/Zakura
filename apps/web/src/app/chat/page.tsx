"use client";

import { ChatApp } from "@/components/chat/chat-app";
import { ImageUpdateBanner } from "@/components/image-update-banner";
import { WorkspaceImageUpgradeDialog } from "@/components/workspace-image-upgrade-dialog";

export default function ChatPage() {
  return (
    <>
      <ChatApp />
      <ImageUpdateBanner />
      <WorkspaceImageUpgradeDialog />
    </>
  );
}
