"use client";

import { useMemo, useState } from "react";
import { Blocks, FileUp, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import { ZAKURA_RUNTIME_ID, type ComposerSkillOption, type ComposerToolGroup } from "@zakura/shared";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ComposerToolGroup["kind"], string> = {
  builtin: "内置",
  connector: "连接器",
  mcp: "MCP",
};

export type ComposerSlashCommand = { name: string; description?: string };

function ConnectorGroups({
  groups,
  disabledIds,
  onToggle,
}: {
  groups: ComposerToolGroup[];
  disabledIds: readonly string[];
  onToggle: (id: string) => void;
}) {
  const sections = useMemo(() => {
    const order: ComposerToolGroup["kind"][] = ["builtin", "connector", "mcp"];
    return order
      .map((kind) => ({ kind, items: groups.filter((g) => g.kind === kind) }))
      .filter((s) => s.items.length > 0);
  }, [groups]);

  if (!groups.length) {
    return <DropdownMenuItem disabled>没有可开关的工具</DropdownMenuItem>;
  }

  return (
    <>
      {sections.map((section) => (
        <DropdownMenuGroup key={section.kind}>
          <DropdownMenuLabel>{KIND_LABEL[section.kind]}</DropdownMenuLabel>
          {section.items.map((group) => {
            const on = !disabledIds.includes(group.id);
            return (
              <DropdownMenuItem
                key={group.id}
                closeOnClick={false}
                onClick={() => onToggle(group.id)}
                className="items-center gap-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{group.label}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {group.tools.length} 个工具
                  </span>
                </span>
                <Switch
                  size="sm"
                  checked={on}
                  readOnly
                  tabIndex={-1}
                  className="pointer-events-none"
                  aria-hidden
                />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

export function ComposerPlusMenu({
  canAttach,
  attachHint,
  onUpload,
  skills,
  selectedSkills,
  onToggleSkill,
  groups,
  disabledGroupIds,
  onToggleGroup,
  commands,
  onCommand,
  runtimeId,
}: {
  canAttach: boolean;
  attachHint: string;
  onUpload: () => void;
  skills: ComposerSkillOption[];
  selectedSkills: readonly string[];
  onToggleSkill: (name: string) => void;
  groups: ComposerToolGroup[];
  disabledGroupIds: readonly string[];
  onToggleGroup: (id: string) => void;
  /** ACP Agent 通过 session/update 公告的斜杠命令；仅 ACP 执行方显示 */
  commands?: readonly ComposerSlashCommand[];
  onCommand?: (name: string) => void;
  /** 当前执行方：zakura 或 ACP profile id。技能/连接器是 Zakura 运行时的概念 */
  runtimeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const disabledCount = disabledGroupIds.length;
  const marked = selectedSkills.length > 0 || disabledCount > 0;
  const isAcpRuntime = Boolean(runtimeId && runtimeId !== ZAKURA_RUNTIME_ID);
  const showCommands = isAcpRuntime && (commands?.length ?? 0) > 0 && Boolean(onCommand);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="添加"
                aria-expanded={open}
                className="relative size-8 rounded-full text-muted-foreground"
              />
            }
          >
            <Plus
              className={cn(
                "size-4 transition-transform duration-200 ease-out-soft",
                open && "rotate-45",
              )}
            />
            {marked ? (
              <span
                aria-hidden
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-foreground"
              />
            ) : null}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>添加</TooltipContent>
      </Tooltip>

      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-64">
        <DropdownMenuItem disabled={!canAttach} onClick={onUpload}>
          <FileUp />
          <span className="min-w-0 flex-1 truncate">上传文件</span>
          {!canAttach ? (
            <span className="max-w-24 truncate text-[11px] text-muted-foreground">{attachHint}</span>
          ) : null}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>命令</DropdownMenuLabel>
          {showCommands ? (
            <div className="max-h-[min(16rem,var(--available-height))] overflow-y-auto">
              {commands!.map((command) => (
                <DropdownMenuItem
                  key={command.name}
                  onClick={() => onCommand?.(command.name)}
                  className="items-start gap-2"
                >
                  <SquareTerminal />
                  <span className="min-w-0 flex-1 pr-1">
                    <span className="block truncate font-mono text-[13px]">/{command.name}</span>
                    {command.description ? (
                      <span className="mt-0.5 line-clamp-2 text-[11px] font-normal text-muted-foreground">
                        {command.description}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ) : !isAcpRuntime && skills.length > 0 ? (
            <div className="max-h-[min(16rem,var(--available-height))] overflow-y-auto">
              {skills.map((skill) => (
                <DropdownMenuItem
                  key={skill.name}
                  onClick={() => onToggleSkill(skill.name)}
                  className="items-start gap-2"
                >
                  <Blocks />
                  <span className="min-w-0 flex-1 pr-1">
                    <span className="block truncate font-mono text-[13px]">/{skill.name}</span>
                    {skill.description || skill.title ? (
                      <span className="mt-0.5 line-clamp-2 text-[11px] font-normal text-muted-foreground">
                        {skill.description || skill.title}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ) : (
            <DropdownMenuItem disabled>
              <SquareTerminal />
              <span className="min-w-0 flex-1">输入 / 插入命令</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>

        {isAcpRuntime ? null : (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Blocks />
                <span className="min-w-0 flex-1 truncate">技能</span>
                {selectedSkills.length ? (
                  <span className="text-[11px] text-muted-foreground">{selectedSkills.length}</span>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56 max-h-[min(18rem,var(--available-height))]">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>要求本回合使用</DropdownMenuLabel>
                  {skills.length === 0 ? (
                    <DropdownMenuItem disabled>还没有安装技能</DropdownMenuItem>
                  ) : (
                    skills.map((skill) => (
                      <DropdownMenuCheckboxItem
                        key={skill.name}
                        checked={selectedSkills.includes(skill.name)}
                        onCheckedChange={() => onToggleSkill(skill.name)}
                        className="items-start"
                      >
                        <span className="min-w-0 flex-1 pr-1">
                          <span className="block truncate">{skill.title || skill.name}</span>
                          {skill.description ? (
                            <span className="mt-0.5 line-clamp-2 text-[11px] font-normal text-muted-foreground">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Unplug />
                <span className="min-w-0 flex-1 truncate">连接器</span>
                {disabledCount ? (
                  <span className="text-[11px] text-muted-foreground">关 {disabledCount}</span>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 max-h-[min(20rem,var(--available-height))]">
                <p className="px-1.5 py-1 text-xs text-muted-foreground">本对话可用的工具</p>
                <ConnectorGroups
                  groups={groups}
                  disabledIds={disabledGroupIds}
                  onToggle={onToggleGroup}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SkillRequestChip({
  name,
  title,
  onRemove,
}: {
  name: string;
  title?: string;
  onRemove: () => void;
}) {
  return (
    <span
      title={name}
      className="animate-pop flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 py-1 pr-1 pl-2"
    >
      <Blocks className="size-3.5 text-muted-foreground" />
      <span className="max-w-36 truncate text-xs">{title || name}</span>
      <button
        type="button"
        aria-label={`取消使用 ${title || name}`}
        className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
