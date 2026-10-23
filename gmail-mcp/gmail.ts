// Gmail API access for the MCP server: the OAuth client, reading messages
// as plain text, and building the MIME messages it sends.
import { readFile } from "node:fs/promises";
import { auth, gmail } from "@googleapis/gmail";
import type { gmail_v1 } from "@googleapis/gmail";

// gmail.modify covers reading, labels, drafts and sending. It cannot
// delete mail permanently, which this server never needs.
export const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

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

/** A Gmail client for the account `npm run auth` signed in with. */
export async function loadGmail(): Promise<gmail_v1.Gmail> {
  let refreshToken: string | undefined;
  try {
    const saved = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    refreshToken = saved.refresh_token;
  }
  catch {
    // Handled below with the same message as an empty file.
  }
  if (!refreshToken) {
    throw new Error("No Gmail sign-in found; run npm run auth first.");
  }

  const client = oauthClient();
  // The client exchanges the refresh token for access tokens as needed.
  client.setCredentials({ refresh_token: refreshToken });
  return gmail({ version: "v1", auth: client });
}

type Headers = gmail_v1.Schema$MessagePartHeader[] | undefined;

export function header(headers: Headers, name: string) {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

function decode(data: string | null | undefined) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/** Good enough to read an HTML-only email, not a general converter. */
function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(\w+);/g, (match, name) => ENTITIES[name] ?? match);
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** The message body as plain text, preferring the text/plain part. */
export function bodyText(payload: gmail_v1.Schema$MessagePart | undefined) {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  const text = plain
    ? decode(plain.body?.data)
    : htmlToText(decode(findPart(payload, "text/html")?.body?.data));
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function attachmentNames(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string[] {
  if (!payload) return [];
  const own = payload.filename ? [payload.filename] : [];
  return [...own, ...(payload.parts ?? []).flatMap(attachmentNames)];
}

export interface OutgoingMessage {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** RFC 2047 encoding, so a subject can hold any Unicode text. */
function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A plain-text RFC 2822 message, base64url-encoded for the Gmail API. */
export function buildRawMessage(message: OutgoingMessage) {
  const headers: Array<[string, string | undefined]> = [
    ["To", message.to],
    ["Cc", message.cc],
    ["Bcc", message.bcc],
    ["Subject", encodeHeader(message.subject)],
    ["In-Reply-To", message.inReplyTo],
    ["References", message.references],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=UTF-8"],
    ["Content-Transfer-Encoding", "base64"],
  ];

  const lines: string[] = [];
  for (const [name, value] of headers) {
    if (!value) continue;
    // A line break in a header value would let it add headers of its own.
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} must not contain line breaks`);
    }
    lines.push(`${name}: ${value}`);
  }

  const body = Buffer.from(message.body, "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  const mime = `${lines.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}
