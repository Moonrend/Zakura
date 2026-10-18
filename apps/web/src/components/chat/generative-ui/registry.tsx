"use client";

import { createContext, useContext, useId, useState } from "react";
import { defineRegistry, useBoundProp, type ComponentRenderProps } from "@json-render/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { uiCatalog } from "@/lib/generative-ui-catalog";
import { cn } from "@/lib/utils";

export const UIInteractionContext = createContext({ editable: false, canSubmit: false, pending: false });

function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{children(id)}</div>;
}

function CategoryBars({ title, data, unit = "" }: { title: string; data: Array<{ label: string; value: number }>; unit?: string }) {
  const [table, setTable] = useState(false);
  const max = Math.max(0, ...data.map((row) => row.value));
  return <figure className="min-w-0 space-y-3" aria-label={title}>
    <div className="flex items-center justify-between gap-3"><figcaption className="text-sm font-medium">{title}</figcaption><Button size="sm" variant="ghost" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "查看图形" : "查看数据"}</Button></div>
    {table ? <Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">数值{unit ? `（${unit}）` : ""}</TableHead></TableRow></TableHeader><TableBody>{data.map((row, index) => <TableRow key={index}><TableCell>{row.label}</TableCell><TableCell className="text-right tabular-nums">{row.value}</TableCell></TableRow>)}</TableBody></Table> : <div className="space-y-1">{data.map((row, index) => <div key={index} tabIndex={0} title={`${row.label}：${row.value}${unit}`} className="group grid min-h-9 grid-cols-[minmax(4rem,1fr)_minmax(0,3fr)_auto] items-center gap-3 rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${row.label}：${row.value}${unit}`}>
      <span className="break-words text-xs text-muted-foreground">{row.label}</span><div className="flex h-6 items-center border-l border-border"><div className="h-4 rounded-r-[4px] bg-foreground/70 transition-opacity group-hover:opacity-70 group-focus:opacity-70" style={{ width: `${max > 0 ? Math.max(0, row.value) / max * 100 : 0}%` }} /></div><span className="text-xs tabular-nums text-foreground">{row.value}{unit}</span>
    </div>)}</div>}
    {data.length === 0 && <p className="text-sm text-muted-foreground">暂无数据</p>}
  </figure>;
}

const { registry } = defineRegistry(uiCatalog, {
  components: {
    Stack: ({ props, children }) => <div className={cn("flex min-w-0", props.direction === "horizontal" ? "flex-col sm:flex-row sm:flex-wrap sm:items-start [&>*]:min-w-0 [&>*]:flex-1" : "flex-col", props.gap === "small" ? "gap-2" : props.gap === "large" ? "gap-6" : "gap-4")}>{children}</div>,
    Card: ({ props, children }) => <Card className="w-full min-w-0" size="sm">{(props.title || props.description) && <CardHeader>{props.title != null && <CardTitle>{String(props.title)}</CardTitle>}{props.description != null && <CardDescription>{String(props.description)}</CardDescription>}</CardHeader>}<CardContent className="flex min-w-0 flex-col gap-4">{children}</CardContent></Card>,
    Text: ({ props }) => props.tone === "heading" ? <h3 className="text-base font-medium leading-snug">{String(props.text ?? "")}</h3> : <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", props.tone === "muted" && "text-muted-foreground")}>{String(props.text ?? "")}</p>,
    Divider: () => <hr className="border-border/60" />,
    Input: function UIInput({ props, bindings }) {
      const { editable } = useContext(UIInteractionContext);
      const [value, set] = useBoundProp<string | number>(props.value as string | number, bindings?.value);
      return <Field label={props.label}>{(id) => <Input id={id} type={props.type ?? "text"} value={value ?? ""} placeholder={props.placeholder} min={props.min} max={props.max} step={props.step} disabled={!editable} onChange={(event) => {
        if (props.type === "number") { const n = event.currentTarget.valueAsNumber; if (Number.isFinite(n)) set(n); }
        else set(event.currentTarget.value);
      }} />}</Field>;
    },
    Select: function UISelect({ props, bindings }) {
      const { editable } = useContext(UIInteractionContext);
      const [value, set] = useBoundProp<string>(props.value as string, bindings?.value);
      return <Field label={props.label}>{(id) => <Select value={String(value ?? "")} onValueChange={(next) => { if (next != null) set(next); }} disabled={!editable}><SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{props.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>}</Field>;
    },
    Checkbox: function UICheckbox({ props, bindings }) {
      const { editable } = useContext(UIInteractionContext);
      const [checked, set] = useBoundProp<boolean>(props.checked as boolean, bindings?.checked);
      const id = useId();
      return <div className="flex items-center gap-2"><Checkbox id={id} checked={checked ?? false} onCheckedChange={set} disabled={!editable} /><label htmlFor={id} className="text-sm">{props.label}</label></div>;
    },
    Slider: function UISlider({ props, bindings }) {
      const { editable } = useContext(UIInteractionContext);
      const [value, set] = useBoundProp<number>(props.value as number, bindings?.value);
      return <Field label={props.label}>{(id) => <div className="flex items-center gap-3"><input id={id} className="h-8 min-w-0 flex-1 accent-foreground focus-visible:outline-ring" type="range" min={props.min} max={props.max} step={props.step ?? 1} value={Number(value ?? props.min)} disabled={!editable} onChange={(event) => set(event.currentTarget.valueAsNumber)} /><output htmlFor={id} className="min-w-12 text-right text-sm tabular-nums">{Number(value ?? props.min)}{props.unit}</output></div>}</Field>;
    },
    Button: function UIButton({ props, emit }) {
      const { editable, canSubmit, pending } = useContext(UIInteractionContext);
      return <Button type="button" className="self-start" variant={props.variant ?? "default"} disabled={!editable || !canSubmit || pending} onClick={() => emit("press")}>{pending ? "处理中…" : props.label}</Button>;
    },
    Table: ({ props }) => <div className="min-w-0 overflow-x-auto"><Table>{props.caption && <caption className="pb-2 text-left text-sm text-muted-foreground">{props.caption}</caption>}<TableHeader><TableRow>{props.columns.map((column) => <TableHead key={column.key}>{column.label}</TableHead>)}</TableRow></TableHeader><TableBody>{(Array.isArray(props.rows) ? props.rows : []).map((row, index) => <TableRow key={index}>{props.columns.map((column) => <TableCell key={column.key} className="max-w-64 whitespace-normal break-words">{String(row[column.key] ?? "")}</TableCell>)}</TableRow>)}</TableBody></Table></div>,
    BarChart: ({ props }) => <CategoryBars {...props} />,
  },
  actions: { continueConversation: async () => {} },
});

export const uiRegistry = {
  ...registry,
  Button: function UIActionButton({ element, emit }: ComponentRenderProps) {
    const { editable, canSubmit, pending } = useContext(UIInteractionContext);
    const binding = Array.isArray(element.on?.press) ? element.on.press[0] : element.on?.press;
    const submitting = binding?.action === "continueConversation";
    return <Button type="button" className="self-start" variant={element.props.variant as "default" | "outline" | "ghost" | undefined} disabled={!editable || pending || submitting && !canSubmit} onClick={() => emit("press")}>{submitting && pending ? "处理中…" : String(element.props.label ?? "")}</Button>;
  },
};
