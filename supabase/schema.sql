-- Trading Card Block — Agentic Enterprise Trading-Card Intelligence
-- Fresh Supabase (Postgres + pgvector) warehouse schema
-- Track 2 · Finance & Market Intelligence · Bright Data Web Data UNLOCKED
--
-- Apply with: python -m pipeline.db apply-schema   (or psql -f supabase/schema.sql)

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Catalog dimension
-- ---------------------------------------------------------------------------

-- Sets / groups (tcgcsv "groups", category 3 = Pokemon)
create table if not exists groups (
  group_id      integer primary key,
  category_id   integer not null default 3,
  name          text not null,
  abbreviation  text,
  published_on  timestamptz,
  modified_on   timestamptz
);

-- Products (singles + sealed). Price grain below also keys on sub_type.
create table if not exists products (
  product_id    integer primary key,
  group_id      integer references groups(group_id),
  category_id   integer not null default 3,
  name          text not null,
  clean_name    text,
  image_url     text,
  url           text,
  number        text,        -- extNumber e.g. 001/102
  rarity        text,        -- extRarity
  card_type     text,        -- extCardType
  hp            text,
  stage         text,
  is_sealed     boolean not null default false,
  modified_on   timestamptz
);
create index if not exists products_name_trgm on products using gin (name gin_trgm_ops);
create index if not exists products_group_idx on products (group_id);
create index if not exists products_rarity_idx on products (rarity);

-- ---------------------------------------------------------------------------
-- Daily price facts (grain: product + sub_type + date)
-- sub_type = Normal | Holofoil | Reverse Holofoil | 1st Edition Holofoil | ...
-- ---------------------------------------------------------------------------
create table if not exists daily_prices (
  product_id  integer not null,
  sub_type    text    not null default 'Normal',
  date        date    not null,
  low         numeric(12,2),
  mid         numeric(12,2),
  high        numeric(12,2),
  market      numeric(12,2),
  direct_low  numeric(12,2),
  primary key (product_id, sub_type, date)
);
create index if not exists daily_prices_date_idx on daily_prices (date);

-- Precomputed rolling windows + latest snapshot per (product, sub_type)
create table if not exists price_windows (
  product_id      integer not null,
  sub_type        text    not null default 'Normal',
  as_of           date    not null,
  market          numeric(12,2),
  chg_7d_pct      numeric(10,2),
  chg_30d_pct     numeric(10,2),
  chg_90d_pct     numeric(10,2),
  chg_180d_pct    numeric(10,2),
  market_7d_ago   numeric(12,2),
  market_30d_ago  numeric(12,2),
  market_90d_ago  numeric(12,2),
  market_180d_ago numeric(12,2),
  high_180d       numeric(12,2),
  low_180d        numeric(12,2),
  avg_market_30d  numeric(12,2),
  volatility_30d  numeric(10,4),   -- coefficient of variation over 30d
  data_points     integer,
  -- Movement-quality assessment (justified demand vs listing-driven parking).
  -- Computed by pipeline.movement; refined live by the agent's assess tool.
  movement_verdict    text,            -- justified|mixed|suspicious|likely_parking
  movement_confidence numeric(4,3),    -- 0-1 evidence-weighted confidence
  movement_codes      text[],          -- reason codes, e.g. {market_above_live_ask}
  primary key (product_id, sub_type)
);
-- Backfill columns on already-deployed warehouses (create table is a no-op there).
alter table price_windows add column if not exists movement_verdict    text;
alter table price_windows add column if not exists movement_confidence numeric(4,3);
alter table price_windows add column if not exists movement_codes      text[];
create index if not exists pw_chg7_idx   on price_windows (chg_7d_pct);
create index if not exists pw_chg30_idx  on price_windows (chg_30d_pct);
create index if not exists pw_chg90_idx  on price_windows (chg_90d_pct);
create index if not exists pw_market_idx on price_windows (market);
create index if not exists pw_movement_idx on price_windows (movement_verdict);

