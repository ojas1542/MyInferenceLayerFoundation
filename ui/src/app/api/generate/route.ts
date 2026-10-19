import { INFERENCE_API_URL } from "@/lib/server/inference";

// Proxies a generation to the inference API, passing the event stream
// through as it arrives. If the browser disconnects, request.signal
// aborts the upstream request, which stops generation on the worker.
export async function POST(request: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(`${INFERENCE_API_URL}/v1/generate`, {
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
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
