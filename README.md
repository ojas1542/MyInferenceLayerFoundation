# Ojas's AI Lab

A personal AI stack that runs entirely on one Mac: a local LLM served by
llama.cpp, a Go inference layer with a semantic response cache, a chat UI,
and a durable personal agent you can reach from the web or by iMessage.

```mermaid
flowchart LR
  subgraph Clients
    B1[Browser<br/>Chat UI]
    B2[Browser<br/>Agent UI]
    P[iPhone<br/>iMessage]
  end

  subgraph Apps
    UI["ui/<br/>Next.js :3000"]
    AG["personal-agent/<br/>Nuxt + Eve :3200"]
    BR["imessage-bridge/<br/>Node :3201"]
    PH[(Photon)]
    PG[(Postgres :5433)]
  end

  subgraph Inference
    GO["Go inference layer<br/>:9000"]
    LC["llama-server :8080<br/>Qwen3.5 9B"]
    LE["llama-server :8081<br/>Qwen3 Embedding 0.6B"]
  end

  B1 --> UI -->|/v1/generate, /v1/context| GO
  B2 --> AG -->|/v1/chat/completions| GO
  P <--> PH <--> BR <-->|inbound / outbox| AG
  AG --- PG
  GO -->|chat, tokenize| LC
  GO -->|embeddings| LE
```

## Components

| Path | What it is | Port |
|------|------------|------|
| [`*.go`](main.go) | Inference layer: HTTP API in front of llama.cpp | 9000 |
| [`ui/`](ui) | Next.js chat UI for the inference layer | 3000 |
| [`personal-agent/`](personal-agent) | Personal agent (Eve) with a Nuxt web app | 3200 |
| [`imessage-bridge/`](imessage-bridge) | Relays iMessages between Photon and the agent | 3201 |
| llama-server (chat) | Qwen3.5 9B, 128K context | 8080 |
| llama-server (embeddings) | Qwen3 Embedding 0.6B, used by the cache | 8081 |
| Postgres | Agent accounts, threads and memory | 5433 |

### Inference layer (Go, repo root)

A small, dependency-light HTTP server ([`main.go`](main.go),
[`server.go`](server.go)) that owns every call to the model.

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/generate` | Chat generation, JSON or server-sent events. Accepts a prompt or a whole conversation with text attachments. |
| `POST /v1/context` | How many tokens a conversation uses, and the context size. Powers the UI's context meter. |
| `POST /v1/chat/completions`, `GET /v1/models` | OpenAI-compatible pass-through for SDK clients such as the agent, with streaming and tool calling intact. |
| `GET /healthz`, `GET /v1/info` | Worker health and the model being served. |

**Semantic cache** ([`cache.go`](cache.go)). `/v1/generate` answers repeated
questions without touching the model. A lookup first tries an exact match on
the prompt's SHA-256, then embeds the prompt with the embedding worker and
accepts the closest cached prompt above a cosine similarity of 0.95. Only a
single question without attachments is cached, since answers inside a longer
conversation depend on what came before. The cache is an in-memory LRU, so a
restart clears it.

The OpenAI-compatible routes ([`openai.go`](openai.go)) deliberately skip the
cache: agent turns depend on tool results and must never be replayed.

Configuration is by environment variable: `ADDR` (`:9000`), `LLAMA_URL`
(`http://127.0.0.1:8080`), `EMBED_URL` (`http://127.0.0.1:8081`),
`CACHE_SIZE` (1000) and `CACHE_THRESHOLD` (0.95).

### Chat UI ([`ui/`](ui))

A Next.js app with a pastel theme for talking to the model directly. Its API
routes proxy to the inference layer, so the browser never calls it directly.
It streams replies, renders Markdown, takes text attachments, and shows how
much of the context window the conversation uses. Chats are kept in the
browser.

### Personal agent ([`personal-agent/`](personal-agent))

