# Trading Card Block — The Central Hub for the Card Market

> **Bright Data "Web Data UNLOCKED" Hackathon · Track 2 — Finance & Market Intelligence**
> Powered by **Bright Data** (live web) + **Featherless AI** (open-source inference) + **cognee** (agent memory)

**Repository:** [github.com/CuevaLabsDev/TCB-BrightData](https://github.com/CuevaLabsDev/TCB-BrightData) · **Live demo:** [trading-card-block.vercel.app](https://trading-card-block.vercel.app) · **Submission pack:** [`submission/`](submission/)

**Trading Card Block** is where the Pokémon card market lives in one place. Pricing, liquidity,
grading spreads, and creator sentiment are scattered across TCGplayer, eBay, and social — TCB
pulls them into a single source of truth so operators can answer: *what's moving, what's liquid,
what to grade, who's about to move the market — and act now.*

Five live data layers feed the hub. An AI analyst sits on top, reasons across all of them, and
never invents a number.

---

## Why this is Track 2 (Finance & Market Intelligence)

Graded trading cards are a **multi-billion-dollar alternative asset class** with no single market
hub. Pricing, liquidity, and "alpha" live scattered across TCGplayer, eBay, and social — exactly
the kind of real-time web data that pricing/risk/procurement teams need. **Trading Card Block**
unifies it:

| Operator | Decision it powers |
|---|---|
| **Card dealers / LGS** | Reprice inventory against live cross-market data + momentum |
| **Grading ops** | Submit/hold: raw → PSA 10 **grade multiple** weighted by liquidity |
| **Marketplace sellers** | Time listings using liquidity score + creator sentiment |
| **Funds / insurers** | Value card portfolios with cited, dated, multi-source data |

---

## The five intelligence layers (all live)

1. **Price history & analytics** — 2 years of daily TCGplayer prices ingested from the
   `tcgcsv` archives → **1.9M daily price rows** and **44,419 precomputed analytics series**
   (7 / 30 / 90 / 180-day % change, 30-day volatility, 180-day high/low) across **32,047
   products** in **216 sets**.
2. **Raw → PSA grade arbitrage** — **Bright Data** scrapes eBay PSA 9/10 realized sold comps;
   we compute the **grade multiple** (e.g. *Moonbreon* raw $1,570 → PSA 10 $5,225 = **3.33×**).
3. **Liquidity** — **Bright Data** reaches TCGplayer's internal JSON APIs (listing depth, seller
   count, weekly sold velocity, bid/ask spread) → a **0–100 liquidity score**. This is what
   separates a real "submit to grade" call (liquid) from a value trap (illiquid).
4. **Creator sentiment** — a **curated watchlist** of verified creators
   ([`src/lib/social/watchlist.ts`](src/lib/social/watchlist.ts)) is scanned account-by-account via
   **Bright Data Web Data scrapers** — including **full YouTube transcripts**, so sentiment runs over
   what creators actually *say*, not just captions. **Featherless** scores sentiment/signal and
   extracts mentioned cards; we correlate posts to subsequent price moves and **rank creators by
   measured market impact**. A 4h cron does a full scan; a 15m **Triggerware** pulse on tier1
   creators triggers targeted scrapes the moment a new post appears.
