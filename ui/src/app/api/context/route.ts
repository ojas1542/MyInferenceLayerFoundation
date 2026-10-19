import { INFERENCE_API_URL } from "@/lib/server/inference";

// Proxies a context window usage count to the inference API.
export async function POST(request: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(`${INFERENCE_API_URL}/v1/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      signal: request.signal,
    });
  } catch {
    return Response.json(
      { error: "The inference API isn't reachable. Is it running?" },
      { status: 502 },
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