Built on the [Eve](https://eve.dev) agent framework with a Nuxt UI, starting
from [vercel-labs/personal-agent-template](https://github.com/vercel-labs/personal-agent-template).
Its own [README](personal-agent/README.md) and
[docs](personal-agent/docs/ARCHITECTURE.md) cover the internals. Changes made
here:

- **Local model.** [`agent/agent.ts`](personal-agent/agent/agent.ts) talks to
  the inference layer's OpenAI-compatible API. `INFERENCE_CONTEXT_TOKENS`
  tells Eve the window size so it knows when to compact a conversation.
- **Memory in Postgres.** Eve's `fileMemory()` keeps one document per user in
  the `memory_documents` table, through the app's internal API. Memories are
  recalled at the start of every turn and shared across web and iMessage.
- **iMessage channel.** [`agent/channels/imessage.ts`](personal-agent/agent/channels/imessage.ts)
  accepts messages from the bridge and sends typing, replies and turn ends
  back to it. Phone numbers are linked to web accounts in Settings.
- **UI.** A granola theme over a night camp photo, a glass chat panel, and a
  context window meter in the composer, fed by the token usage Eve streams
  after each model call.

### iMessage bridge ([`imessage-bridge/`](imessage-bridge))

Photon delivers inbound iMessages to a connected SDK client rather than to a
webhook, so [`bridge.ts`](imessage-bridge/bridge.ts) holds that connection
open. It forwards each inbound text to the agent's `/imessage/inbound` route
and serves a local `/outbox` that the agent posts replies to. Both directions
are authenticated with `INTERNAL_API_SECRET`, and nothing listens on a public
address, so no tunnel is needed.

## Request flows

**Chat UI.** Browser → `ui` API route → `POST /v1/generate` → cache hit, or
llama-server → tokens streamed back as server-sent events.

**Agent, web.** Browser → Nuxt → Eve session → memory recall from Postgres →
`POST /v1/chat/completions` through the inference layer → llama-server → tool
calls run by Eve → reply streamed to the browser.

**Agent, iMessage.** iPhone → Photon → bridge → `POST /imessage/inbound` →
same agent turn as the web, under the linked account → replies posted to the
bridge outbox → Photon → iPhone.

## Running it

Requirements: macOS on Apple silicon (24 GB is comfortable), Go, Node 24,
pnpm (through corepack), Docker, and llama.cpp (`brew install llama.cpp`).

1. **Download the models** into the repo root:

   ```bash
   curl -LO https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf
   curl -LO https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf
   ```

2. **Start the model workers and the inference layer** (one terminal each):

   ```bash
   llama-server -m Qwen3.5-9B-Q4_K_M.gguf -ngl 99 --jinja --port 8080 \
     -c 131072 -fa on -ctk q8_0 -ctv q8_0 -ub 2048 \
     --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 1.5
   llama-server -m Qwen3-Embedding-0.6B-Q8_0.gguf --embeddings \
     --pooling last -ngl 99 -c 8192 -b 8192 -ub 8192 --port 8081
   go run .
   ```

   [`examples.txt`](examples.txt) has sample requests for every endpoint.

3. **Chat UI**: `cd ui && npm install && npm run dev`, then open
   http://localhost:3000.

4. **Personal agent**:

   ```bash
   cd personal-agent
   cp .env.example .env   # then fill in the secrets
   docker compose -f compose.local.yaml up -d
   corepack pnpm install
   PORT=3200 corepack pnpm dev
   ```

   Open http://localhost:3200. See
   [`docs/ENVIRONMENT.md`](personal-agent/docs/ENVIRONMENT.md) for every
   variable.

5. **iMessage (optional)**: set `IMESSAGE_PROJECT_ID` and
   `IMESSAGE_PROJECT_SECRET` in `personal-agent/.env`, then
   `cd imessage-bridge && npm install && npm start`. Link your phone number
   in the agent's Settings.

## Choosing the context window

`-c` on the chat worker and `INFERENCE_CONTEXT_TOKENS` in the agent's `.env`
must match. The agent's instructions and tool definitions alone take about
24K tokens. Qwen3.5 9B supports 256K natively, and only 8 of its 32 layers keep
a KV cache, so 128K with an 8-bit cache costs about 2 GB. Larger windows fit
in memory, but the agent only compacts history near the limit, so very long
chats get slow first.

## Upstream template

`personal-agent/` was merged with its history as a git subtree. To pull later
template changes:

```bash
git subtree pull --prefix=personal-agent \
  https://github.com/vercel-labs/personal-agent-template main
```
