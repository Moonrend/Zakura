"use client";

import { FolderKanban } from "lucide-react";
import { cn } from "@/lib/utils";
import { PresenceAvatars } from "./presence-avatars";
import type { PresenceLocation } from "@zakura/shared";

export function ChatProjectRow({
  slug,
  name,
  sessionCount,
  peers,
  onOpen,
  onPickUser,
}: {
  slug: string;
  name: string;
  sessionCount: number;
  peers: PresenceLocation[];
  onOpen: (slug: string) => void;
  onPickUser?: (userId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(slug)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
        "text-foreground/70 hover:bg-muted/40 hover:text-foreground",
      )}
    >
      <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground/70">{sessionCount}</span>
      <PresenceAvatars peers={peers} onPick={onPickUser} />
    </button>
  );
}