-- ---------------------------------------------------------------------------
-- Liquidity (Bright Data: tcgplayer sales-history + active listings, eBay)
-- ---------------------------------------------------------------------------
create table if not exists liquidity (
  product_id          integer not null,
  sub_type            text    not null default 'Normal',
  source              text    not null,           -- tcgplayer | ebay
  as_of               timestamptz not null default now(),
  active_listings     integer,
  total_quantity      integer,                     -- listing depth (sum of qty)
  avg_daily_qty_sold  numeric(12,2),
  total_qty_sold_90d  integer,
  total_txn_90d       integer,
  sold_velocity       numeric(12,2),               -- qty sold / day
  bid_ask_spread_pct  numeric(10,2),               -- (low active - last sold)/last sold
  liquidity_score     numeric(6,2),                -- 0-100 composite
  sellers             integer,
  consumption_rate    numeric(12,2),               -- sold qty / day
  replenishment_rate  numeric(12,2),               -- new listing qty / day (snapshot delta)
  absorption_ratio    numeric(12,4),               -- consumption / replenishment
  raw                 jsonb,
  primary key (product_id, sub_type, source)
);
-- Additive columns for warehouses created before absorption fields existed.
alter table liquidity add column if not exists sellers integer;
alter table liquidity add column if not exists consumption_rate numeric(12,2);
alter table liquidity add column if not exists replenishment_rate numeric(12,2);
alter table liquidity add column if not exists absorption_ratio numeric(12,4);

-- Daily (or on-demand) depth/velocity history for consumption vs replenishment.
create table if not exists liquidity_snapshots (
  id                  bigserial primary key,
  product_id          integer not null,
  sub_type            text    not null default 'Normal',
  source              text    not null default 'tcgplayer',
  as_of               timestamptz not null default now(),
  active_listings     integer,
  total_quantity      integer,
  sellers             integer,
  sold_velocity       numeric(12,2),
  total_qty_sold_90d  integer,
  bid_ask_spread_pct  numeric(10,2),
  liquidity_score     numeric(6,2),
  listings_delta      integer,
  qty_delta           integer,
  consumption_rate    numeric(12,2),
  replenishment_rate  numeric(12,2),
  absorption_ratio    numeric(12,4)
);
create index if not exists liq_snap_product_asof
  on liquidity_snapshots (product_id, sub_type, as_of desc);
create index if not exists liq_asof_idx on liquidity (as_of);
create index if not exists liq_score_idx on liquidity (liquidity_score desc nulls last);

-- Set heat + budgeted scrape queue for cost-capped liquidity activation.
-- Ranked from free tcgcsv price_windows; Bright Data only scrapes the queue.
create table if not exists set_heat (
  group_id    integer primary key references groups(group_id),
  as_of       date    not null,
  heat_score  numeric(6,2) not null,
  metrics     jsonb
);
create index if not exists set_heat_score_idx on set_heat (heat_score desc);

create table if not exists liquidity_scrape_queue (
  product_id  integer not null,
  sub_type    text    not null default 'Normal',
  tier        text    not null,                     -- trend | spotlight
  score       numeric(10,2) not null,
  group_id    integer references groups(group_id),
  queued_for  date    not null,
  status      text    not null default 'pending',   -- pending|running|done|error|skipped
  created_at  timestamptz not null default now(),
  primary key (product_id, sub_type, tier, queued_for)
);
create index if not exists liq_queue_day_status_idx
  on liquidity_scrape_queue (queued_for, status, tier);
create index if not exists liq_queue_group_idx
  on liquidity_scrape_queue (group_id, queued_for);

-- ---------------------------------------------------------------------------
-- Graded (PSA) comps + raw -> graded spread  (the alt-asset alpha)
-- ---------------------------------------------------------------------------
create table if not exists graded_comps (
  id             bigserial primary key,
  product_id     integer not null,
  grader         text not null default 'PSA',
  grade          integer not null,                 -- 9, 10, ...
  source         text not null default 'ebay',
  as_of          timestamptz not null default now(),
  sample_size    integer,
  avg_sold       numeric(12,2),                    -- mean of outlier-filtered solds
  last_sold      numeric(12,2),                    -- converged market = trimmed median
  low_sold       numeric(12,2),
  high_sold      numeric(12,2),
  raw_market     numeric(12,2),                    -- raw NM market at comp time
  grade_multiple numeric(10,2),                    -- last_sold (median) / raw_market
  sold_per_day   numeric(12,2),                    -- eBay PSA sold velocity
  sold_per_month numeric(12,2),                    -- sold_per_day * 30
  raw            jsonb
);
-- Additive columns for warehouses created before velocity fields existed.
alter table graded_comps add column if not exists sold_per_day numeric(12,2);
alter table graded_comps add column if not exists sold_per_month numeric(12,2);
create index if not exists graded_product_idx on graded_comps (product_id);
create index if not exists graded_asof_idx on graded_comps (as_of desc);

