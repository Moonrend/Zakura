"use client";

import { ChatApp } from "@/components/chat/chat-app";
import { WorkspaceImageUpgradeDialog } from "@/components/workspace-image-upgrade-dialog";

export default function ChatPage() {
  return (
    <>
      <ChatApp />
      <WorkspaceImageUpgradeDialog />
    </>
  );
}
