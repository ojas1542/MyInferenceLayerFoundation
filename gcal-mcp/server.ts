// Google Calendar MCP server for the personal agent's `gcal` connection.
//
// Serves MCP over Streamable HTTP on a loopback address, so only processes
// on this machine reach it, and every request must carry the internal API
// secret. Calendar is reached as the account `npm run auth` signed in with.
// Writes are gated by user approval in the agent's gcal connection.
//
// Run with: npm start (loads ../personal-agent/.env for the credentials).
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { calendar_v3 } from "@googleapis/calendar";
import { z } from "zod";
import {
  formatRange,
  eventTimes,
  formatWhen,
  InputError,
  loadCalendar,
  plainText,
  required,
  toInstant,
} from "./calendar.ts";

const secret = Buffer.from(required("INTERNAL_API_SECRET"));
const port = Number(process.env.GCAL_MCP_PORT ?? 3203);
const api = await loadCalendar();

// The local model reads every character of a tool result on every later
// step of the turn, so descriptions and attendee lists are cut short.
const MAX_DESCRIPTION_CHARS = 1_500;
const MAX_ATTENDEES = 15;

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function errorMessage(error: unknown) {
  if (error instanceof InputError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  // A revoked or expired refresh token surfaces from the OAuth client as
  // invalid_grant, which only a new sign-in fixes.
  if (message.includes("invalid_grant")) {
    return "The Google Calendar sign-in has expired or was revoked; run "
      + "npm run auth in gcal-mcp.";
  }
  // A sign-in from before write access was added lacks calendar.events.
  if (message.includes("insufficient authentication scopes")) {
    return "The Google Calendar sign-in cannot make changes; run npm run "
      + "auth in gcal-mcp to grant write access.";
  }
  return `Google Calendar request failed: ${message}`;
}

/** Runs a tool body, turning failures into a result the model can read. */
function tool<Args>(run: (args: Args) => Promise<string>) {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      return text(await run(args));
    }
    catch (error) {
      return { ...text(errorMessage(error)), isError: true };
    }
  };
}

/** The given time zone, or the primary calendar's when none is given. */
async function resolveTimeZone(timeZone?: string) {
  if (timeZone) return timeZone;
  const { data } = await api.calendars.get({ calendarId: "primary" });
  return data.timeZone ?? "UTC";
}

type CalendarEntry = calendar_v3.Schema$CalendarListEntry;

async function listCalendars() {
  const { data } = await api.calendarList.list({ maxResults: 100 });
  return data.items ?? [];
}

/**
 * Whether a calendar holds the user's own commitments: ones they own, and
 * feeds they imported, such as a work or school account's calendar. Ones
 * they only read, such as holidays or campus events, are not their schedule.
 */
function isSchedule(calendar: CalendarEntry) {
  return Boolean(calendar.primary)
    || calendar.accessRole === "owner"
    || Boolean(calendar.id?.endsWith("@import.calendar.google.com"));
}

function calendarName(calendar: CalendarEntry) {
  return calendar.summaryOverride || calendar.summary || calendar.id || "";
}

/** The calendars to read: the one asked for, or the user's schedule. */
async function targetCalendars(calendarId?: string) {
  const calendars = await listCalendars();
  if (!calendarId) return calendars.filter(isSchedule);
  const match = calendars.find((c) => c.id === calendarId
    || (calendarId === "primary" && c.primary));
  return [match ?? { id: calendarId, summary: calendarId }];
}

/** Finds an event on the calendar given, or on any schedule calendar. */
async function findEvent(eventId: string, calendarId?: string) {
  // An event id is unique to its calendar, so try each in turn.
  for (const calendar of await targetCalendars(calendarId)) {
    try {
      const { data } = await api.events.get({
        calendarId: calendar.id!,
        eventId,
      });
      // Google keeps a deleted event around as cancelled.
      if (data.status === "cancelled") {
        throw new InputError(`Event ${eventId} was deleted.`);
      }
      return { calendar, event: data };
    }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 410) throw error;
    }
  }
  throw new InputError(`No event ${eventId}; take ids from list_events.`);
}

