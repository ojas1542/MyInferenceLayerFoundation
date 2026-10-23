// Gmail MCP server for the personal agent's `gmail` connection.
//
// Serves MCP over Streamable HTTP on a loopback address, so only processes
// on this machine reach it, and every request must carry the internal API
// secret. Gmail is reached as the account `npm run auth` signed in with.
//
// Run with: npm start (loads ../personal-agent/.env for the credentials).
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import {
  attachmentNames,
  bodyText,
  buildRawMessage,
  header,
  loadGmail,
  required,
} from "./gmail.ts";

const secret = Buffer.from(required("INTERNAL_API_SECRET"));
const port = Number(process.env.GMAIL_MCP_PORT ?? 3202);
const api = await loadGmail();

// The local model reads every character of a tool result on every later
// step of the turn, so long bodies and threads are cut short.
const MAX_BODY_CHARS = 3_000;
const MAX_THREAD_MESSAGES = 8;

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // A revoked or expired refresh token surfaces from the OAuth client as
  // invalid_grant, which only a new sign-in fixes.
  return message.includes("invalid_grant")
    ? "The Gmail sign-in has expired or was revoked; run npm run auth in gmail-mcp."
    : `Gmail request failed: ${message}`;
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

async function listLabels() {
  const { data } = await api.users.labels.list({ userId: "me" });
  return data.labels ?? [];
}

/** Label ids for names or ids, matched case-insensitively. */
async function resolveLabelIds(names: string[]) {
  if (names.length === 0) return [];
  const labels = await listLabels();
  return names.map((name) => {
    const lower = name.toLowerCase();
    const label = labels.find((l) =>
      l.id?.toLowerCase() === lower || l.name?.toLowerCase() === lower);
    if (!label?.id) {
      throw new Error(`No label named "${name}"; call list_labels to see them.`);
    }
    return label.id;
  });
}

function summarizeThread(thread: gmail_v1.Schema$Thread) {
  const messages = thread.messages ?? [];
  const first = messages[0]?.payload?.headers;
  const last = messages.at(-1);
  const labels = new Set(messages.flatMap((m) => m.labelIds ?? []));
  const flags = [
    `${messages.length} message${messages.length === 1 ? "" : "s"}`,
    labels.has("UNREAD") ? "unread" : undefined,
    labels.has("INBOX") ? undefined : "archived",
  ].filter(Boolean);

  return [
    `[${thread.id}] ${header(first, "Subject") || "(no subject)"}`,
    `From: ${header(last?.payload?.headers, "From")} | ` +
      `${header(last?.payload?.headers, "Date")} | ${flags.join(", ")}`,
    last?.snippet ?? "",
  ].join("\n");
}

