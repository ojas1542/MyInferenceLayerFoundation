# Environment Variables

> Back to [README](../README.md) | See also: [Architecture](./ARCHITECTURE.md), [Customization](./CUSTOMIZATION.md)

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

## Quick start (minimum required)

| Variable | How to get it |
|----------|---------------|
| `BETTER_AUTH_SECRET` | Run `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `http://localhost:3200` locally, or your production URL |
| `INTERNAL_API_SECRET` | Run `openssl rand -base64 32` (must match on web + eve services) |

On Vercel, set them on **both** the `web` and `eve` services — and add a database (see below).

## Database

### `DATABASE_URL` (required everywhere)

NuxtHub is pinned to PostgreSQL with the `postgres-js` driver, so a database is
required in development too — there is no local file fallback. Without it every
command that loads Nuxt stops with:

```
postgres-js driver requires DATABASE_URL, POSTGRES_URL, or POSTGRESQL_URL
environment variable when applyMigrationsDuringBuild is enabled
```

Provision [Neon from the Vercel Marketplace](https://vercel.com/marketplace/neon) — the
Deploy button in the README includes it — or add it to an existing project:

```bash
vercel integration add neon
```

The integration sets `DATABASE_URL` on Production and Preview. Add it to
**Development** as well (a separate Neon branch keeps local work off the
deployed data), then pull it locally:

```bash
vercel env pull
```

Migrations in [`server/db/migrations/postgresql/`](../server/db/migrations/postgresql/)
are applied at build time, and on `pnpm dev`. To apply them by hand:

```bash
pnpm db:migrate
```

The driver is pinned in [`nuxt.config.ts`](../nuxt.config.ts) rather than
auto-detected. Left to itself, NuxtHub falls back to `pglite` when no URL is
set, and pglite's WebAssembly payload does not survive the bundling eve does to
run the agent — the failure surfaces much later as a missing `pglite.data`.

### `NUXT_PUBLIC_SITE_URL` (optional)

Canonical URL for SEO — used for Open Graph images, Twitter cards, and canonical links. Set to your production URL (e.g. `https://your-app.vercel.app`). Falls back to the request origin when unset.

## Authentication

### `BETTER_AUTH_SECRET` (required)

Random secret used by [Better Auth](https://www.better-auth.com/docs/installation#set-environment-variables) to sign sessions and tokens.

```bash
openssl rand -base64 32
```

### `BETTER_AUTH_URL` (required)

Public URL of the Nuxt app. Used for auth callbacks and as the base URL for agent → Nuxt internal API calls.

| Environment | Value |
|-------------|-------|
| Local | `http://localhost:3200` |
| Production | `https://your-domain.vercel.app` |

## Internal API

### `INTERNAL_API_SECRET` (required)

Shared bearer token between the Eve agent service and the Nuxt internal API (`/api/internal/*`).

Used for:

- Caller identity for the agent's session instructions
- Slack account linking
- Phone linking lookup

**Must be identical** on both Vercel services (`web` and `eve`). If missing or mismatched, Slack and phone linking will fail silently or return 401.

## Memory

Eve's `fileMemory()` provider keeps one document per user in the app's
Postgres table `memory_documents`, through `/api/internal/memory`. No extra
variables are needed beyond `DATABASE_URL` and `INTERNAL_API_SECRET`.

## Local model

The agent talks to the local inference layer (the Go service at the repo
root), which fronts llama.cpp. See [`agent/agent.ts`](../agent/agent.ts).

| Variable | Default | Purpose |
|----------|---------|---------|
| `INFERENCE_API_URL` | `http://127.0.0.1:9000/v1` | OpenAI-compatible endpoint of the inference layer |
| `INFERENCE_CONTEXT_TOKENS` | `32768` | Context window; must match llama-server's `-c` |

`INFERENCE_CONTEXT_TOKENS` also sizes the context meter in the chat composer.

## iMessage (optional)

iMessage runs through Photon and the bridge in
[`imessage-bridge/`](../../imessage-bridge), which reads this same `.env`.

| Variable | Purpose |
|----------|---------|
| `IMESSAGE_PROJECT_ID` | Photon project id |
| `IMESSAGE_PROJECT_SECRET` | Photon project secret |
| `IMESSAGE_AGENT_URL` | Agent origin the bridge posts to (default `http://localhost:3200`) |
| `IMESSAGE_BRIDGE_PORT` | Port of the bridge's local outbox (default `3201`) |

## Vercel Connect (optional)

Integrations use [Vercel Connect](https://vercel.com/docs/connect) — no extra env vars in this repo for Linear or GitHub OAuth, but you must:

1. Create Connect resources (GitHub, Linear MCP, Slack) in your Vercel team
2. Update connector UIDs in [`shared/connect.ts`](../shared/connect.ts) (GitHub) or [`agent/channels/slack.ts`](../agent/channels/slack.ts) (Slack, default: `slack/personal-agent-template`)
3. Connect clients in **Settings → Integrations** in the app

See [Customization](./CUSTOMIZATION.md#integrations) for setup steps.

## GitHub (optional)

GitHub tools use per-user OAuth via Vercel Connect. Connect in **Settings → Integrations**, then start a new chat session so GitHub tools load at `session.started`.

## Local-only files

These paths are gitignored and should never be committed:

| Path | Purpose |
|------|---------|
| `.env` | Local secrets |
| `.data/` | NuxtHub local state |
| `.eve/` | Eve dev cache |
| `.vercel/` | Vercel CLI link metadata |

Reset the database — destructive, it drops every table:

```bash
psql "$DATABASE_URL" -c 'drop schema public cascade; create schema public;'
pnpm db:migrate
```

Pointing `DATABASE_URL` at a fresh Neon branch does the same without dropping
anything.
