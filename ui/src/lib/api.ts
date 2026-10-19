import type { Message } from "./types";

export type ApiMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: { name: string; content: string }[];
};

export type StreamDelta = { text?: string; reasoning?: string };

export type StreamDone = {
  usage: { prompt_tokens: number; completion_tokens: number };
  timings?: { predicted_per_second: number };
  cached: boolean;
  similarity?: number;
};

// toApiMessages converts the chat history into the inference API's
// format. Failed or empty answers are left out, and so is the model's
// reasoning, which is not meant to be fed back to it.
export function toApiMessages(messages: Message[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && (m.error || !m.content)) continue;
    const msg: ApiMessage = { role: m.role, content: m.content };
    if (m.attachments?.length) {
      msg.attachments = m.attachments.map((a) => ({
        name: a.name,
        content: a.content,
      }));
    }
    out.push(msg);
  }
  return out;
}

// streamGenerate streams a reply to messages, calling onDelta for each
// piece of text, and resolves with the final usage and cache details.
// refreshCache asks for a fresh answer even if one is cached.
export async function streamGenerate(
  messages: ApiMessage[],
  signal: AbortSignal,
  onDelta: (d: StreamDelta) => void,
  refreshCache = false,
): Promise<StreamDone> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      refresh_cache: refreshCache || undefined,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await errorMessage(res));
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let end;
    while ((end = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, end);
      buf = buf.slice(end + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.done) return data as StreamDone;
        onDelta(data as StreamDelta);
      }
    }
  }
  throw new Error("The response ended unexpectedly.");
}

export type ContextUsage = { tokens: number; contextSize: number };

// countContext asks how many tokens messages would take up as the prompt
// of a request, and how large the model's context window is.
export async function countContext(
  messages: ApiMessage[],
  signal: AbortSignal,
): Promise<ContextUsage> {
  const res = await fetch("/api/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { tokens: number; context_size: number };
  return { tokens: body.tokens, contextSize: body.context_size };
}

export type Status = { healthy: boolean; model: string | null };

export async function fetchStatus(): Promise<Status> {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    return (await res.json()) as Status;
  } catch {
    return { healthy: false, model: null };
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `Request failed (${res.status} ${res.statusText})`;
}
