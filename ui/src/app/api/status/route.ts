import { INFERENCE_API_URL } from "@/lib/server/inference";

// Reports whether the inference API and its workers are healthy, and
// which model is loaded.
export async function GET() {
  const signal = AbortSignal.timeout(3000);
  const [health, info] = await Promise.allSettled([
    fetch(`${INFERENCE_API_URL}/healthz`, { signal, cache: "no-store" }),
    fetch(`${INFERENCE_API_URL}/v1/info`, { signal, cache: "no-store" }),
  ]);
  const healthy = health.status === "fulfilled" && health.value.ok;
  let model: string | null = null;
  if (info.status === "fulfilled" && info.value.ok) {
    const body = (await info.value.json()) as { model?: string };
    model = body.model ? displayName(body.model) : null;
  }
  return Response.json({ healthy, model });
}

// "/path/to/Qwen3.5-9B-Q4_K_M.gguf" -> "Qwen3.5-9B-Q4_K_M"
function displayName(model: string): string {
  return (model.split("/").pop() ?? model).replace(/\.gguf$/i, "");
}