/** Imported feeds and subscriptions are read-only to the user. */
function assertWritable(calendar: CalendarEntry) {
  if (calendar.accessRole !== "owner" && calendar.accessRole !== "writer") {
    throw new InputError(`${calendarName(calendar)} is read-only; the user ` +
      "can only change events on calendars they own or can edit.");
  }
}

/** A calendar to add an event to: the one given, or the primary. */
async function writableCalendar(calendarId?: string) {
  const [calendar] = await targetCalendars(calendarId ?? "primary");
  assertWritable(calendar!);
  return calendar!;
}

/** Emails as attendees, rejecting anything that is not an address. */
function attendeeList(emails: string[]) {
  return emails.map((email) => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new InputError(`"${email}" is not an email address.`);
    }
    return { email: trimmed };
  });
}

/** When an event starts, for ordering events from several calendars. */
function startMs(event: calendar_v3.Schema$Event) {
  return Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00:00Z`);
}

/** The signed-in user's attendee entry, when they are invited. */
function self(event: calendar_v3.Schema$Event) {
  return event.attendees?.find((a) => a.self);
}

function summarizeEvent(
  event: calendar_v3.Schema$Event,
  timeZone: string,
  calendar?: string,
) {
  const response = self(event)?.responseStatus;
  const flags = [
    event.status === "tentative" ? "tentative" : undefined,
    response && response !== "accepted" ? `you: ${response}` : undefined,
    event.recurringEventId ? "recurring" : undefined,
  ].filter(Boolean);
  const where = event.location || event.hangoutLink;

  return [
    `[${event.id}] ${formatWhen(event.start, event.end, timeZone)}`,
    ` ${event.summary || "(no title)"}`,
    where ? ` | ${where}` : "",
    flags.length ? ` | ${flags.join(", ")}` : "",
    calendar ? ` | calendar: ${calendar}` : "",
  ].join("");
}

function formatEvent(
  event: calendar_v3.Schema$Event,
  timeZone: string,
  calendar: string,
) {
  const attendees = event.attendees ?? [];
  const shown = attendees.slice(0, MAX_ATTENDEES).map((a) =>
    `${a.displayName || a.email}${a.organizer ? " (organizer)" : ""}: ` +
      `${a.responseStatus ?? "unknown"}`);
  const hidden = attendees.length - shown.length;
  let description = plainText(event.description ?? "");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n` +
      "[... description truncated]";
  }

  return [
    `Event ${event.id}: ${event.summary || "(no title)"}`,
    `When: ${formatWhen(event.start, event.end, timeZone)} (${timeZone})`,
    `Calendar: ${calendar}`,
    ...(event.location ? [`Where: ${event.location}`] : []),
    ...(event.hangoutLink ? [`Meet: ${event.hangoutLink}`] : []),
    `Organizer: ${event.organizer?.displayName || event.organizer?.email}`,
    `Status: ${event.status}`,
    ...(event.recurrence?.length
      ? [`Repeats: ${event.recurrence.join("; ")}`]
      : []),
    ...(shown.length
      ? [`Attendees:\n${shown.map((a) => `- ${a}`).join("\n")}` +
        (hidden ? `\n- and ${hidden} more` : "")]
      : []),
    "",
    description || "(no description)",
  ].join("\n");
}

// A plain string: a date-time format puts long regular expressions in the
// schema, which the local model tries to decode instead of calling the tool.
// toInstant checks the value and explains a wrong one.
function localTime(description: string) {
  return z
    .string()
    .describe(`${description}, as local time in timeZone with no Z or ` +
      "offset, e.g. 2026-10-27T11:00:00");
}

const timeZoneShape = z
  .string()
  .optional()
  .describe(
    "IANA time zone that times are given and shown in, e.g. " +
      "America/Los_Angeles. Defaults to the primary calendar's.",
  );

