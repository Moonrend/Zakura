"use client";

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createStateStore, JSONUIProvider, Renderer } from "@json-render/react";
import { ChatMarkdown } from "@/components/markdown/chat-markdown";
import { Button } from "@/components/ui/button";
import { saveGeneratedUIState } from "@/lib/cloud-agent";
import { createUICompiler, splitUIContent, uiContentHash, validateStateForSpec, type UISnapshot, type UISpec, type UIState } from "@/lib/generative-ui";
import { uiFunctions, UI_CATALOG_VERSION } from "@/lib/generative-ui-catalog";
import { UIInteractionContext, uiRegistry } from "./registry";

export type UIContinue = (message: string, state: UIState, source: { messageId: string; blockIndex: number; contentHash: string; revision: number; submissionId: string; runId?: string | null }) => Promise<void>;

class UIErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert" className="text-sm text-muted-foreground">界面暂时无法显示，请让助手重新生成。</p> : this.props.children; }
}

type BlockProps = {
  content: string; complete: boolean; unclosed?: boolean; blockIndex: number; messageId: string;
  runId?: string | null; agentId?: string | null; sessionId?: string | null;
  snapshot?: UISnapshot; canSubmit: boolean; readOnly?: boolean; onContinue?: UIContinue;
};

function InteractiveUI({ spec, contentHash, ...props }: BlockProps & { spec: UISpec; contentHash: string }) {
  const { snapshot } = props;
  const validSnapshot = useMemo(() => {
    if (!snapshot || snapshot.contentHash !== contentHash || snapshot.catalogVersion !== UI_CATALOG_VERSION || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) return undefined;
    try { validateStateForSpec(snapshot.state, spec); return snapshot; } catch { return undefined; }
  }, [snapshot, contentHash, spec]);
  const initial = useMemo(() => {
    try { if (validSnapshot) { validateStateForSpec(validSnapshot.state, spec); return validSnapshot.state; } } catch { /* Invalid historical state falls back to defaults. */ }
    return spec.state ?? {};
    // The component is keyed by content hash; live state is updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const store = useMemo(() => createStateStore(structuredClone(initial)), [initial]);
  const revision = useRef(validSnapshot?.revision ?? 0);
  const saved = useRef(JSON.stringify(initial));
  const dirty = useRef(false);
  const applying = useRef(false);
  const chain = useRef(Promise.resolve());
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const submission = useRef<{ key: string; id: string } | null>(null);
  const editable = props.complete && !props.readOnly;
  const persistRef = useRef<() => Promise<number>>(async () => revision.current);

  function persist(state = structuredClone(store.getSnapshot()) as UIState): Promise<number> {
    const task = chain.current.then(async () => {
      if (!editable || !props.agentId || !props.sessionId) return revision.current;
      validateStateForSpec(state, spec);
      const encoded = JSON.stringify(state);
      if (encoded === saved.current) { dirty.current = false; return revision.current; }
      const result = await saveGeneratedUIState(props.agentId, props.sessionId, { messageId: props.messageId, blockIndex: props.blockIndex, catalogVersion: UI_CATALOG_VERSION, contentHash, expectedRevision: revision.current, state });
      revision.current = result.revision;
      saved.current = encoded;
      dirty.current = JSON.stringify(store.getSnapshot()) !== encoded;
      if (alive.current) setError("");
      return result.revision;
    });
    chain.current = task.then(() => {}, () => {});
    return task;
  }
  persistRef.current = persist;

  useEffect(() => {
    alive.current = true;
    const unsubscribe = store.subscribe(() => {
      if (applying.current || !editable) return;
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { void persistRef.current().catch((err) => { if (alive.current) setError(err instanceof Error ? `尚未保存：${err.message}` : "尚未保存，请重试"); }); }, 700);
    });
    return () => { alive.current = false; unsubscribe(); if (timer.current) clearTimeout(timer.current); if (dirty.current) void persistRef.current().catch(() => {}); };
  }, [store, editable]);

  useEffect(() => {
    if (!validSnapshot || validSnapshot.revision <= revision.current) return;
    if (JSON.stringify(validSnapshot.state) === JSON.stringify(store.getSnapshot())) {
      revision.current = validSnapshot.revision; saved.current = JSON.stringify(validSnapshot.state); dirty.current = false; return;
    }
    if (dirty.current) { setError("其他设备已修改此表单。当前输入已保留，请恢复已保存状态后再提交。"); return; }
    try {
      validateStateForSpec(validSnapshot.state, spec);
      applying.current = true;
      store.update(Object.fromEntries(Object.entries(validSnapshot.state).map(([key, value]) => [`/${key}`, value])));
      revision.current = validSnapshot.revision;
      saved.current = JSON.stringify(validSnapshot.state);
    } catch { setError("保存的表单状态无效，请让助手重新生成界面。"); }
    finally { applying.current = false; }
  }, [validSnapshot, store, spec]);

  async function continueConversation(params: Record<string, unknown>) {
    if (!editable || !props.canSubmit || !props.onContinue || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (timer.current) clearTimeout(timer.current);
      const state = structuredClone(store.getSnapshot()) as UIState;
      const rev = await persist(state);
      const message = String(params.message);
      const key = JSON.stringify([message, state, rev]);
      if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
      await props.onContinue(message, state, { messageId: props.messageId, blockIndex: props.blockIndex, contentHash, revision: rev, submissionId: submission.current.id, runId: props.runId });
      if (alive.current) setError("");
    } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : "提交失败，输入已保留"); }
    finally { pendingRef.current = false; if (alive.current) setPending(false); }
  }

  return <div className="min-w-0 space-y-2" onBlurCapture={() => { if (dirty.current) void persist().catch((err) => setError(err instanceof Error ? `尚未保存：${err.message}` : "尚未保存")); }}>
    <UIInteractionContext.Provider value={{ editable: editable && !pending, canSubmit: props.canSubmit, pending }}>
      <JSONUIProvider registry={uiRegistry} store={store} functions={uiFunctions} handlers={{ continueConversation }}>
        <Renderer spec={spec} registry={uiRegistry} loading={!props.complete} />
      </JSONUIProvider>
    </UIInteractionContext.Provider>
    {error && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => void persist().catch((err) => setError(String(err)))}>重试保存</Button>{validSnapshot && <Button size="sm" variant="ghost" onClick={() => {
      applying.current = true;
      store.update(Object.fromEntries(Object.entries(validSnapshot.state).map(([key, value]) => [`/${key}`, value])));
      applying.current = false; revision.current = validSnapshot.revision; saved.current = JSON.stringify(validSnapshot.state); dirty.current = false; setError("");
    }}>恢复已保存状态</Button>}</div>}
  </div>;
}

