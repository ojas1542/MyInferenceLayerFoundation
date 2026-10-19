import "server-only";

// Base URL of the Go inference API. Only the Next.js server talks to it,
// so the browser never needs direct access.
export const INFERENCE_API_URL =
  process.env.INFERENCE_API_URL ?? "http://127.0.0.1:9000";
