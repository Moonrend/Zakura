"use client";

import {
  Children,
  createContext,
  useContext,
  useMemo,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
  type UseFluidHoverOptions,
  type UseFluidHoverReturn,
} from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";

const FluidHoverContext = createContext<UseFluidHoverReturn | null>(null);
const FluidHoverIndexContext = createContext<number | undefined>(undefined);
const FluidHoverAllocContext = createContext<{ claim: () => number } | null>(null);

export function useOptionalFluidHover() {
  return useContext(FluidHoverContext);
}

export function useFluidHoverIndex() {
  return useContext(FluidHoverIndexContext);
}

export function useFluidHoverScope(options?: UseFluidHoverOptions) {
  const ref = useRef<HTMLElement | null>(null);
  const hover = useFluidHover(ref, options);
  const seq = useRef(0);
  const alloc = useMemo(() => ({ claim: () => seq.current++ }), []);
  return { ref, hover, alloc };
}

export function FluidHoverContextOnly({
  hover,
  alloc,
  children,
}: {
  hover: UseFluidHoverReturn;
  alloc?: { claim: () => number };
  children: ReactNode;
}) {
  const inner = (
    <FluidHoverContext.Provider value={hover}>{children}</FluidHoverContext.Provider>
  );
  if (!alloc) return inner;
  return (
    <FluidHoverAllocContext.Provider value={alloc}>{inner}</FluidHoverAllocContext.Provider>
  );
}

export function FluidHoverProvider({
  hover,
  children,
}: {
  hover: UseFluidHoverReturn;
  children: ReactNode;
}) {
  return (
    <FluidHoverContext.Provider value={hover}>
      {Children.map(children, (child, index) => (
        <FluidHoverIndexContext.Provider value={index}>
          {child}
        </FluidHoverIndexContext.Provider>
      ))}
    </FluidHoverContext.Provider>
  );
}

export function useFluidItem(
  ref: RefObject<HTMLElement | null>,
  index?: number,
) {
  const hover = useContext(FluidHoverContext);
  const ctxIndex = useContext(FluidHoverIndexContext);
  const alloc = useContext(FluidHoverAllocContext);
  const owned = useRef<number | undefined>(undefined);
  if (owned.current === undefined) {
    owned.current = index ?? ctxIndex ?? alloc?.claim();
  }
  useRegisterFluidHoverItem(hover?.registerItem, owned.current, ref);
}

type FluidListProps = HTMLAttributes<HTMLDivElement> &
  UseFluidHoverOptions & {
    highlightClassName?: string;
  };

/** 列表/网格容器：指针靠近哪一项，高亮就弹簧跟过去。 */
export function FluidList({
  axis = "y",
  gapClick = true,
  isItemDisabled,
  className,
  highlightClassName,
  children,
  ...props
}: FluidListProps) {
  const { ref, hover } = useFluidHoverScope({ axis, gapClick, isItemDisabled });
  return (
    <div
      ref={ref as RefObject<HTMLDivElement>}
      className={cn("relative", className)}
      {...hover.handlers}
      {...props}
    >
      <FluidHoverHighlight
        hover={hover}
        className={cn("z-0 rounded-lg", highlightClassName)}
      />
      <div className="relative z-[1] contents">
        <FluidHoverProvider hover={hover}>{children}</FluidHoverProvider>
      </div>
    </div>
  );
}

export function FluidItem({
  className,
  index,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { index?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFluidItem(ref, index);
  return (
    <div ref={ref} className={cn("relative", className)} {...props}>
      {children}
    </div>
  );
}
