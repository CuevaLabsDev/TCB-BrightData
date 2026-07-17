# Agent Guide — Trading Card Block

## What this project is

**Trading Card Block** is the centralized hub for the Pokémon card market — price, liquidity, grades, creators, and alerts in one place. This repo is the whole system: a dedicated Supabase Postgres warehouse, a Python ingest pipeline, and a Next.js 16 web app. There is no dependency on a separate private repo.

## Stack

| Layer | Technology | Version |
|---|---|---|
| Web app | Next.js App Router | 16.2.6 |
| UI | React + Tailwind CSS | 19 / v4 |
| AI SDK | Vercel AI SDK | v6 |
| Database client | `postgres` (sql template) | ^3 |
| Database | Supabase Postgres + pgvector | — |
| Pipeline | Python 3.12 + psycopg3 | — |
| Charting | recharts | ^3 |

## Directory map

```
src/
  app/
    (app)/          — authenticated shell (layout + all pages)
      dashboard/    — market overview
      movers/       — top gainers/losers
      sets/         — set browser + /sets/[id]
      card/[id]/    — per-card detail
      creators/     — social creator feed
      alerts/       — signals feed
      agent/        — AI agent chat
    api/
      agent/        — streaming agent route (POST)
      search/       — full-text card search (GET ?q=)
      enrich/       — on-demand Bright Data enrichment (POST)
      cron/watch/   — signal generation cron handler (GET)
  lib/
    db.ts           — postgres client (SUPABASE_DB_URL, pooler-safe)
    queries.ts      — all warehouse read queries
    types.ts        — shared TypeScript types
    utils.ts        — shared utilities
    watcher.ts      — signal detection logic
    agent/
      featherless.ts  — Featherless/OpenAI-compatible model config
      tools.ts        — 8 agent tools (warehouse + Bright Data)
      system-prompt.ts
    bright-data/
      client.ts     — API key check + base fetch helper
      tcgplayer.ts  — TCGplayer liquidity scrape
      ebay.ts       — eBay PSA comps scrape
      enrich.ts     — enrichment orchestration
      social.ts     — social dataset scrape

pipeline/           — Python ingest (run from repo root)
  db.py             — psycopg3 helpers + schema apply
  catalog.py        — tcgcsv groups + products ingest
  prices.py         — archive ingest + --incremental daily upsert
  memory.py         — cognee market-memory build
  requirements.txt

.github/workflows/
  tcgcsv-daily.yml  — free GHA cron: catalog + prices --incremental

supabase/
  schema.sql        — canonical schema (apply with pipeline.db apply-schema)

scripts/
  run-brightdata-mcp.sh   — launch Bright Data MCP server
  seed-enrichment.mjs     — seed Bright Data enrichment for demo cards
  seed-social.mjs         — seed social data for demo cards
  smoke-*.mjs             — smoke tests for Bright Data routes
```

## Next.js version rules

**This is Next.js 16 with App Router.** APIs, conventions, and file structure differ from your training data. Before writing any Next.js code:

1. Check `node_modules/next/dist/docs/` for the current API reference.
2. Heed any deprecation notices — several patterns changed between 14→15→16.
3. Server Components are the default. Add `"use client"` only when state or browser APIs are required.
4. All database access must happen in Server Components or Route Handlers — never in Client Components.

## Database rules

- **Client**: `src/lib/db.ts` exports `sql` (tagged template) and `hasDb()`. Import from `@/lib/db`.
- **Server-only**: `db.ts` has `import "server-only"` — never import it from client code.
- **Pooler safety**: `prepare: false` and `fetch_types: false` are set on the client. Do not add prepared statements.
- **Env var**: `SUPABASE_DB_URL` (transaction pooler, port 6543 on Vercel; direct 5432 locally). Fallback: `DATABASE_URL`.
- **All queries** live in `src/lib/queries.ts`. Add new queries there, not inline in components.
- **Schema** is in `supabase/schema.sql`. If you modify the schema, update that file and document the change.

### Core tables

```
groups          — Pokemon sets
products        — Cards + sealed (is_sealed boolean)
daily_prices    — (product_id, sub_type, date) price facts
price_windows   — Precomputed 7/30/90/180d analytics per series
liquidity       — Bright Data: TCGplayer + eBay listing depth / velocity
graded_comps    — Bright Data: eBay PSA 9/10 sold comps + grade_multiple
creators        — Social creators with learned impact_score
posts           — Creator posts: sentiment, signal, mentioned_products[], embedding vector(384)
signals         — Alert feed: price_breakout|liquidity_spike|grade_arbitrage|creator_move
market_memory   — Cognee narratives with vector(384) embeddings
ingest_runs     — Pipeline bookkeeping
```

## Pipeline rules

- Run pipeline commands from the repo root: `python -m pipeline.db ping`
- Connection priority: `PIPELINE_DB_URL` > `SUPABASE_DB_URL` > `DATABASE_URL` (see `pipeline/db.py`)
- Bulk loads use psycopg `COPY` — use the session pooler URL (port 5432) for `PIPELINE_DB_URL`, not the transaction pooler
- Never run destructive pipeline operations (schema drops, table truncates) without explicit user confirmation
- **Daily tcgcsv refresh** runs on free GitHub Actions (`.github/workflows/tcgcsv-daily.yml`), not Vercel: `python -m pipeline.prices --incremental` downloads today's archive, upserts `daily_prices`, and recomputes `price_windows`. Requires the `PIPELINE_DB_URL` Actions secret (session pooler). Full truncate/reload remains a local backfill only (`python -m pipeline.prices`).

## Bright Data rules

- All Bright Data calls go through `src/lib/bright-data/client.ts` — check `hasBrightData()` before calling
- The `/request` endpoint takes a `body` field (JSON string) — see existing clients for the shape
- Social scrapes are expensive; use seed scripts for demo data and on-demand enrichment sparingly
- Bright Data MCP server config lives in `.cursor/mcp.json` — credentials are read from `.env.local` at runtime, not stored in the config file

## Agent rules

- Agent tools are in `src/lib/agent/tools.ts` — all 10 tools must return structured data only, never invented numbers
- The agent uses the Vercel AI SDK streaming response (`streamText`). Do not switch to non-streaming for the agent route.
- Tool names use snake_case to match OpenAI function-calling conventions
- `resolveCard()` in tools.ts prefers name search over productId — models hallucinate IDs

## Environment variables

```env
SUPABASE_DB_URL          # required — transaction pooler URL
PIPELINE_DB_URL          # session pooler for bulk COPY + GHA tcgcsv-daily secret
BRIGHT_DATA_API_KEY      # required for live enrichment
FEATHERLESS_API_KEY      # required for agent chat
FEATHERLESS_MODEL        # optional — any OpenAI-compatible model ID
```

## What NOT to do

- Do not add `"use client"` to files that touch the database
- Do not use `fetch` to call the Supabase REST API — use the `sql` template tag directly
- Do not create Supabase client objects (`createClient`) — this project uses direct Postgres via `postgres`
- Do not add `console.log` in Server Components or Route Handlers for production code
- Do not modify `supabase/schema.sql` without also confirming the pipeline and queries still align
- Do not use relative imports — use `@/lib/...` aliases