function buildServer() {
  const server = new McpServer({ name: "gcal", version: "1.0.0" });

  server.registerTool(
    "list_calendars",
    {
      description:
        "List the user's calendars with their ids and time zones, and " +
        "which count as their schedule. The other tools read the schedule " +
        "calendars unless given a calendar id.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const calendars = await listCalendars();
      if (calendars.length === 0) return "No calendars found.";
      // Primary first, then the rest of the schedule, then subscriptions.
      const rank = (c: CalendarEntry) => c.primary ? 0 : isSchedule(c) ? 1 : 2;
      return [...calendars]
        .sort((a, b) => rank(a) - rank(b))
        .map((c) => [
          `[${c.id}] ${calendarName(c)}`,
          c.primary ? " (primary)" : "",
          isSchedule(c)
            ? " | schedule"
            : " | subscription, not the user's schedule",
          ` | ${c.timeZone}`,
        ].join(""))
        .join("\n");
    }),
  );

  server.registerTool(
    "list_events",
    {
      description:
        "List events between two times in start order, with recurring " +
        "events expanded. Pass query to search titles, descriptions, " +
        "locations and attendees. Returns event ids; call get_event for " +
        "details.",
      inputSchema: {
        timeMin: localTime("Start of the range"),
        timeMax: localTime("End of the range"),
        query: z
          .string()
          .optional()
          .describe("Free text to match, e.g. a person or a project"),
        calendarId: z
          .string()
          .optional()
          .describe(
            "Calendar id from list_calendars. Defaults to all of the " +
              "user's schedule calendars.",
          ),
        timeZone: timeZoneShape,
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many events to return. Defaults to 25."),
        pageToken: z
          .string()
          .optional()
          .describe(
            "Token from a previous call for the next page; needs calendarId",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone(args.timeZone);
      const timeMin = toInstant(args.timeMin, timeZone);
      const timeMax = toInstant(args.timeMax, timeZone);
      const maxResults = args.maxResults ?? 25;
      const calendars = await targetCalendars(args.calendarId);
      const pages = await Promise.all(calendars.map(async (calendar) => {
        const { data } = await api.events.list({
          calendarId: calendar.id!,
          timeMin,
          timeMax,
          q: args.query,
          singleEvents: true,
          orderBy: "startTime",
          maxResults,
          pageToken: args.pageToken,
        });
        return { calendar, data };
      }));

      // Declined events are not on the user's schedule.
      const events = pages
        .flatMap(({ calendar, data }) => (data.items ?? [])
          .filter((e) => self(e)?.responseStatus !== "declined")
          .map((event) => ({ event, calendar })))
        .sort((a, b) => startMs(a.event) - startMs(b.event));
      if (events.length === 0) return "No events in that range.";

      const shown = events.slice(0, maxResults);
      const nextPage = pages.length === 1 ? pages[0]!.data.nextPageToken : "";
      const more = nextPage
        ? `\n\nMore events: pageToken ${nextPage}`
        : shown.length < events.length
            || pages.some(({ data }) => data.nextPageToken)
          ? "\n\nMore events: narrow the range to see them."
          : "";
      // Name the calendar only when events come from more than one.
      const named = calendars.length > 1;
      return `Times in ${timeZone}\n\n` + shown
        .map(({ event, calendar }) => summarizeEvent(event, timeZone,
          named ? calendarName(calendar) : undefined))
        .join("\n") + more;
    }),
  );

  server.registerTool(
    "get_event",
    {
      description:
        "Read one event in full: time, place, meeting link, organizer, " +
        "attendees and their responses, recurrence, and description.",
      inputSchema: {
        eventId: z.string().describe("Event id from list_events"),
        calendarId: z
          .string()
          .optional()
          .describe(
            "Calendar id from list_calendars. Defaults to searching the " +
              "user's schedule calendars.",
          ),
        timeZone: timeZoneShape,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone(args.timeZone);
      const { calendar, event } = await findEvent(args.eventId,
        args.calendarId);
      return formatEvent(event, timeZone, calendarName(calendar));
    }),
  );

  server.registerTool(
    "find_free_time",
    {
      description:
        "Find free slots between two times across one or more calendars, " +
        "for scheduling. Includes nights and weekends, so pick slots at " +
        "sensible hours.",
      inputSchema: {
        timeMin: localTime("Start of the range"),
        timeMax: localTime("End of the range"),
        minMinutes: z
          .number()
          .int()
          .min(5)
          .optional()
          .describe("Shortest slot worth listing. Defaults to 30."),
        calendarIds: z
          .array(z.string())
          .optional()
          .describe(
            "Calendars that must all be free. Defaults to all of the " +
              "user's schedule calendars.",
          ),
        timeZone: timeZoneShape,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (args) => {
      const ids = args.calendarIds?.length
        ? args.calendarIds
        : (await targetCalendars()).map((c) => c.id!);
      const timeZone = await resolveTimeZone(args.timeZone);
      const timeMin = toInstant(args.timeMin, timeZone);
      const timeMax = toInstant(args.timeMax, timeZone);
      const { data } = await api.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: ids.map((id) => ({ id })),
        },
      });

      const busy: Array<[number, number]> = [];
      for (const [id, entry] of Object.entries(data.calendars ?? {})) {
        if (entry.errors?.length) {
          throw new Error(`Cannot read ${id}: ${entry.errors[0]?.reason}`);
        }
        for (const period of entry.busy ?? []) {
          busy.push([Date.parse(period.start!), Date.parse(period.end!)]);
        }
      }
      busy.sort((a, b) => a[0] - b[0]);

      // Walk the busy periods in order; each gap before one is free.
      const minMs = (args.minMinutes ?? 30) * 60_000;
      const end = Date.parse(timeMax);
      const free: string[] = [];
      let cursor = Date.parse(timeMin);
      for (const [start, stop] of [...busy, [end, end] as [number, number]]) {
        if (start - cursor >= minMs) {
          free.push(formatRange(
            new Date(cursor),
            new Date(Math.min(start, end)),
            timeZone,
          ));
        }
        cursor = Math.max(cursor, stop);
      }
      if (free.length === 0) return "No free slots that long in that range.";
      return `Free slots in ${timeZone}\n\n${free.join("\n")}`;
    }),
  );

  const eventIdShape = z.string().describe("Event id from list_events");
  const eventCalendarShape = z
    .string()
    .optional()
    .describe(
      "Calendar id from list_calendars. Defaults to searching the user's " +
        "schedule calendars.",
    );
  const eventTimeShape = (which: string) => z
    .string()
    .describe(
      `${which}, as local time in timeZone with no Z or offset, e.g. ` +
        "2026-10-27T11:00:00. For an all-day event give a date, e.g. " +
        `2026-10-27${which === "End" ? ", the last day" : ""}.`,
    );

  server.registerTool(
    "create_event",
    {
      description:
        "Add an event to a calendar, by default the primary. Invitees get " +
        "an email invitation. Waits for the user's approval.",
      inputSchema: {
        summary: z.string().min(1).describe("Event title"),
        start: eventTimeShape("Start"),
        end: eventTimeShape("End"),
        timeZone: timeZoneShape,
        location: z.string().optional().describe("Place or address"),
        description: z.string().optional().describe("Notes for the event"),
        attendees: z
          .array(z.string())
          .optional()
          .describe("Email addresses to invite"),
        addMeet: z
          .boolean()
          .optional()
          .describe("Attach a new Google Meet link"),
        calendarId: z
          .string()
          .optional()
          .describe("Calendar id from list_calendars. Defaults to primary."),
      },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone(args.timeZone);
      const calendar = await writableCalendar(args.calendarId);
      const { data } = await api.events.insert({
        calendarId: calendar.id!,
        sendUpdates: "all",
        conferenceDataVersion: args.addMeet ? 1 : 0,
        requestBody: {
          summary: args.summary,
          location: args.location,
          description: args.description,
          ...eventTimes(args.start, args.end, timeZone),
          attendees: args.attendees && attendeeList(args.attendees),
          conferenceData: args.addMeet
            ? {
                createRequest: {
                  requestId: crypto.randomUUID(),
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              }
            : undefined,
        },
      });
      return `Created on ${calendarName(calendar)}:\n` +
        summarizeEvent(data, timeZone);
    }),
  );

  server.registerTool(
    "update_event",
    {
      description:
        "Change an event's title, time, place, notes or invitees. Only the " +
        "fields given change; invitees are told about the change. Waits for " +
        "the user's approval.",
      inputSchema: {
        eventId: eventIdShape,
        calendarId: eventCalendarShape,
        summary: z.string().min(1).optional().describe("New title"),
        start: eventTimeShape("Start").optional(),
        end: eventTimeShape("End").optional(),
        timeZone: timeZoneShape,
        location: z.string().optional().describe("New place or address"),
        description: z.string().optional().describe("New notes"),
        addAttendees: z
          .array(z.string())
          .optional()
          .describe("Email addresses to invite"),
        removeAttendees: z
          .array(z.string())
          .optional()
          .describe("Email addresses to uninvite"),
      },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone(args.timeZone);
      const { calendar, event } = await findEvent(args.eventId,
        args.calendarId);
      assertWritable(calendar);

      const patch: calendar_v3.Schema$Event = {
        summary: args.summary,
        location: args.location,
        description: args.description,
      };
      if (args.start || args.end) {
        if (!args.start || !args.end) {
          throw new InputError("Give both start and end when changing the " +
            "time.");
        }
        Object.assign(patch, eventTimes(args.start, args.end, timeZone));
      }
      if (args.addAttendees?.length || args.removeAttendees?.length) {
        const removed = new Set((args.removeAttendees ?? [])
          .map((email) => email.trim().toLowerCase()));
        const kept = (event.attendees ?? [])
          .filter((a) => !removed.has(a.email?.toLowerCase() ?? ""));
        const known = new Set(kept.map((a) => a.email?.toLowerCase()));
        const added = attendeeList(args.addAttendees ?? [])
          .filter((a) => !known.has(a.email.toLowerCase()));
        patch.attendees = [...kept, ...added];
      }

      const { data } = await api.events.patch({
        calendarId: calendar.id!,
        eventId: args.eventId,
        sendUpdates: "all",
        requestBody: patch,
      });
      return `Updated on ${calendarName(calendar)}:\n` +
        summarizeEvent(data, timeZone);
    }),
  );

  server.registerTool(
    "delete_event",
    {
      description:
        "Delete an event. For a recurring event this removes only the one " +
        "occurrence from list_events. Invitees are told it is cancelled. " +
        "Waits for the user's approval.",
      inputSchema: { eventId: eventIdShape, calendarId: eventCalendarShape },
      annotations: { destructiveHint: true },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone();
      const { calendar, event } = await findEvent(args.eventId,
        args.calendarId);
      assertWritable(calendar);
      await api.events.delete({
        calendarId: calendar.id!,
        eventId: args.eventId,
        sendUpdates: "all",
      });
      return `Deleted from ${calendarName(calendar)}:\n` +
        summarizeEvent(event, timeZone);
    }),
  );

  server.registerTool(
    "respond_to_event",
    {
      description:
        "Accept, decline or tentatively accept an invitation. The " +
        "organizer is told. Waits for the user's approval.",
      inputSchema: {
        eventId: eventIdShape,
        calendarId: eventCalendarShape,
        response: z
          .enum(["accepted", "declined", "tentative"])
          .describe("The user's answer"),
      },
      annotations: { idempotentHint: true },
    },
    tool(async (args) => {
      const timeZone = await resolveTimeZone();
      const { calendar, event } = await findEvent(args.eventId,
        args.calendarId);
      if (!self(event)) {
        throw new InputError("The user is not invited to that event, so " +
          "there is nothing to respond to.");
      }
      // Patching attendees replaces the list, so send it whole.
      const attendees = (event.attendees ?? []).map((a) =>
        a.self ? { ...a, responseStatus: args.response } : a);
      const { data } = await api.events.patch({
        calendarId: calendar.id!,
        eventId: args.eventId,
        sendUpdates: "all",
        requestBody: { attendees },
      });
      return `Responded ${args.response}:\n` + summarizeEvent(data, timeZone);
    }),
  );

  return server;
}

function isAuthorized(request: IncomingMessage) {
  const given = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.concat([Buffer.from("Bearer "), secret]);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const http = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  if (pathname !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (!isAuthorized(request)) {
    response.writeHead(401).end();
    return;
  }
  // Stateless: each POST carries a whole exchange, so there is no session
  // stream to open with GET or close with DELETE.
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" }).end();
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  }
  catch (error) {
    console.error("MCP request failed:", error);
    if (!response.headersSent) response.writeHead(500).end();
  }
});

http.listen(port, "127.0.0.1", () => {
  console.log(
    `Google Calendar MCP server listening on http://127.0.0.1:${port}/mcp`,
  );
});
