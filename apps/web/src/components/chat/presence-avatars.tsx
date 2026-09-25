"use client";

import type { PresenceLocation } from "@zakura/shared";
import { PresenceAvatarStack } from "@/components/user-avatar";

export function peopleFromPresence(peers: PresenceLocation[]) {
  return peers.map((p) => ({
    userId: p.userId,
    name: p.name,
    email: p.email,
    avatarRev: p.avatarRev,
  }));
}

export function PresenceAvatars({
  peers,
  onPick,
  max = 3,
  className,
}: {
  peers: PresenceLocation[];
  onPick?: (userId: string) => void;
  max?: number;
  className?: string;
}) {
  return (
    <PresenceAvatarStack
      people={peopleFromPresence(peers)}
      onPick={onPick}
      max={max}
      className={className}
    />
  );
}
