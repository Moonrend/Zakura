"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  friendlyError,
  getRuns,
  getMerges,
  type MergePreview,
  type Project,
  type Run,
} from "@/lib/project-execution";
import {
  abortDeliveryImport,
  beginDeliveryImport,
  browserDeliveryLimit,
  createDelivery,
  deliveryChannels,
  downloadDelivery,
  finishDeliveryImport,
  getDeliveryRecord,
  inspectDelivery,
  listDeliveries,
  prepareDeliveryFile,
  promoteDelivery,
  revokeDelivery,
  startImportedRun,
  uploadDeliveryFile,
  type Delivery,
  type DeliveryChannel,
} from "@/lib/project-delivery";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";

function Size({ value }: { value?: number }) {
  return (
    <span>
      {value === undefined ? "未知" : `${(value / 1024 / 1024).toFixed(2)} MiB`}
    </span>
  );
}
export function DeliveryPanel({ project }: { project: Project }) {
  return <DeliveryWorkbench key={project.id} project={project} />;
}
function DeliveryWorkbench({ project }: { project: Project }) {
  const me = useMeOptional();
  const writable = ["owner", "admin", "member"].includes(me?.role ?? "");
  const human = Boolean(me?.user?.id && writable);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [imports, setImports] = useState<Delivery[]>([]);
  const [channels, setChannels] = useState<DeliveryChannel[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [merges, setMerges] = useState<MergePreview[]>([]);
  const [mergeId, setMergeId] = useState("");
  const [name, setName] = useState(project.name);
  const [version, setVersion] = useState("1.0.0");
  const [comment, setComment] = useState("");
  const [channel, setChannel] = useState("stable");
  const [selected, setSelected] = useState<Delivery | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [resumeId, setResumeId] = useState("");
  const [progress, setProgress] = useState<Delivery | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    kind: "promote" | "revoke" | "abort";
    delivery: Delivery;
    channel?: string;
    previous?: DeliveryChannel;
    comment: string;
  } | null>(null);
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const [startedRun, setStartedRun] = useState<{
    deliveryId: string;
    runId: string;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mergeRequest = useRef(0);
  const mounted = useRef(true);
  const currentProject = useRef(project.id);
  currentProject.current = project.id;
  const refresh = useCallback(async () => {
    const [published, incoming, releases, executions] = await Promise.all([
      listDeliveries(project.id, "delivery"),
      listDeliveries(project.id, "import"),
      deliveryChannels(project.id),
      getRuns(project.id),
    ]);
    if (!mounted.current || currentProject.current !== project.id) return;
    setDeliveries(published.items);
    setImports(incoming.items);
    setChannels(releases.items);
    setRuns(executions.items);
    setTruncated(published.truncated || incoming.truncated);
  }, [project.id]);
  const rememberResume = (id: string) => {
    if (id) localStorage.setItem(`zakura_delivery_resume_${project.id}`, id);
    else localStorage.removeItem(`zakura_delivery_resume_${project.id}`);
    setResumeId(id);
  };
  const forgetResume = (id: string) => {
    if (localStorage.getItem(`zakura_delivery_resume_${project.id}`) === id)
      localStorage.removeItem(`zakura_delivery_resume_${project.id}`);
    if (resumeId === id) setResumeId("");
    if (progress?.id === id) setProgress(null);
  };
  const requestAction = (
    kind: "promote" | "revoke" | "abort",
    delivery: Delivery,
  ) => {
    setPendingAction({
      kind,
      delivery,
      ...(kind === "promote"
        ? {
            channel,
            previous: channels.find((item) => item.channel === channel),
          }
        : {}),
      comment,
    });
    setActionConfirmed(false);
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => setError(friendlyError(e)));
    setResumeId(
      localStorage.getItem(`zakura_delivery_resume_${project.id}`) ?? "",
    );
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [project.id, refresh]);
  useEffect(() => {
    const request = ++mergeRequest.current;
    setMerges([]);
    setMergeId("");
    if (!runId) return;
    void getMerges(project.id, runId)
      .then((result) => {
        if (request === mergeRequest.current && mounted.current)
          setMerges(
            result.items.filter((m) =>
              ["approved", "applied"].includes(m.status),
            ),
          );
      })
      .catch((e) => {
        if (request === mergeRequest.current) setError(friendlyError(e));
      });
  }, [project.id, runId]);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (mounted.current) setError(friendlyError(e));
    } finally {
      if (mounted.current) setBusy("");
    }
  };
  const upload = async () => {
    if (!file || busy) return;
    const nextController = new AbortController();
    controller.current = nextController;
    setBusy("upload");
    setError(null);
    setNotice("计算文件 SHA-256…");
    try {
      const identity = await prepareDeliveryFile(file);
      nextController.signal.throwIfAborted();
      let transfer: Delivery;
      if (resumeId) {
        const previous =
          imports.find((d) => d.id === resumeId) ??
          (await getDeliveryRecord(project.id, resumeId, "import"));
        transfer = previous;
      } else {
        transfer = await beginDeliveryImport(
          project.id,
          identity,
          nextController.signal,
        );
        rememberResume(transfer.id);
      }
      const final = await uploadDeliveryFile(
        project.id,
        transfer,
        file,
        identity.sha256,
        (value) => {
          if (mounted.current) {
            setProgress(value);
            setNotice("分块字节已同步；可随时暂停并恢复。");
          }
        },
        nextController.signal,
      );
      if (mounted.current) {
        setProgress(final);
        setNotice(
          "所有字节已上传。请点击校验并导入。导入包的审核声明不会被本项目继承。",
        );
      }
    } catch (e) {
      if (mounted.current) {
        if (nextController.signal.aborted)
          setNotice("传输已暂停；点击核对回执，再选择同一文件恢复。");
        else setError(friendlyError(e));
      }
    } finally {
      if (mounted.current) {
        setBusy("");
        await refresh().catch((e) => setError(friendlyError(e)));
      }
    }
  };
  return (
    <div className="space-y-5">
      <ErrorNotice message={error} />
      {notice && (
        <p role="status" className="rounded-lg bg-muted p-3 text-sm">
          {notice}
        </p>
      )}
      {truncated && (
        <p className="text-sm text-amber-700">
          列表超过 200 项，当前显示最近记录；完整记录仍可按 ID 从 API 读取。
        </p>
      )}
      {pendingAction && (
        <Panel
          title="确认精确交付操作"
          description={`${pendingAction.kind === "promote" ? "切换发布渠道" : pendingAction.kind === "revoke" ? "撤销交付版本" : "放弃导入传输"} · ${pendingAction.delivery.id} · r${pendingAction.delivery.revision}`}
        >
          <div className="space-y-3">
            {pendingAction.channel && (
              <p className="text-sm">
                渠道 {pendingAction.channel} · 当前修订{" "}
                {pendingAction.previous?.revision ?? 0} →{" "}
                {pendingAction.delivery.name} {pendingAction.delivery.version}
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {pendingAction.kind === "abort"
                ? "停止并放弃此传输的暂存数据。此操作不会修改原工作区。"
                : pendingAction.comment}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={actionConfirmed}
                onChange={(e) => setActionConfirmed(e.target.checked)}
              />
              确认对上述目标执行操作
            </label>
            <div className="flex gap-2">
              <Button
                variant={
                  pendingAction.kind === "promote" ? "default" : "destructive"
                }
                disabled={
                  !!busy ||
                  !actionConfirmed ||
                  (pendingAction.kind === "abort" ? !writable : !human)
                }
                onClick={() =>
                  void act(pendingAction.kind, async () => {
                    const action = pendingAction;
                    if (action.kind === "promote") {
                      await promoteDelivery(
                        project.id,
                        action.delivery,
                        action.channel!,
                        action.previous,
                        action.comment,
                      );
                      setNotice(`渠道 ${action.channel} 已更新。`);
                    } else if (action.kind === "revoke")
                      setSelected(
                        await revokeDelivery(
                          project.id,
                          action.delivery,
                          action.comment,
                        ),
                      );
                    else {
                      const result = await abortDeliveryImport(
                        project.id,
                        action.delivery,
                      );
                      if (result.status === "aborted")
                        forgetResume(action.delivery.id);
                      else setNotice("放弃传输的结果尚未确认，请先核对回执。");
                    }
                    setPendingAction(null);
                    setActionConfirmed(false);
                  })
                }
              >
                确认执行
              </Button>
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => setPendingAction(null)}
              >
                返回
              </Button>
            </div>
          </div>
        </Panel>
      )}
      <Panel
        title="创建已审核交付包"
        description="封存最终合并快照、验收证据和人工审核出处，供下载、迁移和后续项目使用。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="已完成运行">
            <NativeSelect
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              disabled={!!busy}
            >
              <option value="">选择运行</option>
              {runs
                .filter((r) => r.status === "completed")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 14)} ·{" "}
                    {new Date(r.createdAt).toLocaleString()}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="已审核合并预览">
            <NativeSelect
              value={mergeId}
              onChange={(e) => setMergeId(e.target.value)}
              disabled={!!busy}
            >
              <option value="">选择不可变成果</option>
              {merges.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id.slice(0, 12)} · {m.status} ·{" "}
                  {m.plan.result.id.slice(0, 12)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="交付名称">
            <Input
              value={name}
              disabled={!!busy}
              maxLength={256}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="版本标签">
            <Input
              value={version}
              disabled={!!busy}
              maxLength={128}
              onChange={(e) => setVersion(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="发布、渠道或撤销操作说明">
            <Textarea
              value={comment}
              disabled={!!busy}
              maxLength={4096}
              onChange={(e) => setComment(e.target.value)}
              placeholder="说明此次交付满足哪些目标，或为何调整发布渠道。"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={!human || !!busy || !mergeId || !comment.trim()}
            onClick={() =>
              void act("create", async () => {
                const preview = merges.find((m) => m.id === mergeId);
                if (!preview) throw new Error("请重新选择审核预览。");
                const d = await createDelivery(
                  project.id,
                  preview,
                  name,
                  version,
                  comment,
                );
                setSelected(d);
                setNotice(
                  d.status === "ready"
                    ? "交付包已封存。"
                    : "交付意图已记录，请核对回执确认实际状态。",
                );
              })
            }
          >
            封存交付包
          </Button>
          <Button
            variant="outline"
            disabled={!!busy}
            onClick={() => void act("refresh", refresh)}
          >
            刷新
          </Button>
        </div>
      </Panel>
      <Panel
        title="交付版本与渠道"
        description="SHA-256 校验内容完整性；包中的审核元数据不具有数字签名。"
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="发布渠道">
            <Input
              value={channel}
              disabled={!!busy}
              maxLength={48}
              onChange={(e) => setChannel(e.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            渠道修改使用修订号比较，可保留旧版本或切换到另一已审核版本。
          </p>
        </div>
        {channels.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {channels.map((c) => (
              <span
                key={c.channel}
                className="rounded border px-2 py-1 text-xs"
              >
                {c.channel} →{" "}
                {deliveries.find((d) => d.id === c.deliveryId)?.version ??
                  c.deliveryId.slice(0, 12)}{" "}
                · 修订 {c.revision}
              </span>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {deliveries.map((d) => (
            <article key={d.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <strong>
                    {d.name} · {d.version}
                  </strong>{" "}
                  <Status value={d.status} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {d.id} · <Size value={d.archive?.bytes} /> ·{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelected(d)}
                  >
                    证据
                  </Button>
                  {["preparing", "unknown"].includes(d.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!writable || !!busy}
                      onClick={() =>
                        void act("inspect", async () =>
                          setSelected(await inspectDelivery(project.id, d)),
                        )
                      }
                    >
                      核对回执
                    </Button>
                  )}
                  {d.status === "ready" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void act("download", () =>
                            downloadDelivery(project.id, d),
                          )
                        }
                      >
                        校验后下载
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          !human ||
                          !!busy ||
                          !comment.trim() ||
                          !/^[a-z][a-z0-9_-]{0,47}$/.test(channel)
                        }
                        onClick={() => requestAction("promote", d)}
                      >
                        设为 {channel}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !human ||
                          !!busy ||
                          !comment.trim() ||
                          channels.some((c) => c.deliveryId === d.id)
                        }
                        onClick={() => requestAction("revoke", d)}
                      >
                        撤销
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {d.error && (
                <p className="mt-2 break-all text-xs text-destructive">
                  {d.error}
                </p>
              )}
            </article>
          ))}
          {deliveries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              暂无交付包。先在合并工作台审核成果，再封存版本。
            </p>
          )}
        </div>
      </Panel>
      {selected && (
        <Panel
          title="不可变交付证据"
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelected(null)}
            >
              关闭
            </Button>
          }
        >
          <p className="mb-3 text-sm">
            快照 {selected.snapshotId ?? selected.manifest?.snapshotId} ·
            审核引用 {selected.manifest?.review.id ?? "尚无"}
          </p>
          {selected.archive && (
            <div className="mb-3 space-y-1 break-all text-xs">
              <p>整个包 SHA-256：{selected.archive.sha256}</p>
              <p>清单哈希：{selected.archive.manifestHash}</p>
              <p>
                工作区内容 SHA-256：{selected.archive.manifest.payloadSha256}
              </p>
            </div>
          )}
          <Code value={selected.manifest ?? selected} limit={40000} />
        </Panel>
      )}
      <Panel
        title="校验、导入与继续执行"
        description="导入只创建隔离快照。后续运行采用当前项目的计划、检查与预算，需要重新验收和审核。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={`交付文件（浏览器上限 ${browserDeliveryLimit / 1024 / 1024} MiB）`}
          >
            <Input
              type="file"
              accept=".tar,application/x-tar"
              disabled={!!busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setProgress(null);
              }}
            />
          </Field>
          <Field label="继续已有传输">
            <NativeSelect
              value={resumeId}
              disabled={!!busy}
              onChange={(e) => {
                rememberResume(e.target.value);
                setProgress(null);
              }}
            >
              <option value="">创建新传输</option>
              {resumeId && !imports.some((d) => d.id === resumeId) && (
                <option value={resumeId}>恢复已保存传输 {resumeId}</option>
              )}
              {imports
                .filter((d) =>
                  ["preparing", "uploading", "unknown"].includes(d.status),
                )
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.comment} · {d.id.slice(0, 12)} · {d.status}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={!writable || !file || !!busy}
            onClick={() => void upload()}
          >
            {resumeId ? "校验同一文件并恢复" : "开始分块上传"}
          </Button>
          {busy === "upload" && (
            <Button
              variant="outline"
              onClick={() => controller.current?.abort()}
            >
              暂停传输
            </Button>
          )}
        </div>
        {progress && (
          <div className="mt-3 space-y-1 text-xs">
            <progress
              className="w-full"
              value={progress.received ?? 0}
              max={progress.totalBytes ?? 1}
              aria-label="已同步字节进度"
            />
            <p>
              <Size value={progress.received} /> /{" "}
              <Size value={progress.totalBytes} /> · {progress.id}
            </p>
          </div>
        )}
        <div className="mt-4 space-y-3">
          {imports.map((d) => (
            <article key={d.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <strong className="text-sm">{d.comment}</strong>{" "}
                  <Status value={d.status} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {d.id} · <Size value={d.received} /> /{" "}
                    <Size value={d.totalBytes} />
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!writable || !!busy}
                    onClick={() =>
                      void act("inspect", async () =>
                        setSelected(await inspectDelivery(project.id, d)),
                      )
                    }
                  >
                    核对回执
                  </Button>
                  {d.status === "uploading" && d.received === d.totalBytes && (
                    <Button
                      size="sm"
                      disabled={!writable || !!busy}
                      onClick={() =>
                        void act("finish", async () => {
                          const imported = await finishDeliveryImport(
                            project.id,
                            d,
                          );
                          setSelected(imported);
                          if (imported.status === "completed") {
                            forgetResume(d.id);
                            setNotice(
                              "包与全部文件已验证；审核记录仅作为外部出处保留。",
                            );
                          }
                        })
                      }
                    >
                      校验并导入
                    </Button>
                  )}
                  {d.status === "completed" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelected(d)}
                      >
                        清单
                      </Button>
                      <Button
                        size="sm"
                        disabled={!human || !!busy}
                        onClick={() =>
                          void act("run", async () => {
                            const run = await startImportedRun(
                              project.id,
                              d,
                              project.revision,
                            );
                            setStartedRun({ deliveryId: d.id, runId: run.id });
                            setNotice(
                              `已从导入快照创建新运行 ${run.id}。请在执行面板查看任务与重新审核。`,
                            );
                          })
                        }
                      >
                        用当前计划重新执行
                      </Button>
                      <Link
                        className="self-center text-xs text-primary underline"
                        href={`/dashboard/project-executions/${encodeURIComponent(project.id)}?tab=execution${startedRun?.deliveryId === d.id ? `&runId=${encodeURIComponent(startedRun.runId)}` : ""}`}
                      >
                        执行面板
                      </Link>
                    </>
                  )}
                  {["preparing", "uploading", "unknown"].includes(d.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!writable || !!busy}
                      onClick={() => requestAction("abort", d)}
                    >
                      放弃传输
                    </Button>
                  )}
                </div>
              </div>
              {d.untrustedReview && d.status === "completed" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  外部审核声明不会授予本项目审批，也不会发布到原工作区。
                </p>
              )}
              {d.error && (
                <p className="mt-2 break-all text-xs text-destructive">
                  {d.error}
                </p>
              )}
            </article>
          ))}
          {imports.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无导入记录。</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
