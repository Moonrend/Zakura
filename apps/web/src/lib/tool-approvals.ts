import type { CloudAgentEvent } from "@zakura/shared";
import { eventsToTimeline, type TimelineItem } from "./cloud-agent";

export type PendingToolApproval = Extract<TimelineItem, { kind: "tool_approval" }>;

export function pendingToolApprovals(events: CloudAgentEvent[], now = Date.now()): PendingToolApproval[] {
  const resolved = new Set<string>();
  const endedRuns = new Set<string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "tool_approval_resolved" && typeof payload.requestId === "string") resolved.add(payload.requestId);
    if (event.type === "run_end" && event.runId) endedRuns.add(event.runId);
  }
  const requests = events.filter(event => {
    const payload = event.payload as Record<string, unknown>;
    return event.type === "tool_approval_request"
      && !resolved.has(String(payload.requestId ?? event.id))
      && !(event.runId && endedRuns.has(event.runId))
      && payload.reason !== "ai_decision" && payload.reason !== "ai_auto";
  });
  return eventsToTimeline(requests).filter((item): item is PendingToolApproval => item.kind === "tool_approval"
    && !item.resolved && (!item.expiresAt || Date.parse(item.expiresAt) > now));
}
