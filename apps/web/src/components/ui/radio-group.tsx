"use client";

/**
 * Fluid Functionalism RadioGroup：瞄准预览 + 选中背景弹簧跟随。
 */
import {
  Children,
  isValidElement,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { motion } from "framer-motion";
import { spring } from "@/lib/springs";
import {
  FluidHoverProvider,
  useFluidItem,
} from "@/components/ui/fluid-hover";

type RadioGroupProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  children: ReactNode;
  value?: string;
  onValueChange?: (value: string) => void;
};

export function RadioGroup({
  children,
  value,
  onValueChange,
  className,
  ...props
}: RadioGroupProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(containerRef);
  const items = Children.toArray(children).filter(isValidElement);
  const values = items.map((child) => (child.props as { value?: string }).value);
  const selectedIndex = value ? values.findIndex((v) => v === value) : -1;
  const selectedRect =
    selectedIndex >= 0 ? hover.itemRects[selectedIndex] : null;

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      className={cn("relative flex w-full max-w-md flex-col select-none", className)}
      {...hover.handlers}
      {...props}
      onKeyDown={(e) => {
        const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
        if (!keys.includes(e.key) || values.length === 0) return;
        e.preventDefault();
        const current = Math.max(selectedIndex, 0);
        let next = current;
        if (e.key === "Home") next = 0;
        else if (e.key === "End") next = values.length - 1;
        else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          next = (current + 1) % values.length;
        } else {
          next = (current - 1 + values.length) % values.length;
        }
        const v = values[next];
        if (v) onValueChange?.(v);
      }}
    >
      {selectedRect ? (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 z-0 rounded-lg bg-selected/50"
          initial={false}
          animate={{
            x: selectedRect.left,
            y: selectedRect.top,
            width: selectedRect.width,
            height: selectedRect.height,
          }}
          transition={spring.moderate}
        />
      ) : null}
      <FluidHoverHighlight hover={hover} className="z-0 rounded-lg" />
      <FluidHoverProvider hover={hover}>
        {items.map((child, index) => {
          const p = child.props as RadioItemProps;
          return (
            <RadioItem
              key={p.value ?? index}
              {...p}
              index={index}
              selected={value !== undefined ? value === p.value : p.selected}
              onSelect={() => {
                if (p.value) onValueChange?.(p.value);
                p.onSelect?.();
              }}
            />
          );
        })}
      </FluidHoverProvider>
    </div>
  );
}

export type RadioItemProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
  description?: string;
  index?: number;
  selected?: boolean;
  onSelect?: () => void;
  value?: string;
};

export function RadioItem({
  label,
  description,
  index,
  selected,
  onSelect,
  value,
  className,
  ...props
}: RadioItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFluidItem(ref, index);
  return (
    <div
      ref={ref}
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={selected ? 0 : index === 0 ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        "relative z-10 flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 outline-none",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-[border-color] duration-150 ease-fluid",
          selected ? "border-foreground" : "border-border",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full bg-foreground transition-transform duration-150 ease-fluid",
            selected ? "scale-100" : "scale-0",
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm transition-[color,font-variation-settings] duration-150 ease-fluid",
            selected
              ? "font-medium text-foreground [font-variation-settings:'wght'_550,'opsz'_18]"
              : "text-muted-foreground [font-variation-settings:'wght'_400,'opsz'_14]",
          )}
        >
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </div>
  );
}
