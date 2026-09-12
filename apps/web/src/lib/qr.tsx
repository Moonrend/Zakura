"use client";

import { useMemo } from "react";
import { encode } from "uqr";
import { cn } from "@/lib/utils";

export function QrSvg({
  value,
  className,
  label = "二维码",
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const { size, data } = useMemo(() => encode(value, { ecc: "M", border: 2 }), [value]);
  const dots = useMemo(() => {
    const parts: string[] = [];
    for (let y = 0; y < size; y++) {
      const row = data[y];
      if (!row) continue;
      for (let x = 0; x < size; x++) {
        if (row[x]) parts.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return parts.join("");
  }, [data, size]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("size-44 rounded-md border bg-white text-neutral-950", className)}
      shapeRendering="crispEdges"
    >
      <path d={dots} fill="currentColor" />
    </svg>
  );
}

export function formatTotpSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
