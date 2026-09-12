"use client";

import { useEffect, useState } from "react";
import { identiconFromId } from "@zakura/shared";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { getSession } from "@/lib/api";
import { cn } from "@/lib/utils";

const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(userId: string, rev: number) {
  return `${userId}:${rev}`;
}

function loadAvatarUrl(userId: string, rev: number): Promise<string | null> {
  const key = cacheKey(userId, rev);
  const hit = blobCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const token = getSession();
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/avatar${rev ? `?v=${rev}` : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const url = URL.createObjectURL(await res.blob());
      blobCache.set(key, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

export function IdenticonSvg({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const { cells, color } = identiconFromId(userId);
  return (
    <svg
      viewBox="-0.5 -0.5 6 6"
      className={cn("size-full", className)}
      shapeRendering="crispEdges"
      aria-hidden
    >
      <rect x="-0.5" y="-0.5" width="6" height="6" className="fill-muted" />
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={i % 5}
            y={Math.floor(i / 5)}
            width="1"
            height="1"
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}

export function UserAvatar({
  userId,
  name,
  email,
  avatarRev = 0,
  size = "default",
  className,
  title,
  onClick,
}: {
  userId: string;
  name?: string | null;
  email?: string | null;
  avatarRev?: number;
  size?: "default" | "sm" | "lg";
  className?: string;
  title?: string;
  onClick?: () => void;
}) {
  const label = title ?? (name?.trim() || email || "用户");
  const [src, setSrc] = useState<string | null>(() => blobCache.get(cacheKey(userId, avatarRev)) ?? null);

  useEffect(() => {
    let alive = true;
    const cached = blobCache.get(cacheKey(userId, avatarRev));
    if (cached) {
      setSrc(cached);
      return;
    }
    setSrc(null);
    void loadAvatarUrl(userId, avatarRev).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [userId, avatarRev]);

  return (
    <Avatar
      size={size}
      className={cn("overflow-hidden", onClick && "cursor-pointer", className)}
      title={label}
      onClick={onClick}
    >
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>
        <IdenticonSvg userId={userId} />
      </AvatarFallback>
      <span className="sr-only">{label}</span>
    </Avatar>
  );
}

export function PresenceAvatarStack({
  people,
  max = 3,
  size = "sm",
  onPick,
  className,
}: {
  people: Array<{ userId: string; name: string; email?: string; avatarRev?: number }>;
  max?: number;
  size?: "default" | "sm" | "lg";
  onPick?: (userId: string) => void;
  className?: string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <AvatarGroup
      className={cn("flex shrink-0 items-center", size === "sm" && "-space-x-1.5", className)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {shown.map((p) => (
        <UserAvatar
          key={p.userId}
          userId={p.userId}
          name={p.name}
          email={p.email}
          avatarRev={p.avatarRev}
          size={size}
          onClick={onPick ? () => onPick(p.userId) : undefined}
        />
      ))}
      {extra > 0 ? <AvatarGroupCount className={size === "sm" ? "size-6 text-[10px]" : undefined}>+{extra}</AvatarGroupCount> : null}
    </AvatarGroup>
  );
}

/** 账户页用：把任意图片压成 256 方图 JPEG。 */
export async function compressAvatarFile(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  const side = Math.min(bmp.width, bmp.height);
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("无法导出图片");
  return blob;
}
