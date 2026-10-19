import { defineChannel, POST } from "eve/channels";
import { buildAppSessionAuth } from "../../shared/app-auth.js";
import { fetchPhoneLink } from "../lib/phone-internal.js";
import { notifyBridge } from "../lib/imessage-bridge.js";

// iMessage through Photon, delivered by scripts/imessage-bridge.ts.
//
// Photon delivers inbound iMessages to a connected SDK client rather than
// to webhooks for this project, so eve's webhook-based Photon channel never
// receives them. The bridge holds that connection: it posts each inbound
// message here, and the events below hand replies back to it. Both hops
// stay on this machine and carry the internal API secret.

/** iMessage handles are phone numbers or Apple IDs; only the former can match a profile. */
function asPhoneNumber(handle: string) {
  const normalized = handle.trim().startsWith("+")
    ? handle.trim()
    : `+${handle.replace(/\D/g, "")}`;

  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
}

function isInternalRequest(request: Request) {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

interface InboundMessage {
  chatId: string;
  sender: string;
  text: string;
}

function parseInbound(body: unknown): InboundMessage | undefined {
  const { chatId, sender, text } = (body ?? {}) as Record<string, unknown>;
  if (typeof chatId !== "string" || !chatId) return undefined;
  if (typeof sender !== "string" || !sender) return undefined;
  if (typeof text !== "string" || !text.trim()) return undefined;
  return { chatId, sender, text };
}

export default defineChannel({
  routes: [
    POST("/imessage/inbound", async (request, { from }) => {
      if (!isInternalRequest(request)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const message = parseInbound(await request.json().catch(() => null));
      if (!message) {
        return new Response("Expected chatId, sender and text", { status: 400 });
      }

      const phoneNumber = asPhoneNumber(message.sender);
      const link = phoneNumber ? await fetchPhoneLink(phoneNumber) : undefined;

      // Without a linked profile the sender gets answers, but no access to
      // anyone's memory or integrations.
      const session = link
        ? await from(message.chatId).send(message.text, {
            auth: buildAppSessionAuth(link.appUserId, {
              phone_number: link.phoneNumber,
            }),
          })
        : await from(message.chatId).send(message.text, {
            auth: null,
            context: [
              "This iMessage sender is not on any profile, so you have no access to their memory or integrations.",
              "If they ask for anything that needs those, tell them to add their number under Settings → Profile.",
            ],
          });

      return Response.json({ sessionId: session.id }, { status: 202 });
    }),
  ],

  events: {
    async "turn.started"(_data, channel) {
      await notifyBridge(channel.continuation?.token, { type: "typing" });
    },
    async "message.completed"(data, channel) {
      const text = data.message?.trim();
      if (text) {
        await notifyBridge(channel.continuation?.token, { type: "message", text });
      }
    },
    async "turn.failed"(_data, channel) {
      await notifyBridge(channel.continuation?.token, {
        type: "message",
        text: "Sorry, something went wrong on my side. Please try again.",
      });
    },
    async "turn.completed"(_data, channel) {
      await notifyBridge(channel.continuation?.token, { type: "done" });
    },
    async "turn.cancelled"(_data, channel) {
      await notifyBridge(channel.continuation?.token, { type: "done" });
    },
  },
});
