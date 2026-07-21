import type { McpToolDef } from "@zakura/shared";
import { googleFetch } from "./client.js";

type CalEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; displayName?: string }>;
  organizer?: { email?: string; displayName?: string };
  created?: string;
  updated?: string;
};

function mapEvent(e: CalEvent) {
  return {
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    status: e.status,
    htmlLink: e.htmlLink,
    hangoutLink: e.hangoutLink,
    start: e.start,
    end: e.end,
    attendees: e.attendees,
    organizer: e.organizer,
    created: e.created,
    updated: e.updated,
  };
}

export const calendarToolDefs: McpToolDef[] = [
  {
    name: "list_calendars",
    description: "Lists calendars on the user's calendar list.",
    inputSchema: {
      type: "object",
      properties: {
        pageToken: { type: "string" },
        pageSize: { type: "integer" },
      },
    },
  },
  {
    name: "list_events",
    description: "Lists events on a calendar. Default calendarId=primary.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        timeMin: { type: "string", description: "RFC3339" },
        timeMax: { type: "string", description: "RFC3339" },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
        query: { type: "string" },
        singleEvents: { type: "boolean" },
        orderBy: { type: "string", enum: ["startTime", "updated"] },
      },
    },
  },
  {
    name: "get_event",
    description: "Gets a single event.",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
      },
    },
  },
  {
    name: "create_event",
    description: "Creates a calendar event.",
    inputSchema: {
      type: "object",
      required: ["summary", "start", "end"],
      properties: {
        calendarId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "object" },
        end: { type: "object" },
        attendees: {
          type: "array",
          items: { type: "object", properties: { email: { type: "string" } } },
        },
      },
    },
  },
  {
    name: "update_event",
    description: "Updates an event (patch).",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "object" },
        end: { type: "object" },
        attendees: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "delete_event",
    description: "Deletes an event.",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
      },
    },
  },
  {
    name: "respond_to_event",
    description: "Sets the authenticated user's responseStatus on an event.",
    inputSchema: {
      type: "object",
      required: ["eventId", "responseStatus"],
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        responseStatus: {
          type: "string",
          enum: ["accepted", "declined", "tentative", "needsAction"],
        },
      },
    },
  },
  {
    name: "suggest_time",
    description:
      "Suggests free time slots using FreeBusy. durationMinutes default 30; within timeMin/timeMax.",
    inputSchema: {
      type: "object",
      required: ["timeMin", "timeMax"],
      properties: {
        calendarId: { type: "string" },
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        durationMinutes: { type: "integer" },
      },
    },
  },
];

