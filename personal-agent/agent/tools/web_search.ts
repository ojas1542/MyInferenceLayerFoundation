import { defineTool } from "eve/tools";
import { z } from "zod";

// eve's built-in web_search is run by the model provider, and a local
// model has none, so eve leaves it out. This file takes over the same
// tool name with a Tavily-backed search.
// https://docs.tavily.com/documentation/api-reference/endpoint/search

// Each result's text is cut to this length. The local model reads every
// character on every later step of the turn, so results stay short; the
// agent can web_fetch a page to read it in full.
const MAX_SNIPPET_CHARS = 600;

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

export default defineTool({
  description:
    "Search the web. Returns the top results with a title, URL and a " +
    "relevant excerpt of each page. Use it to find current information " +
    "or the right page instead of guessing URLs, then web_fetch a result " +
    "only when the excerpt is not enough. Use this if you're not sure about an asked concept.",
  inputSchema: z.object({
    query: z.string().min(1).describe("What to search for"),
    topic: z
      .enum(["general", "news"])
      .optional()
      .describe("Use news for recent events. Defaults to general."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many results to return. Defaults to 5."),
  }),
  outputSchema: z.object({ results: z.array(resultSchema) }),
  async execute({ query, topic, maxResults }) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Web search is not configured: TAVILY_API_KEY is not set.",
      );
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        topic: topic ?? "general",
        max_results: maxResults ?? 5,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Tavily's error bodies hold no secrets and say what went wrong,
      // e.g. an invalid key or an exhausted plan.
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Web search failed (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as TavilyResponse;
    const results = (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: (r.content ?? "").slice(0, MAX_SNIPPET_CHARS),
      }));
    return { results };
  },
  // Plain text costs the model fewer tokens than the same results as
  // JSON. The chat UI still gets the structured output for its sources.
  toModelOutput({ results }) {
    if (results.length === 0) {
      return { type: "text", value: "No results." };
    }
    const value = results
      .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
      .join("\n\n");
    return { type: "text", value };
  },
});
