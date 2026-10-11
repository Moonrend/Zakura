"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  confirmSourceQuiescence,
  friendlyError,
  getSourceActivities,
  getSourceAttestations,
  inspectSourceAttestation,
  type SourceActivity,
  type SourceAttestation,
} from "@/lib/project-execution";
import { Code, ErrorNotice, Field, Panel, Status } from "./shared";

export function SourceActivityPanel({ projectId }: { projectId: string }) {
  const me = useMeOptional();
  const operator = Boolean(
    me?.user?.id && (me.role === "owner" || me.role === "admin"),
  );
  const [activities, setActivities] = useState<SourceActivity[] | null>(null);
  const [attestations, setAttestations] = useState<SourceAttestation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [comment, setComment] = useState("");
  const [recheckKey, setRecheckKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const commentTooLong = new TextEncoder().encode(comment).length > 4096;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const reload = useCallback(async () => {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const result = await getSourceActivities(projectId);
      if (current !== generation.current) return;
      if (!Array.isArray(result.activities)) {
        throw new Error("节点未返回有效的写入活动清单，请刷新后再操作。");
      }
      setActivities(result.activities);
      setError(null);
      if (operator) {
        try {
          const history = await getSourceAttestations(projectId);
          if (current !== generation.current) return;
          setAttestations(history.items ?? []);
          setHistoryError(null);
        } catch (error) {
          if (current === generation.current) {
            setHistoryError(friendlyError(error));
          }
        }
      }
    } catch (error) {
      if (current === generation.current) {
        setActivities(null);
        setError(friendlyError(error));
      }
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [projectId, operator]);

  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setActivities(null);
    setAttestations([]);
    setConfirmed(false);
    setComment("");
    setRecheckKey(null);
    void reload();
    const timer = window.setInterval(() => void reload(), 10000);
    return () => {
      generation.current++;
      inFlight.current = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  const orphanedIds = (activities ?? [])
    .filter((activity) => activity.status === "orphaned")
    .map((activity) => activity.id)
    .sort();
  const activityKey = JSON.stringify(activities ?? null);
  useEffect(() => setConfirmed(false), [activityKey]);
  const live = (activities ?? []).some(
    (activity) => activity.status === "current" || activity.runtimeLive,
  );
  const global = (activities ?? []).some((activity) => !activity.spaceId);
  const unresolved = attestations.some((attestation) =>
    ["pending", "unknown"].includes(attestation.status),
  );
  const orphanedKey = JSON.stringify(orphanedIds);
  const canRecheck =
    operator &&
    activities !== null &&
    orphanedIds.length > 0 &&
    !live &&
    !global &&
    !historyError;
  const canConfirm = canRecheck && (!unresolved || recheckKey === orphanedKey);

  const beginRecheck = async () => {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    setComment("");
    setRecheckKey(null);
    try {
      const latest = await getSourceActivities(projectId);
      if (!Array.isArray(latest.activities)) {
        throw new Error("无法读取完整写入活动清单，尚未开始重新核对。");
      }
      setActivities(latest.activities);
      if (
        latest.activities.some(
          (activity) =>
            !activity.spaceId ||
            activity.runtimeLive ||
            activity.status === "current",
        )
      ) {
        throw new Error(
          "存在仍在运行或覆盖多个空间的写入活动，请先由节点管理员处理。",
        );
      }
      const ids = latest.activities
        .filter((activity) => activity.status === "orphaned")
        .map((activity) => activity.id)
        .sort();
      if (ids.length) setRecheckKey(JSON.stringify(ids));
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canConfirm || !confirmed || !comment.trim() || commentTooLong) return;
    setBusy(true);
    setError(null);
    try {
      const latest = await getSourceActivities(projectId);
      if (!Array.isArray(latest.activities)) {
        throw new Error("无法读取完整写入活动清单，尚未提交确认。");
      }
      const latestIds = latest.activities
        .filter((activity) => activity.status === "orphaned")
        .map((activity) => activity.id)
        .sort();
      if (
        JSON.stringify(latestIds) !== JSON.stringify(orphanedIds) ||
        latest.activities.some(
          (activity) =>
            !activity.spaceId ||
            activity.runtimeLive ||
            activity.status === "current",
        )
      ) {
        setActivities(latest.activities);
        setConfirmed(false);
        throw new Error("写入活动已变化。请核对更新后的完整清单并重新确认。");
      }
      const result = await confirmSourceQuiescence(
        projectId,
        orphanedIds,
        comment.trim(),
      );
      setAttestations((previous) => [
        result,
        ...previous.filter((item) => item.id !== result.id),
      ]);
      setConfirmed(false);
      setComment("");
      setRecheckKey(null);
      await reload();
    } catch (error) {
      setConfirmed(false);
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await inspectSourceAttestation(projectId, id);
      setAttestations((previous) =>
        previous.map((item) =>
          item.id === id
            ? {
                ...item,
                status: result.status,
                result: result.inspection?.result ?? item.result,
                error: result.inspection?.error,
              }
            : item,
        ),
      );
      await reload();
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="工作区写入活动与节点恢复"
      description="创建基线和发布合并产物前，需要确认源工作区没有仍在写入的旧进程。"
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={loading || busy}
          onClick={() => void reload()}
        >
          <RefreshCw />
          刷新写入活动
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <ErrorNotice message={error} />
        {activities === null && !error && <p>正在读取节点写入活动…</p>}
        {activities?.length === 0 && (
          <p className="text-muted-foreground">
            当前没有源工作区写入活动。可以开始新一轮或继续合并审核；操作时仍会复查节点状态。
          </p>
        )}
        {live && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            节点仍有正在运行的写入任务。请等待旧任务结束，或由节点管理员停止相应进程，再刷新清单。
          </p>
        )}
        {global && (
          <p className="rounded-lg border p-3">
            存在覆盖多个空间的节点写入活动。需要运行节点管理员在节点上处理，项目页面不能确认清除。
          </p>
        )}
        {Boolean(activities?.length) && (
          <div className="max-h-60 overflow-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">活动标识</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">开始时间</th>
                  <th className="p-2">最近记录</th>
                </tr>
              </thead>
              <tbody>
                {activities?.map((activity) => (
                  <tr key={activity.id} className="border-t">
                    <td className="max-w-72 break-all p-2 font-mono">
                      {activity.id}
                      {!activity.spaceId && <span> · 节点全局</span>}
                    </td>
                    <td className="p-2">
                      {activity.status === "current" || activity.runtimeLive
                        ? "正在运行"
                        : "重启前的未关闭记录"}
                    </td>
                    <td className="whitespace-nowrap p-2">
                      {new Date(activity.startedAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="whitespace-nowrap p-2">
                      {new Date(activity.updatedAt).toLocaleString("zh-CN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {orphanedIds.length > 0 && !live && !global && !operator && (
          <p className="text-muted-foreground">
            请联系团队所有者或管理员，在运行节点核对旧进程后使用本人登录会话确认。
          </p>
        )}
        <ErrorNotice message={historyError} />
        {unresolved && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-muted-foreground">
              旧确认的结果尚不明确，可检查原操作的持久记录。重新确认会读取最新清单，只处理当前仍未关闭的记录；旧确认及其未知状态会保留。
              {activities?.length === 0 &&
                " 当前清单为空，旧确认的未知状态不会阻止继续执行。"}
            </p>
            {canRecheck && recheckKey !== orphanedKey && (
              <Button
                variant="outline"
                disabled={busy || loading}
                onClick={() => void beginRecheck()}
              >
                重新核对当前仍未关闭的记录
              </Button>
            )}
          </div>
        )}
        {canConfirm && (
          <div className="space-y-3 rounded-lg border p-3">
            <p>
              节点重启后，未关闭记录不能证明进程已经停止。请在运行节点核对上面全部{" "}
              {orphanedIds.length} 条记录对应的进程，并记录核对依据。
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              已在运行节点确认所有旧写入进程已停止
            </label>
            <Field label="节点恢复核对说明">
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                disabled={busy}
                maxLength={4096}
                rows={3}
                placeholder="记录核对时间、停止或退出的进程，以及确认依据。"
              />
            </Field>
            {commentTooLong && (
              <p className="text-destructive">核对说明过长，请精简后提交。</p>
            )}
            <Button
              disabled={
                busy ||
                loading ||
                !confirmed ||
                !comment.trim() ||
                commentTooLong
              }
              onClick={() => void submit()}
            >
              {busy ? "正在记录确认…" : "确认全部旧写入已停止并清除记录"}
            </Button>
          </div>
        )}
        {operator && attestations.length > 0 && (
          <details>
            <summary className="cursor-pointer font-medium">
              节点恢复确认记录（{attestations.length}）
            </summary>
            <div className="mt-3 space-y-2">
              {attestations.map((attestation) => (
                <div
                  key={attestation.id}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Status value={attestation.status} />
                    <span className="break-all font-mono text-xs">
                      {attestation.id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(attestation.createdAt).toLocaleString("zh-CN")}
                    </span>
                    {["pending", "unknown"].includes(attestation.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void inspect(attestation.id)}
                      >
                        检查原确认操作
                      </Button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap">{attestation.comment}</p>
                  <ErrorNotice message={attestation.error ?? null} />
                  <details>
                    <summary className="cursor-pointer text-xs">
                      活动标识与节点记录
                    </summary>
                    <Code
                      value={{
                        activityIds: attestation.activityIds,
                        result: attestation.result,
                      }}
                    />
                  </details>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Panel>
  );
}
