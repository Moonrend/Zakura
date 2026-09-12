"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type UpstreamAuthSnap = {
  loggedIn: boolean;
  email?: string;
  expiresAt?: number;
  accountId?: string;
  loginKind?: string;
};

type AuthKind = "device" | "pkce" | "sdk" | "paste";

type LoginSnap = {
  loginId: string;
  kind: AuthKind;
  status: "pending" | "complete" | "error" | "cancelled";
  userCode?: string;
  verificationUrl?: string;
  interval?: number;
  expiresIn?: number;
  hint?: string;
  error?: string;
};

type Props = {
  upstreamId: string;
  authKind?: AuthKind;
  auth?: UpstreamAuthSnap;
  onChanged?: () => void;
};

function formatExpiry(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

export function UpstreamAuthPanel({ upstreamId, authKind, auth, onChanged }: Props) {
  const [snap, setSnap] = useState<LoginSnap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    if (!snap || snap.status !== "pending" || error) return;
    if (snap.kind === "pkce" || snap.kind === "paste") return;
    const t = window.setTimeout(() => {
      void api<LoginSnap>(`/api/model-upstreams/${upstreamId}/auth/poll`, {
        method: "POST",
        json: { loginId: snap.loginId },
        cacheTtlMs: false,
      })
        .then((next) => {
          setError(null);
          setSnap(next);
          if (next.status === "complete") onChangedRef.current?.();
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    }, Math.max(2, snap.interval || 5) * 1000);
    return () => window.clearTimeout(t);
  }, [upstreamId, snap, error]);

  async function start() {
    setBusy(true);
    setError(null);
    setPaste("");
    try {
      const next = await api<LoginSnap>(`/api/model-upstreams/${upstreamId}/auth/start`, {
        method: "POST",
      });
      setSnap(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (snap?.status === "pending") {
      await api(`/api/model-upstreams/${upstreamId}/auth/cancel`, {
        method: "POST",
        json: { loginId: snap.loginId },
      }).catch(() => undefined);
    }
    setSnap(null);
    setError(null);
    setPaste("");
  }

  async function submit(body: { code?: string; setupToken?: string; credentialsJson?: string }) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<LoginSnap>(`/api/model-upstreams/${upstreamId}/auth/submit`, {
        method: "POST",
        json: { loginId: snap?.loginId, ...body },
      });
      setSnap(next);
      if (next.status === "complete") {
        setPaste("");
        setSetupToken("");
        onChanged?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await api(`/api/model-upstreams/${upstreamId}/auth/logout`, { method: "POST" });
      setSnap(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (auth?.loggedIn && (!snap || snap.status === "complete")) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium">订阅登录</p>
        <p className="text-xs text-muted-foreground">
          {auth.email ? `${auth.email} · ` : ""}
          {auth.expiresAt ? `凭证约至 ${formatExpiry(auth.expiresAt)}` : "已登录"}
        </p>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void logout()}>
          退出登录
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">订阅登录</p>
      {authKind === "pkce" ? (
        <p className="text-xs text-muted-foreground">
          Anthropic 可能拒绝第三方使用消费级 OAuth。失败时请改用 API Key，或粘贴{" "}
          <code>claude setup-token</code>。
        </p>
      ) : null}
      {authKind === "paste" ? (
        <p className="text-xs text-muted-foreground">
          本机执行 <code>gemini</code> 登录后，粘贴{" "}
          <code>~/.gemini/oauth_creds.json</code>。
        </p>
      ) : null}

      {snap ? (
        <>
          {snap.verificationUrl ? (
            <p className="text-xs text-muted-foreground">
              打开{" "}
              <a href={snap.verificationUrl} target="_blank" rel="noreferrer" className="underline">
                {snap.verificationUrl}
              </a>
              {snap.userCode ? (
                <>
                  ，输入代码 <span className="font-mono text-foreground">{snap.userCode}</span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{snap.hint ?? "正在准备登录…"}</p>
          )}
          {snap.kind === "pkce" ? (
            <div className="space-y-1">
              <Label>授权码</Label>
              <Input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="粘贴地址栏里的 code#state 或完整 URL"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !paste.trim()}
                onClick={() => void submit({ code: paste })}
              >
                提交授权码
              </Button>
            </div>
          ) : null}
          {snap.kind === "paste" ? (
            <div className="space-y-1">
              <Label>oauth_creds.json</Label>
              <Textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder='{"access_token":"...","refresh_token":"..."}'
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !paste.trim()}
                onClick={() => void submit({ credentialsJson: paste })}
              >
                提交凭据
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {error
              ? `失败：${error}`
              : snap.status === "pending"
                ? snap.kind === "pkce" || snap.kind === "paste"
                  ? snap.hint ?? "授权后把内容粘贴回来"
                  : `等待确认…${snap.expiresIn ? `（约 ${Math.round(snap.expiresIn / 60)} 分钟内有效）` : ""}`
                : snap.status === "complete"
                  ? "登录完成"
                  : snap.error || snap.status}
          </p>
          <div className="flex gap-2">
            {error && snap.status === "pending" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setError(null)}>
                重试轮询
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => void cancel()}>
              取消
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {authKind === "pkce" ? (
            <div className="space-y-1">
              <Label>setup-token（备选）</Label>
              <Input
                type="password"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="粘贴 claude setup-token 的输出"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !setupToken.trim()}
                onClick={() => void submit({ setupToken })}
              >
                使用 setup-token
              </Button>
            </div>
          ) : null}
          {authKind === "paste" ? (
            <div className="space-y-1">
              <Label>oauth_creds.json</Label>
              <Textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder='{"access_token":"...","refresh_token":"..."}'
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !paste.trim()}
                onClick={() => void submit({ credentialsJson: paste })}
              >
                提交凭据
              </Button>
            </div>
          ) : null}
          {authKind !== "paste" ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void start()}>
              {authKind === "sdk" ? "打开 Cursor 登录" : "开始登录"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
