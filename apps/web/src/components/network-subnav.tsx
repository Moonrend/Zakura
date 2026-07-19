"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NETWORK_SUBNAV, networkPath } from "@/lib/network";
import { cn } from "@/lib/utils";

export function NetworkSubnav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-1 border-b border-border pb-2">
      {NETWORK_SUBNAV.map((item) => {
        const href = networkPath(item.href || undefined);
        const active =
          item.href === ""
            ? pathname === "/dashboard/network"
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={item.href || "overview"}
            href={href}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