-- ---------------------------------------------------------------------------
-- Creators + posts (Bright Data social datasets) and their market impact
-- ---------------------------------------------------------------------------
create table if not exists creators (
  id           bigserial primary key,
  handle       text not null,
  platform     text not null,                      -- instagram|tiktok|youtube|x|reddit
  display_name text,
  followers    bigint,
  url          text,
  impact_score numeric(6,2) not null default 0,    -- learned market-moving power
  flagged      boolean not null default false,
  watchlisted  boolean not null default false,     -- on the curated monitoring list
  tier         text,                               -- tier1 (Triggerware pulse) | tier2
  last_scanned_at timestamptz,                      -- last account-scoped scan
  created_at   timestamptz not null default now(),
  unique (platform, handle)
);

create table if not exists posts (
  id                 bigserial primary key,
  creator_id         bigint references creators(id),
  platform           text not null,
  post_url           text unique,
  posted_at          timestamptz,
  caption            text,
  likes              bigint,
  comments           bigint,
  views              bigint,
  sentiment          text,                          -- bullish|bearish|neutral
  signal             text,                          -- buy|sell|hold|hype
  mentioned_products integer[],
  mentioned_sets     text[],
  summary            text,
  transcript         text,                          -- spoken video content (YouTube/TikTok)
  content_source     text,                          -- caption | transcript | both
  impact_pct         numeric(10,2),                 -- measured subsequent move
  embedding          vector(384),
  raw                jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists posts_posted_idx on posts (posted_at desc);
create index if not exists posts_creator_idx on posts (creator_id);

-- Idempotent migrations for warehouses created before the watchlist layer.
alter table creators add column if not exists watchlisted boolean not null default false;
alter table creators add column if not exists tier text;
alter table creators add column if not exists last_scanned_at timestamptz;
alter table posts add column if not exists transcript text;
alter table posts add column if not exists content_source text;

-- ---------------------------------------------------------------------------
-- Signals / alerts — the live trigger feed (Vercel Cron writes here)
-- ---------------------------------------------------------------------------
create table if not exists signals (
  id          bigserial primary key,
  kind        text not null,                        -- creator_move|price_breakout|liquidity_spike|grade_arbitrage
  severity    text not null default 'info',         -- info|watch|act
  product_id  integer,
  sub_type    text,
  creator_id  bigint,
  title       text not null,
  body        text,
  metrics     jsonb,
  links       jsonb,                                -- actionable listing links
  status      text not null default 'new',          -- new|seen|dismissed
  created_at  timestamptz not null default now()
);
create index if not exists signals_created_idx on signals (created_at desc);
create index if not exists signals_sev_idx on signals (severity);

-- ---------------------------------------------------------------------------
-- Market memory — the agent's learned domain experience (cognee output)
-- ---------------------------------------------------------------------------
create table if not exists market_memory (
  id           bigserial primary key,
  scope        text not null,                       -- market | set:<id> | product:<id>
  period_start date,
  period_end   date,
  title        text,
  narrative    text not null,
  tags         text[],
  embedding    vector(384),
  metrics      jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists mm_scope_idx on market_memory (scope);
create index if not exists mm_embedding_idx on market_memory using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping
-- ---------------------------------------------------------------------------
create table if not exists ingest_runs (
  id          bigserial primary key,
  kind        text not null,                        -- catalog|daily_prices|windows|liquidity|graded|social|memory|reddit|reddit_corr
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',      -- running|ok|error
  rows        bigint default 0,
  detail      jsonb
);

-- ---------------------------------------------------------------------------
-- Reddit market-signal layer (Bright Data Web Unlocker -> reddit .json)
--
-- The hypothesis engine: synthesize subreddit threads + comments at DAY grain,
-- extract per-card mentions, then correlate each social spike (lead) against
-- subsequent per-day price movement (lag) on TCGplayer + eBay. Replaces the
-- shallow creator-impact proxy with a causal, day-resolved model.
-- Populated by scripts/ingest-reddit.mjs (raw + mentions) and
-- pipeline/reddit_corr.py (daily rollup + correlation).
-- ---------------------------------------------------------------------------

-- Raw subreddit threads (one row per post).
create table if not exists reddit_threads (
  thread_id    text primary key,                    -- reddit id36 (e.g. 1krrr8k)
  subreddit    text not null,
  url          text unique,
  author       text,
  title        text,
  selftext     text,
  score        integer,
  num_comments integer,
  sentiment    text,                                -- bullish|bearish|neutral (Featherless, thread-level)
  signal       text,                                -- buy|sell|hold|hype
  created_at   timestamptz,                         -- reddit created_utc
  raw          jsonb,
  ingested_at  timestamptz not null default now()
);
create index if not exists reddit_threads_created_idx on reddit_threads (subreddit, created_at desc);

-- Raw comments (fanned out from a thread's permalink .json).
create table if not exists reddit_comments (
  comment_id  text primary key,                     -- reddit comment id36
  thread_id   text references reddit_threads(thread_id),
  author      text,
  body        text,
  score       integer,
  created_at  timestamptz,
  raw         jsonb
);
create index if not exists reddit_comments_thread_idx on reddit_comments (thread_id);
create index if not exists reddit_comments_created_idx on reddit_comments (created_at);

-- One row per (thread|comment) x mentioned product. The atomic social fact.
create table if not exists reddit_mentions (
  id           bigserial primary key,
  source_type  text not null,                       -- thread | comment
  source_id    text not null,                       -- reddit_threads.thread_id | reddit_comments.comment_id
  product_id   integer not null,
  subreddit    text,
  score        integer,                             -- upvotes of the source unit (engagement weight)
  sentiment    text,                                -- inherited thread sentiment
  mentioned_on date not null,                       -- created_at::date (the lead day)
  created_at   timestamptz not null default now(),
  unique (source_type, source_id, product_id)
);
create index if not exists reddit_mentions_product_day_idx on reddit_mentions (product_id, mentioned_on);

-- Per-card-per-day social aggregate (written by pipeline.reddit_corr).
create table if not exists reddit_card_daily (
  product_id       integer not null,
  day              date not null,
  mention_count    integer not null default 0,      -- total mentions (thread + comment)
  comment_mentions integer not null default 0,
  total_score      integer not null default 0,      -- summed upvotes (engagement)
  distinct_authors integer not null default 0,
  bullish_ratio    numeric(5,3),                    -- bullish mentions / total
  weighted_score   numeric(12,2),                   -- mention_count + log-weighted upvotes
  primary key (product_id, day)
);
create index if not exists reddit_card_daily_day_idx on reddit_card_daily (day);

-- Per-card-per-day eBay realized sold (bounded to Reddit-mentioned cards).
create table if not exists ebay_sold_daily (
  product_id   integer not null,
  sub_type     text not null default 'Normal',
  sold_date    date not null,
  n_sold       integer,
  median_price numeric(12,2),
  avg_price    numeric(12,2),
  primary key (product_id, sub_type, sold_date)
);
create index if not exists ebay_sold_daily_product_idx on ebay_sold_daily (product_id, sold_date);

-- Lead->lag correlation findings: a social spike day and what price did after.
create table if not exists social_price_corr (
  id            bigserial primary key,
  product_id    integer not null,
  event_date    date not null,                      -- the social spike day (lead)
  social_score  numeric(12,2),                      -- weighted_score on the event day
  social_z      numeric(8,3),                       -- z-score vs the card's own baseline
  tcg_chg_1d    numeric(10,2),                      -- TCGplayer market % change D -> D+1
  tcg_chg_3d    numeric(10,2),
  tcg_chg_7d    numeric(10,2),
  ebay_chg_7d   numeric(10,2),                      -- eBay sold median % change D -> D+7
  preceded      boolean,                            -- did price rise after the spike?
  corr_strength numeric(8,3),                       -- forward move magnitude * social_z
  top_thread_url text,
  created_at    timestamptz not null default now(),
  unique (product_id, event_date)
);
create index if not exists social_price_corr_product_idx on social_price_corr (product_id);
create index if not exists social_price_corr_strength_idx on social_price_corr (corr_strength desc);

-- ---------------------------------------------------------------------------
-- Data API lockdown — warehouse is server-only via SUPABASE_DB_URL / PIPELINE_DB_URL.
-- Revoke PostgREST roles; enable RLS with no anon/authenticated policies.
-- Do not add open TO anon / TO authenticated policies.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on routines from anon, authenticated;

alter table groups enable row level security;
alter table products enable row level security;
alter table daily_prices enable row level security;
alter table price_windows enable row level security;
alter table liquidity enable row level security;
alter table liquidity_snapshots enable row level security;
alter table set_heat enable row level security;
alter table liquidity_scrape_queue enable row level security;
alter table graded_comps enable row level security;
alter table creators enable row level security;
alter table posts enable row level security;
alter table signals enable row level security;
alter table market_memory enable row level security;
alter table ingest_runs enable row level security;
alter table reddit_threads enable row level security;
alter table reddit_comments enable row level security;
alter table reddit_mentions enable row level security;
alter table reddit_card_daily enable row level security;
alter table ebay_sold_daily enable row level security;
alter table social_price_corr enable row level security;
