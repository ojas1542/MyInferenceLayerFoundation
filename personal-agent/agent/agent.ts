import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

// The model runs locally behind the Go inference layer, which serves an
// OpenAI-compatible API in front of llama.cpp. A deployment cannot reach
// it, so this setup is for running the agent on the same machine.
const inferenceLayer = createOpenAICompatible({
  name: "inference-layer",
  baseURL: process.env.INFERENCE_API_URL ?? "http://127.0.0.1:9000/v1",
  // Lets token usage reach eve's session limits and compaction.
  includeUsage: true,
});

export default defineAgent({
  // llama-server serves a single model and ignores the requested id.
  model: inferenceLayer("qwen3.5-9b"),
  // AI Gateway has no metadata for local models, so eve needs the window
  // size to decide when to compact. It must match llama-server's -c.
  modelContextWindowTokens: Number(
    process.env.INFERENCE_CONTEXT_TOKENS ?? 32_768,
  ),
});