function UIBlock(props: BlockProps) {
  const compiler = useRef<ReturnType<typeof createUICompiler> | null>(null);
  if (!compiler.current) compiler.current = createUICompiler();
  const result = useMemo(() => compiler.current!.update(props.content, props.complete), [props.content, props.complete]);
  const [hash, setHash] = useState("");
  const [hashError, setHashError] = useState(false);
  useEffect(() => {
    let active = true;
    setHash("");
    setHashError(false);
    if (props.complete && !props.unclosed && result.spec) void uiContentHash(props.content).then((value) => { if (active) setHash(value); }, () => { if (active) setHashError(true); });
    return () => { active = false; };
  }, [props.content, props.complete, props.unclosed, Boolean(result.spec)]);
  const finalError = props.unclosed ? "界面内容未完整生成" : hashError ? "无法校验此界面，请刷新重试" : result.error;
  if (finalError && props.complete) return <div className="my-2 space-y-2 text-sm text-muted-foreground"><p role="alert">{finalError}。可以让助手重新生成界面。</p><details><summary className="cursor-pointer text-xs">查看内容</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-2 text-xs">{props.content}</pre></details></div>;
  if (!result.spec) return <p role="status" className="my-2 text-sm text-muted-foreground">正在生成界面…</p>;
  if (props.complete && !hash) return <p role="status" className="text-sm text-muted-foreground">正在准备界面…</p>;
  const complete = props.complete && Boolean(hash);
  return <UIErrorBoundary key={hash || "preview"}><InteractiveUI key={hash || `preview-${JSON.stringify(result.spec.state)}`} {...props} complete={complete} contentHash={hash} spec={result.spec} /></UIErrorBoundary>;
}

export function GeneratedUIContent({ content, final, snapshots, ...props }: Omit<BlockProps, "content" | "complete" | "blockIndex" | "snapshot"> & { content: string; final: boolean; snapshots?: Record<number, UISnapshot> }) {
  const parts = useMemo(() => splitUIContent(content), [content]);
  return <div className="w-full min-w-0 space-y-2">{parts.map((part, index) => part.kind === "text" ? <ChatMarkdown key={`text-${index}`} content={part.content} final={final || index < parts.length - 1} fade={false} /> : <UIBlock key={`ui-${part.blockIndex}`} {...props} content={part.content} complete={final} unclosed={final && !part.closed} blockIndex={part.blockIndex} snapshot={snapshots?.[part.blockIndex]} />)}</div>;
}
