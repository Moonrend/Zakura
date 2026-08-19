"use client";

import { ChatApp } from "@/components/chat/chat-app";
import { ImageUpdateBanner } from "@/components/image-update-banner";

export default function ChatPage() {
  return (
    <>
      <ChatApp />
      <ImageUpdateBanner />
    </>
  );
}