function formatMessage(message: gmail_v1.Schema$Message) {
  const headers = message.payload?.headers;
  const attachments = attachmentNames(message.payload);
  let body = bodyText(message.payload);
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS)}\n[... body truncated]`;
  }

  return [
    `Message ${message.id}`,
    `From: ${header(headers, "From")}`,
    `To: ${header(headers, "To")}`,
    ...(header(headers, "Cc") ? [`Cc: ${header(headers, "Cc")}`] : []),
    `Date: ${header(headers, "Date")}`,
    `Labels: ${(message.labelIds ?? []).join(", ")}`,
    ...(attachments.length ? [`Attachments: ${attachments.join(", ")}`] : []),
    "",
    body || "(no text body)",
  ].join("\n");
}

const composeShape = {
  to: z
    .string()
    .optional()
    .describe(
      "Recipients, comma-separated. Optional when replying: defaults to " +
        "the sender of the thread's last message.",
    ),
  cc: z.string().optional().describe("Cc recipients, comma-separated"),
  bcc: z.string().optional().describe("Bcc recipients, comma-separated"),
  subject: z
    .string()
    .optional()
    .describe("Subject. Optional when replying: defaults to Re: the thread's"),
  body: z.string().min(1).describe("Plain-text message body"),
  threadId: z
    .string()
    .optional()
    .describe("Thread to reply in, from search_threads"),
};

type ComposeArgs = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  threadId?: string;
};

/** The raw message and thread for a new message or a reply. */
async function compose(args: ComposeArgs) {
  if (!args.threadId) {
    if (!args.to) throw new Error("to is required for a new message");
    if (!args.subject) throw new Error("subject is required for a new message");
    return {
      raw: buildRawMessage({ ...args, to: args.to, subject: args.subject }),
    };
  }

  const { data: thread } = await api.users.threads.get({
    userId: "me",
    id: args.threadId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"],
  });
  const last = thread.messages?.at(-1);
  if (!last) throw new Error(`Thread ${args.threadId} has no messages`);
  const headers = last.payload?.headers;

  // Replying after your own message continues to its recipients.
  const sentByMe = last.labelIds?.includes("SENT");
  const to = args.to
    || (sentByMe
      ? header(headers, "To")
      : header(headers, "Reply-To") || header(headers, "From"));
  const original = header(headers, "Subject");
  const subject = args.subject
    || (/^re:/i.test(original) ? original : `Re: ${original}`);
  const messageId = header(headers, "Message-ID");
  const references = [header(headers, "References"), messageId]
    .filter(Boolean)
    .join(" ");

  return {
    threadId: args.threadId,
    raw: buildRawMessage({
      ...args,
      to,
      subject,
      inReplyTo: messageId || undefined,
      references: references || undefined,
    }),
  };
}

function buildServer() {
  const server = new McpServer({ name: "gmail", version: "1.0.0" });

  server.registerTool(
    "search_threads",
    {
      description:
        "Search the mailbox with Gmail search syntax, e.g. is:unread, " +
        "from:alice, newer_than:7d, in:inbox. Returns thread ids, subjects, " +
        "senders and a snippet; call get_thread to read one.",
      inputSchema: {
        query: z
          .string()
          .describe("Gmail search query. Empty searches all mail."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many threads to return. Defaults to 10."),
        pageToken: z
          .string()
          .optional()
          .describe("Token from a previous search for the next page"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ query, maxResults, pageToken }) => {
      const { data } = await api.users.threads.list({
        userId: "me",
        q: query,
        maxResults: maxResults ?? 10,
        pageToken,
      });
      const threads = await Promise.all(
        (data.threads ?? []).map(async ({ id }) =>
          (await api.users.threads.get({
            userId: "me",
            id: id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          })).data),
      );
      if (threads.length === 0) return "No threads found.";

      const more = data.nextPageToken
        ? `\n\nMore results: pageToken ${data.nextPageToken}`
        : "";
      return threads.map(summarizeThread).join("\n\n") + more;
    }),
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "Read a thread's messages as plain text, with senders, recipients, " +
        "dates, labels and attachment names.",
      inputSchema: {
        threadId: z.string().describe("Thread id from search_threads"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ threadId }) => {
      const { data } = await api.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      });
      const messages = data.messages ?? [];
      const shown = messages.slice(-MAX_THREAD_MESSAGES);
      const skipped = messages.length - shown.length;
      const subject = header(messages[0]?.payload?.headers, "Subject");

      return [
        `Thread ${threadId}: ${subject || "(no subject)"}`,
        ...(skipped ? [`(${skipped} earlier messages not shown)`] : []),
        ...shown.map(formatMessage),
      ].join("\n\n---\n\n");
    }),
  );

  server.registerTool(
    "list_labels",
    {
      description:
        "List the mailbox's labels, both system labels (INBOX, UNREAD, " +
        "STARRED, IMPORTANT, SPAM, TRASH) and the user's own.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const labels = await listLabels();
      const names = (type: string) => labels
        .filter((l) => l.type === type)
        .map((l) => l.name)
        .sort()
        .join(", ");
      return `System: ${names("system")}\nUser: ${names("user") || "(none)"}`;
    }),
  );

  server.registerTool(
    "modify_thread_labels",
    {
      description:
        "Add or remove labels on every message in a thread. Remove INBOX " +
        "to archive, remove UNREAD to mark read, add STARRED to star.",
      inputSchema: {
        threadId: z.string().describe("Thread id from search_threads"),
        add: z
          .array(z.string())
          .optional()
          .describe("Label names or ids to add"),
        remove: z
          .array(z.string())
          .optional()
          .describe("Label names or ids to remove"),
      },
      annotations: { idempotentHint: true },
    },
    tool(async ({ threadId, add, remove }) => {
      const addLabelIds = await resolveLabelIds(add ?? []);
      const removeLabelIds = await resolveLabelIds(remove ?? []);
      if (addLabelIds.length + removeLabelIds.length === 0) {
        throw new Error("Pass at least one label to add or remove");
      }
      await api.users.threads.modify({
        userId: "me",
        id: threadId,
        requestBody: { addLabelIds, removeLabelIds },
      });
      return `Updated labels on thread ${threadId}.`;
    }),
  );

  server.registerTool(
    "create_label",
    {
      description: "Create a user label. Nest labels with a slash, e.g. Work/Hiring.",
      inputSchema: { name: z.string().min(1).describe("Label name") },
    },
    tool(async ({ name }) => {
      const { data } = await api.users.labels.create({
        userId: "me",
        requestBody: { name },
      });
      return `Created label ${data.name} (${data.id}).`;
    }),
  );

  server.registerTool(
    "create_draft",
    {
      description:
        "Save a plain-text draft without sending it, as a new message or as " +
        "a reply in a thread. Prefer this over send_message unless the user " +
        "asked to send.",
      inputSchema: composeShape,
    },
    tool(async (args: ComposeArgs) => {
      const message = await compose(args);
      const { data } = await api.users.drafts.create({
        userId: "me",
        requestBody: { message },
      });
      return `Saved draft ${data.id}. Send it with send_draft.`;
    }),
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a plain-text email now, as a new message or as a reply in a " +
        "thread. Only when the user asked to send.",
      inputSchema: composeShape,
      annotations: { destructiveHint: true },
    },
    tool(async (args: ComposeArgs) => {
      const { data } = await api.users.messages.send({
        userId: "me",
        requestBody: await compose(args),
      });
      return `Sent message ${data.id} in thread ${data.threadId}.`;
    }),
  );

  server.registerTool(
    "send_draft",
    {
      description: "Send a draft saved with create_draft.",
      inputSchema: { draftId: z.string().describe("Draft id from create_draft") },
      annotations: { destructiveHint: true },
    },
    tool(async ({ draftId }) => {
      const { data } = await api.users.drafts.send({
        userId: "me",
        requestBody: { id: draftId },
      });
      return `Sent message ${data.id} in thread ${data.threadId}.`;
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
  console.log(`Gmail MCP server listening on http://127.0.0.1:${port}/mcp`);
});
