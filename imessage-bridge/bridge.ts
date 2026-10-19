// iMessage bridge between Photon and the agent's `imessage` channel.
//
// Photon delivers this project's inbound iMessages to a connected SDK
// client, not to webhooks, so this long-running process holds that
// connection. Inbound text is posted to the agent; the agent posts typing,
// replies and turn ends back to the outbox served here. Nothing listens on
// a public address, so no tunnel is needed.
//
// Run with: npm start (loads ../personal-agent/.env for the credentials).
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Spectrum } from "spectrum-ts";
import type { Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set; run with --env-file=.env`);
  }
  return value;
}

const projectId = required("IMESSAGE_PROJECT_ID");
const projectSecret = required("IMESSAGE_PROJECT_SECRET");
const secret = required("INTERNAL_API_SECRET");
const agentOrigin = (process.env.IMESSAGE_AGENT_URL ?? "http://localhost:3200").replace(/\/$/, "");
const port = Number(process.env.IMESSAGE_BRIDGE_PORT ?? 3201);

// Spaces seen on inbound messages, so replies can find their chat. Replies
// for a chat the bridge has not seen since it started are dropped.
const spaces = new Map<string, Space>();

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Outbox: events from the agent for one chat.
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/outbox") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${secret}`) {
    response.writeHead(401).end();
    return;
  }

  try {
    const event = await readJson(request) as {
      chatId?: string;
      type?: string;
      text?: string;
    };
    const space = event.chatId ? spaces.get(event.chatId) : undefined;
    if (!space) {
      console.warn(`[bridge] no open chat for ${event.chatId}; dropping ${event.type}`);
      response.writeHead(404).end();
      return;
    }

    if (event.type === "typing") {
      await space.startTyping();
    }
    else if (event.type === "message" && event.text) {
      await space.send(event.text);
      console.log(`[bridge] replied in ${event.chatId} (${event.text.length} chars)`);
    }
    else if (event.type === "done") {
      await space.stopTyping();
    }
    response.writeHead(204).end();
  }
  catch (error) {
    console.error("[bridge] outbox error:", error);
    response.writeHead(500).end();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[bridge] connected to Photon; outbox on 127.0.0.1:${port}, agent at ${agentOrigin}`);
});

// Inbound: forward each text message to the agent.
for await (const [space, message] of app.messages) {
  const sender = message.sender?.id;
  if (message.content.type !== "text" || !sender) {
    continue;
  }
  spaces.set(space.id, space);
  // Read receipts are best-effort.
  space.read(message).catch(() => {});

  try {
    const response = await fetch(`${agentOrigin}/imessage/inbound`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chatId: space.id,
        sender,
        text: message.content.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`agent responded ${response.status}`);
    }
    console.log(`[bridge] forwarded message in ${space.id}`);
  }
  catch (error) {
    console.error("[bridge] could not reach the agent:", error);
    await space.send("Sorry, I can't reach the agent right now. Please try again in a bit.")
      .catch(() => {});
  }
}
