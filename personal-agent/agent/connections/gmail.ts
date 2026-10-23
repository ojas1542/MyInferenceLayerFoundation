import { defineMcpClientConnection } from "eve/connections";

// The Gmail MCP server in ../gmail-mcp, running on this machine. It reaches
// one mailbox, the account its `npm run auth` signed in with.
const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://127.0.0.1:3202/mcp";

// Sending cannot be undone, so the user approves each send in the chat.
const SEND_TOOLS = ["send_message", "send_draft"];

export default defineMcpClientConnection({
  url: GMAIL_MCP_URL,
  description:
    "The user's Gmail: search and read email threads, list and create " +
    "labels, archive, star or mark threads read, save drafts, and send email.",
  auth: {
    // Only signed-in callers reach the mailbox. An iMessage sender without
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
    SEND_TOOLS.some(name => toolName.endsWith(`__${name}`))
      ? "user-approval"
      : "not-applicable",
});
