import { internalHeaders } from "./internal-api.js";

export type BridgeEvent =
  | { type: "typing" }
  | { type: "message"; text: string }
  | { type: "done" };

function bridgeOrigin() {
  const port = process.env.IMESSAGE_BRIDGE_PORT?.trim() || "3201";
  return `http://127.0.0.1:${port}`;
}

/**
 * Hands an agent event for one iMessage chat to the bridge process, which
 * sends it through Photon. Delivery is best-effort: if the bridge is down,
 * the reply is logged and dropped rather than failing the agent turn.
 */
export async function notifyBridge(chatId: string | undefined, event: BridgeEvent) {
  if (!chatId) {
    return;
  }

  try {
    const response = await fetch(`${bridgeOrigin()}/outbox`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ chatId, ...event }),
    });
    if (!response.ok) {
      console.error(`[imessage] bridge rejected ${event.type}: ${response.status}`);
    }
  }
  catch (error) {
    console.error(`[imessage] bridge unreachable for ${event.type}:`, error);
  }
}
