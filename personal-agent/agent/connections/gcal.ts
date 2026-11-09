import { defineMcpClientConnection } from "eve/connections";

// The Google Calendar MCP server in ../gcal-mcp, running on this machine. It
// reaches one calendar, the account its `npm run auth` signed in with.
const GCAL_MCP_URL = process.env.GCAL_MCP_URL ?? "http://127.0.0.1:3203/mcp";

// Writes reach other people through invitations, so the user approves each
// one in the chat.
const WRITE_TOOLS = [
  "create_event",
  "update_event",
  "delete_event",
  "respond_to_event",
];

export default defineMcpClientConnection({
  url: GCAL_MCP_URL,
  description:
    "The user's Google Calendar: list calendars, list and search events, "
    + "read event details, find free time, create, change and delete "
    + "events, and answer invitations.",
  auth: {
    // Only signed-in callers reach the calendar. An iMessage sender without
    // a linked profile runs without auth, and eve refuses the connection.
    principalType: "user",
    getToken: async () => {
      const secret = process.env.INTERNAL_API_SECRET?.trim();
      if (!secret) {
        throw new Error("INTERNAL_API_SECRET is not set");
      }
      return { token: secret };
    },
  },
  approval: ({ toolName }) =>
    WRITE_TOOLS.some(name => toolName.endsWith(`__${name}`))
      ? "user-approval"
      : "not-applicable",
});
