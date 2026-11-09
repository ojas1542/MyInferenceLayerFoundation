// Google Calendar API access for the MCP server: the OAuth client and
// formatting events as compact text for the local model.
import { readFile } from "node:fs/promises";
import { auth, calendar } from "@googleapis/calendar";
import type { calendar_v3 } from "@googleapis/calendar";

// calendar.readonly covers the calendar list and free/busy; calendar.events
// adds creating, changing and deleting events. Neither can change calendars
// themselves or their sharing.
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export const TOKEN_PATH = new URL("./.data/token.json", import.meta.url);

export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set; run with --env-file=.env`);
  }
  return value;
}

export function oauthClient(redirectUri?: string) {
  return new auth.OAuth2({
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    redirectUri,
  });
}

/** A Calendar client for the account `npm run auth` signed in with. */
export async function loadCalendar(): Promise<calendar_v3.Calendar> {
  let refreshToken: string | undefined;
  try {
    const saved = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    refreshToken = saved.refresh_token;
  }
  catch {
    // Handled below with the same message as an empty file.
  }
  if (!refreshToken) {
    throw new Error(
      "No Google Calendar sign-in found; run npm run auth first.",
    );
  }

  const client = oauthClient();
  // The client exchanges the refresh token for access tokens as needed.
  client.setCredentials({ refresh_token: refreshToken });
  return calendar({ version: "v3", auth: client });
}

// The year is always shown, so the model never mistakes a past event for an
// upcoming one.
const DAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
};

/** "Tue, Oct 27, 2026, 09:00" in the given time zone. */
function formatTime(date: Date, timeZone: string) {
  return date.toLocaleString("en-US", {
    ...DAY,
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "Tue, Oct 27, 2026" for an all-day date, which has no time zone. */
function formatDay(date: string) {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleString("en-US", { ...DAY, timeZone: "UTC" });
}

/** A time range, with the end as a time only when it is the same day. */
export function formatRange(from: Date, to: Date, timeZone: string) {
  const start = formatTime(from, timeZone);
  const end = formatTime(to, timeZone);
  const [startDay] = start.split(/, (?=\d\d:)/);
  const [endDay, endClock] = end.split(/, (?=\d\d:)/);
  return startDay === endDay ? `${start}-${endClock}` : `${start} - ${end}`;
}

/** How far the time zone is ahead of UTC at an instant, in milliseconds. */
function offsetMs(at: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at).map(p => [p.type, Number(p.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour,
    parts.minute, parts.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/** A bad tool argument, reported to the model as is. */
export class InputError extends Error {}

const LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/;

/** The wall-clock time in the time zone at an instant, 2026-10-27T11:00:00. */
function wallClock(at: number, timeZone: string) {
  return new Date(at + offsetMs(at, timeZone)).toISOString().slice(0, 19);
}

/**
 * An RFC 3339 instant in UTC for a wall-clock time in the time zone, so the
 * model never has to work out offsets itself.
 */
export function toInstant(value: string, timeZone: string) {
  const trimmed = value.trim();
  if (!LOCAL_TIME.test(trimmed)) {
    // The model often adds Z to a local time; showing what its value means
    // locally lets it correct either mistake by copying the right one.
    const at = Date.parse(trimmed);
    throw new InputError(Number.isNaN(at)
      ? `"${value}" is not a time. Send local time in ${timeZone} like ` +
        "2026-10-27T11:00:00, with no Z or offset."
      : `"${value}" is ${wallClock(at, timeZone)} in ${timeZone}. Send ` +
        "local time like that, with no Z or offset.");
  }
  const wall = Date.parse(`${trimmed}Z`);
  // A second pass corrects the guess across a daylight saving change.
  const guess = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(guess, timeZone)).toISOString();
}

const DATE = /^\d{4}-\d\d-\d\d$/;

/**
 * An event's start and end from local times, or from dates for an all-day
 * event. The end date of an all-day event is its last day, which Google
 * stores as the day after.
 */
export function eventTimes(start: string, end: string, timeZone: string) {
  const allDay = DATE.test(start.trim());
  if (allDay !== DATE.test(end.trim())) {
    throw new InputError("Give both start and end as dates for an all-day " +
      "event, or both as local times.");
  }
  if (allDay) {
    const after = new Date(Date.parse(`${end.trim()}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (after <= start.trim()) {
      throw new InputError("The end date is before the start date.");
    }
    return { start: { date: start.trim() }, end: { date: after } };
  }
  const from = toInstant(start, timeZone);
  const to = toInstant(end, timeZone);
  if (to <= from) throw new InputError("The end is not after the start.");
  return {
    start: { dateTime: from, timeZone },
    end: { dateTime: to, timeZone },
  };
}

type EventTime = calendar_v3.Schema$EventDateTime | undefined;

/** When an event happens, as one short phrase. */
export function formatWhen(
  start: EventTime,
  end: EventTime,
  timeZone: string,
) {
  if (start?.date) {
    // An all-day event's end date is exclusive.
    const last = end?.date
      ? new Date(Date.parse(`${end.date}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10)
      : start.date;
    return last === start.date
      ? `${formatDay(start.date)} (all day)`
      : `${formatDay(start.date)} - ${formatDay(last)} (all day)`;
  }
  if (!start?.dateTime) return "(no time)";
  const from = new Date(start.dateTime);
  return end?.dateTime
    ? formatRange(from, new Date(end.dateTime), timeZone)
    : formatTime(from, timeZone);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/** Event descriptions are often HTML; good enough to read them as text. */
export function plainText(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(\w+);/g, (match, name) => ENTITIES[name] ?? match)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
