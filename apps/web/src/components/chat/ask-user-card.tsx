"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/lib/cloud-agent";

function remainingLabel(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "即将超时";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec} 秒后超时`;
  const min = Math.ceil(sec / 60);
  return `${min} 分钟后超时`;
}

export function AskUserCard({
  item,
  onResolve,
}: {
  item: Extract<TimelineItem, { kind: "ask_user" }>;
  onResolve?: (input: {
    requestId: string;
    cancelled?: boolean;
    selected?: string[];
    text?: string;
  }) => void;
}) {
  const [selected, setSelected] = useState<string[]>(item.defaultOptionIds ?? []);
  const [text, setText] = useState("");
  const [tick, setTick] = useState(0);
  const options = item.options ?? [];
  const single = !item.allowMultiple;

  useEffect(() => {
    if (!item.expiresAt || item.resolved) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [item.expiresAt, item.resolved]);

  const timeoutHint = remainingLabel(item.expiresAt);
  void tick;

  const resolvedText =
    item.resolved?.status === "cancelled"
      ? "已取消"
      : item.resolved?.status === "timeout"
        ? item.resolved.selected?.length
          ? "超时 · 已用默认项"
          : "超时 · 未选择"
        : item.resolved?.status === "skipped"
          ? "已跳过"
          : item.secret
            ? "已提交（已掩码）"
            : "已回答";

  return (
    <div className="surface-2 my-2 max-w-md space-y-2.5 rounded-xl px-3 py-3 text-sm">
      <div className="font-medium text-foreground">{item.question}</div>
      {item.mode === "async" ? (
        <div className="text-[11px] text-muted-foreground">异步询问 · 回答前 Agent 会继续做别的事</div>
      ) : null}
      {timeoutHint && !item.resolved ? (
        <div className="text-[11px] text-muted-foreground">
          {timeoutHint}
          {item.timeoutAction === "default" ? " · 将采用默认项" : " · 将自动跳过"}
        </div>
      ) : null}

      {item.resolved ? (
        <div className="text-xs text-muted-foreground">
          {resolvedText}
          {!item.secret && item.resolved.selected?.length
            ? ` · ${item.resolved.selected
                .map((id) => options.find((o) => o.id === id)?.label ?? id)
                .join("、")}`
            : ""}
        </div>
      ) : (
        <>
          {options.length > 0 && single ? (
            <RadioGroup
              value={selected[0] ?? ""}
              onValueChange={(v) => setSelected(v ? [v] : [])}
            >
              {options.map((opt, i) => (
                <RadioItem
                  key={opt.id}
                  index={i}
                  value={opt.id}
                  label={opt.label}
                  description={opt.description}
                />
              ))}
            </RadioGroup>
          ) : null}
          {options.length > 0 && item.allowMultiple ? (
            <div className="flex flex-col gap-1">
              {options.map((opt) => {
                const on = selected.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() =>
                      setSelected((prev) =>
                        on ? prev.filter((id) => id !== opt.id) : [...prev, opt.id],
                      )
                    }
                    className={cn(
                      "rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 ease-fluid",
                      on ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {opt.label}
                    {opt.description ? (
                      <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                        {opt.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {options.length === 0 || item.secret ? (
            <Input
              type={item.secret ? "password" : "text"}
              autoComplete="off"
              placeholder={item.placeholder || (item.secret ? "输入后仅 Agent 可见" : "可选补充")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="max-w-full"
            />
          ) : options.length > 0 && !item.secret ? (
            <Input
              placeholder={item.placeholder || "可选补充"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                onResolve?.({
                  requestId: item.requestId,
                  selected,
                  text: text.trim() || undefined,
                })
              }
            >
              提交
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onResolve?.({ requestId: item.requestId, cancelled: true })}
            >
              跳过
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
