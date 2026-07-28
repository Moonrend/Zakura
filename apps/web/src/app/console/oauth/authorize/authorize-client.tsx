"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api, setSession } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

type AuthorizeInfo = {
  client: {
    clientId: string;
    clientName: string;
    registrationType: string;
  };
  redirectUri: string;
  scope: string;
  resource: string | null;
  agent: string | null;
  codeChallengeMethod: string;
};

type Me = {
  user: { id: string; email: string; name?: string | null };
  tenant: { name: string };
};

export default function OauthAuthorizePage() {
  const router = useRouter();
  const params = useSearchParams();
  const [info, setInfo] = useState<AuthorizeInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const query = useMemo(
    () => ({
      client_id: params.get("client_id") ?? "",
      redirect_uri: params.get("redirect_uri") ?? "",
      response_type: params.get("response_type") ?? "code",
      state: params.get("state") ?? "",
      code_challenge: params.get("code_challenge") ?? "",
      code_challenge_method: params.get("code_challenge_method") ?? "S256",
      scope: params.get("scope") ?? "mcp",
      resource: params.get("resource") ?? "",
      agent: params.get("agent") ?? "",
    }),
    [params],
  );

  useEffect(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v) qs.set(k, v);
    }
    void (async () => {
      try {
        const data = await api<AuthorizeInfo>(`/api/oauth/authorize-info?${qs}`);
        setInfo(data);
        setInfoError(null);
      } catch (err) {
        setInfoError(err instanceof Error ? err.message : String(err));
      }
      try {
        setMe(await api<Me>("/api/me"));
      } catch {
        setMe(null);
      }
    })();
  }, [query]);

  async function login() {
    setBusy(true);
    try {
      const res = await api<{ session: string }>("/api/auth/login", {
        method: "POST",
        json: { email, password },
      });
      setSession(res.session);
      setMe(await api<Me>("/api/me"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      const res = await api<{ redirect: string }>("/api/oauth/consent", {
        method: "POST",
        json: {
          client_id: query.client_id,
          redirect_uri: query.redirect_uri,
          code_challenge: query.code_challenge,
          code_challenge_method: query.code_challenge_method,
          scope: query.scope,
          resource: query.resource || null,
          agent: query.agent || null,
          state: query.state || undefined,
        },
      });
      window.location.href = res.redirect;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function deny() {
    try {
      const url = new URL(query.redirect_uri);
      url.searchParams.set("error", "access_denied");
      if (query.state) url.searchParams.set("state", query.state);
      // RFC 9207：错误响应也应带 iss
      if (typeof window !== "undefined") {
        url.searchParams.set("iss", window.location.origin);
      }
      window.location.href = url.toString();
    } catch {
      router.push("/dashboard/agents");
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-[400px] space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">授权接入 MCP</h1>
        </div>

        {infoError ? (
          <div className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
            {infoError}
          </div>
        ) : null}

        {info ? (
          <div className="space-y-2 rounded-md border px-3 py-3 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">客户端</span>
              <span className="font-medium">{info.client.clientName}</span>
              <Badge variant="secondary">{info.client.registrationType}</Badge>
            </div>
            <div>
              <div className="text-muted-foreground">回调</div>
              <code className="break-all text-[11px]">{info.redirectUri}</code>
            </div>
            <div className="flex flex-wrap gap-3 text-muted-foreground">
              <span>scope: {info.scope}</span>
              {info.agent ? <span>agent: {info.agent}</span> : null}
            </div>
            {info.resource ? (
              <div>
                <div className="text-muted-foreground">resource</div>
                <code className="break-all text-[11px]">{info.resource}</code>
              </div>
            ) : null}
          </div>
        ) : !infoError ? (
          <div className="text-xs text-muted-foreground">加载授权请求…</div>
        ) : null}

        {me ? (
          <div className="space-y-3">
            <div className="rounded-md border px-3 py-2 text-[12px]">
              已登录为 <span className="font-medium">{me.user.email}</span>
              <span className="text-muted-foreground"> · 团队 {me.tenant.name}</span>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy || !info} onClick={() => void approve()}>
                {busy ? "授权中…" : "批准接入"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={deny}>
                拒绝
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" disabled={busy || !info}>
                {busy ? "…" : "登录"}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={deny}>
                取消
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