5. **Market memory (cognee)** — a **cognee** knowledge graph + pgvector store of how the market
   has shifted. The agent recalls narrative context ("Prismatic Evolutions chase cards ran in
   Q1") — its learned domain experience.

On top: a **Featherless agent** with 10 tools across all five layers, and a **live trigger engine**
(Vercel Cron) that fires alerts — *"creator just posted → act now"* — with actionable listing links.

---

## Architecture

```
┌──────────────────────────┐      ┌─────────────────────────────────────────┐
│  Python pipeline          │      │  Next.js 16 app (Vercel)                 │
│  (pipeline/, uv · 3.12)   │      │                                          │
│                           │      │  /dashboard  market overview             │
│  tcgcsv archives ─┐       │      │  /movers     gainers / losers            │
│  (2yr daily, local)│      │      │  /sets       set leaderboard + detail    │
│                    ▼      │      │  /card/[id]  price chart · raw→PSA ·      │
│  catalog.py  prices.py    │      │              liquidity · creator feed    │
│  social.py   memory.py    │      │  /creators   impact leaderboard + posts  │
│         │                 │      │  /alerts     live signal feed            │
│         ▼                 │      │  /agent      Featherless chat (10 tools) │
│   Supabase Postgres ◄─────┼──────┤  src/lib/db.ts  (postgres.js)            │
│   + pgvector              │      │  src/lib/bright-data/  (SERP+Unlocker)   │
│   (11 tables)             │      │  src/lib/agent/ (Featherless + tools)    │
└──────────────────────────┘      │  /api/cron/watch  ← Vercel Cron (6h)     │
                                   └─────────────────────────────────────────┘
        Bright Data  ───────────────►  TCGplayer JSON APIs · eBay sold comps · social SERP
        Featherless  ───────────────►  agent tool-calling · sentiment + memory extraction
```

### Bright Data is the live-web engine

Every public-web call routes through `src/lib/bright-data/client.ts`:

- **SERP API** — structured Google results to discover creator posts + product pages.
- **Web Unlocker** — bypasses DataDome/bot protection to reach:
  - TCGplayer internal JSON (`mp-search-api` details + listings, `infinite-api` sales history) —
    clean structured data, **no Playwright**.
  - eBay sold-listing pages for PSA graded comps.

> The request shapes for the TCGplayer internal APIs were validated live (see
> `scripts/smoke-*.mjs`). The key insight: Web Unlocker turns a fragile,
> Playwright-and-stealth-cookies scrape into a plain authenticated JSON fetch.

### Featherless is the inference engine

OpenAI-compatible, used for **both** the agent and structured extraction:

- **Agent** — `Qwen/Qwen3-14B` (Featherless trains the Qwen3 family + Kimi-K2 for function
  calling). Multi-step tool loop via the Vercel AI SDK; `/no_think` keeps latency ~8–15s.
- **Extraction** — `Qwen2.5-7B` with `response_format: json_object` for sentiment + narratives.

### cognee is the memory engine

`pipeline/memory.py` builds market narratives into a cognee knowledge graph with Fastembed
(384-dim) embeddings, persisted to `market_memory` with pgvector for semantic recall.

---

## Live dataset (current)

| Table | Rows | Source |
|---|---:|---|
| `groups` (sets) | 216 | tcgcsv catalog API |
| `products` | 32,047 | tcgcsv catalog API |
| `daily_prices` | 1,899,491 | local tcgcsv archives (180d depth) |
| `price_windows` | 44,419 | computed (7/30/90/180d, vol, hi/lo) |
| `liquidity` | live | Bright Data → TCGplayer |
| `graded_comps` | live | Bright Data → eBay PSA |
| `creators` / `posts` | live | Bright Data SERP + Featherless |
| `signals` | live | watcher (Vercel Cron) |
| `market_memory` | live | cognee + Fastembed |

---

## Run it locally

### 1. App

```bash
npm install
cp .env.example .env.local        # fill in Supabase / Bright Data / Featherless
npm run dev                       # http://localhost:3000
```

### 2. Pipeline (Python)

```bash
uv venv pipeline/.venv --python 3.12
uv pip install --python pipeline/.venv/bin/python -r pipeline/requirements.txt

pipeline/.venv/bin/python -m pipeline.db apply-schema   # create tables
pipeline/.venv/bin/python -m pipeline.catalog           # 216 sets, 32k products
pipeline/.venv/bin/python -m pipeline.prices            # daily prices + windows
```

### 3. Enrich demo cards + memory (live Bright Data + Featherless)

```bash
node scripts/seed-enrichment.mjs    # liquidity + PSA comps for hero cards
node scripts/seed-social.mjs        # creator posts + sentiment
pipeline/.venv/bin/python -m pipeline.memory   # cognee market memory
```

### 4. Live creator watchlist (Bright Data Web Data + transcripts)

The watchlist of verified creators lives in [`src/lib/social/watchlist.ts`](src/lib/social/watchlist.ts).
Run a full account-scoped scan (drives the real `/api/cron/social` code path against a running app):

```bash
npm run dev                          # in one terminal
node scripts/scan-watchlist.mjs      # scans watchlist, prints posts + transcript status
```

Crons (configured in [`vercel.json`](vercel.json)):

| Route | Schedule (Hobby) | Pro cadence | Job |
|-------|------------------|-------------|-----|
| `/api/cron/social` | daily 08:00 | every 4h | Full watchlist scan + impact correlation + signals |
| `/api/cron/triggerware` | daily 07:00 | every 15m | Poll tier1 Triggerware triggers → targeted scrape on deltas |
| `/api/cron/watch` | daily 09:00 | — | Price-breakout / grade / creator signal pass |

> Vercel **Hobby** caps cron jobs at once per day. The schedules above are Hobby-safe; on **Pro**,
> restore the higher cadence in [`vercel.json`](vercel.json) (`0 */4 * * *` and `*/15 * * * *`). The
> routes also accept on-demand `POST` (guarded by `CRON_SECRET`) for an external scheduler.

### 5. Triggerware tier1 pulse (optional accelerator)

```bash
# In the Triggerware console: install the catalog social connector(s) + platform keys.
node scripts/setup-triggerware.mjs   # one trigger per tier1 watchlist creator
node scripts/verify-triggerware.mjs  # connectivity + double-poll smoke test (exit 0 = ready)
```

---

## Key engineering decisions

- **Session pooler, not transaction pooler.** Supabase's transaction pooler (6543) hangs
  postgres.js parameterized queries (it reassigns the backend per statement). The **session
  pooler (5432)** holds the connection for the session, so `$1` binds work. `db.ts` also sets
  `prepare: false` + `fetch_types: false`.
- **Tiny-denominator guard.** Percent-change math ignores sub-$1 baselines — otherwise a
  pre-release placeholder price turns into a fake "+90,000%" mover.
- **Function-calling model matters.** Only Featherless's Qwen3 family + Kimi-K2 are trained for
  tools; Qwen2.5 emits a call but stalls the multi-step loop. We use `generateText` (not
  `streamText`) because Featherless streams tool calls in a Hermes format the AI SDK's streaming
  parser doesn't finalize for execution.

---

## Hackathon checklist

- ✅ **Uses a Bright Data product** — SERP API + Web Unlocker + Web Data datasets, central to liquidity, graded
  comps, and creator discovery.
- ✅ **Featherless partner** — agent tool-calling + extraction on open-source models.
- ✅ **Track 2 fit** — a unified market hub with real-time financial intelligence for an alt-asset class.
- ✅ **Working product** — full ingest, 5 live data layers, agent, live alerts, deployed.
- 📦 **Submission assets** — PDF deck, cover, and video: see [`submission/README.md`](submission/README.md). Generate with `npm run submission:slides`, `submission:voice`, `submission:video`.

## License

MIT
