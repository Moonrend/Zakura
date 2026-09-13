"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight"
import {
  FluidHoverContextOnly,
  FluidHoverProvider,
  useFluidHoverScope,
  useFluidItem,
  useOptionalFluidHover,
} from "@/components/ui/fluid-hover"

function Table({ className, children, ...props }: React.ComponentProps<"table">) {
  const { ref, hover } = useFluidHoverScope({ gapClick: false })
  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      data-slot="table-container"
      className="relative w-full overflow-x-auto rounded-lg bg-card shadow-surface-2"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="z-0 rounded-md" />
      <table
        data-slot="table"
        className={cn("relative z-[1] w-full caption-bottom text-sm", className)}
        {...props}
      >
        <FluidHoverContextOnly hover={hover}>{children}</FluidHoverContextOnly>
      </table>
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-muted/40 [&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, children, ...props }: React.ComponentProps<"tbody">) {
  const hover = useOptionalFluidHover()
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    >
      {hover ? <FluidHoverProvider hover={hover}>{children}</FluidHoverProvider> : children}
    </tbody>
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  const ref = React.useRef<HTMLTableRowElement>(null)
  useFluidItem(ref)
  return (
    <tr
      ref={ref}
      data-slot="table-row"
      className={cn(
        "relative z-[1] border-b transition-colors data-[state=selected]:bg-selected/40",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}


export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption
}
