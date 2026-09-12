import { isAgentSubscriptionProtocol } from "@zakura/shared";
import { UpstreamHttpError } from "./http.js";
import type { ResolvedRoute } from "./types.js";

export type RouteHydrator = (
  route: ResolvedRoute,
  opts?: { forceRefresh?: boolean },
) => Promise<ResolvedRoute>;

let hydrator: RouteHydrator | undefined;

export function setRouteHydrator(fn: RouteHydrator | undefined): void {
  hydrator = fn;
}

export async function hydrateRoute(
  route: ResolvedRoute,
  opts?: { forceRefresh?: boolean },
): Promise<ResolvedRoute> {
  if (!isAgentSubscriptionProtocol(route.upstream.protocol)) return route;
  if (!hydrator) {
    throw new Error("订阅上游未绑定登录运行时");
  }
  return hydrator(route, opts);
}

export function isUnauthorizedUpstream(err: unknown): boolean {
  return err instanceof UpstreamHttpError && err.status === 401;
}
