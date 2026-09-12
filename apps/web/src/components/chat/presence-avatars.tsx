"use client";

import type { PresenceLocation } from "@zakura/shared";
import { PresenceAvatarStack, UserAvatar } from "@/components/user-avatar";
import type { RemoteAwareness } from "@/lib/sync/session-doc";

export function peopleFromPresence(peers: PresenceLocation[]) {
  return peers.map((p) => ({
    userId: p.userId,
    name: p.name,
    email: p.email,
    avatarRev: p.avatarRev,
  }));
}

export function peopleFromRemotes(
  remotes: RemoteAwareness[],
  peers: PresenceLocation[],
  pred: (r: RemoteAwareness) => boolean,
) {
  const seen = new Set<string>();
  const people: Array<{ userId: string; name: string; avatarRev?: number }> = [];
  for (const r of remotes) {
    if (!pred(r) || seen.has(r.user.id)) continue;
    seen.add(r.user.id);
    const peer = peers.find((p) => p.userId === r.user.id);
    people.push({
      userId: r.user.id,
      name: r.user.name,
      avatarRev: peer?.avatarRev,
    });
  }
  return people;
}

/** 换页 / 工具行旁的窥视头像：点一下跳到对方正在看的那一处。 */
export function PresencePeekAvatars({
  people,
  onPick,
  hint = "在看另一处",
}: {
  people: Array<{ userId: string; name: string; avatarRev?: number }>;
  onPick?: (userId: string) => void;
  hint?: string;
}) {
  if (people.length === 0) return null;
  return (
    <span
      className="ml-0.5 inline-flex items-center -space-x-1"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {people.slice(0, 3).map((p) => (
        <UserAvatar
          key={p.userId}
          userId={p.userId}
          name={p.name}
          avatarRev={p.avatarRev}
          size="sm"
          className="size-4"
          title={`${p.name} ${hint}`}
          onClick={onPick ? () => onPick(p.userId) : undefined}
        />
      ))}
    </span>
  );
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