export async function callCalendarTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const calendarId = encodeURIComponent(
    typeof args.calendarId === "string" && args.calendarId ? args.calendarId : "primary",
  );

  switch (name) {
    case "list_calendars": {
      const params = new URLSearchParams({
        maxResults: String(Math.min(Number(args.pageSize) || 50, 250)),
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      return googleFetch(
        token,
        `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
      );
    }
    case "list_events": {
      const params = new URLSearchParams({
        maxResults: String(Math.min(Number(args.pageSize) || 25, 250)),
        singleEvents: String(args.singleEvents !== false),
      });
      if (typeof args.timeMin === "string") params.set("timeMin", args.timeMin);
      if (typeof args.timeMax === "string") params.set("timeMax", args.timeMax);
      if (typeof args.query === "string" && args.query) params.set("q", args.query);
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      if (args.orderBy === "startTime" || args.orderBy === "updated") {
        params.set("orderBy", args.orderBy);
      } else if (args.singleEvents !== false) {
        params.set("orderBy", "startTime");
      }
      const res = await googleFetch<{ items?: CalEvent[]; nextPageToken?: string }>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
      );
      return {
        events: (res.items ?? []).map(mapEvent),
        nextPageToken: res.nextPageToken,
      };
    }
    case "get_event": {
      const eventId = String(args.eventId ?? "");
      if (!eventId) throw new Error("eventId required");
      const e = await googleFetch<CalEvent>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      );
      return mapEvent(e);
    }
    case "create_event": {
      const summary = String(args.summary ?? "");
      if (!summary || !args.start || !args.end) {
        throw new Error("summary, start, end required");
      }
      const body: Record<string, unknown> = {
        summary,
        start: args.start,
        end: args.end,
      };
      if (typeof args.description === "string") body.description = args.description;
      if (typeof args.location === "string") body.location = args.location;
      if (Array.isArray(args.attendees)) body.attendees = args.attendees;
      const e = await googleFetch<CalEvent>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
        { method: "POST", json: body },
      );
      return mapEvent(e);
    }
    case "update_event": {
      const eventId = String(args.eventId ?? "");
      if (!eventId) throw new Error("eventId required");
      const patch: Record<string, unknown> = {};
      for (const key of ["summary", "description", "location", "start", "end", "attendees"] as const) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      const e = await googleFetch<CalEvent>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", json: patch },
      );
      return mapEvent(e);
    }
    case "delete_event": {
      const eventId = String(args.eventId ?? "");
      if (!eventId) throw new Error("eventId required");
      await googleFetch(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" },
      );
      return { ok: true, eventId };
    }
    case "respond_to_event": {
      const eventId = String(args.eventId ?? "");
      const responseStatus = String(args.responseStatus ?? "");
      if (!eventId || !responseStatus) throw new Error("eventId and responseStatus required");
      const e = await googleFetch<CalEvent>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      );
      const selfEmail = e.organizer?.email; // may not be self; patch attendees response
      const me = await googleFetch<{ email?: string }>(
        token,
        "https://www.googleapis.com/oauth2/v2/userinfo",
      );
      const attendees = (e.attendees ?? []).map((a) =>
        a.email === me.email ? { ...a, responseStatus } : a,
      );
      if (!attendees.some((a) => a.email === me.email) && me.email) {
        attendees.push({ email: me.email, responseStatus });
      }
      void selfEmail;
      const updated = await googleFetch<CalEvent>(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", json: { attendees } },
      );
      return mapEvent(updated);
    }
    case "suggest_time": {
      const timeMin = String(args.timeMin ?? "");
      const timeMax = String(args.timeMax ?? "");
      if (!timeMin || !timeMax) throw new Error("timeMin and timeMax required");
      const durationMs = (Number(args.durationMinutes) || 30) * 60_000;
      const cal =
        typeof args.calendarId === "string" && args.calendarId ? args.calendarId : "primary";
      const fb = await googleFetch<{
        calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>;
      }>(token, "https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        json: {
          timeMin,
          timeMax,
          items: [{ id: cal }],
        },
      });
      const busy = (fb.calendars?.[cal]?.busy ?? [])
        .map((b) => ({
          start: new Date(b.start ?? 0).getTime(),
          end: new Date(b.end ?? 0).getTime(),
        }))
        .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
        .sort((a, b) => a.start - b.start);

      const windowStart = new Date(timeMin).getTime();
      const windowEnd = new Date(timeMax).getTime();
      const suggestions: Array<{ start: string; end: string }> = [];
      let cursor = windowStart;
      for (const slot of busy) {
        if (slot.start - cursor >= durationMs) {
          suggestions.push({
            start: new Date(cursor).toISOString(),
            end: new Date(cursor + durationMs).toISOString(),
          });
          if (suggestions.length >= 5) break;
        }
        cursor = Math.max(cursor, slot.end);
      }
      if (suggestions.length < 5 && windowEnd - cursor >= durationMs) {
        suggestions.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + durationMs).toISOString(),
        });
      }
      return { suggestions, busy: fb.calendars?.[cal]?.busy ?? [] };
    }
    default:
      throw new Error(`Unknown calendar tool: ${name}`);
  }
}
