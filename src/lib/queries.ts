import "server-only";
import { sql } from "./db";
import { toIsoDateOnly } from "./utils";
import type {
  CardSummary,
  CreatorPost,
  GradedComp,
  Liquidity,
  MarketMemory,
  MarketStats,
  PricePoint,
  SetSummary,
  Signal,
} from "./types";

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toCardSummary(r: Record<string, unknown>): CardSummary {
  return {
    productId: Number(r.product_id),
    subType: String(r.sub_type ?? "Normal"),
    name: String(r.name ?? ""),
    cleanName: (r.clean_name as string) ?? null,
    imageUrl: (r.image_url as string) ?? null,
    groupId: r.group_id ? Number(r.group_id) : null,
    setName: (r.set_name as string) ?? null,
    setAbbr: (r.set_abbr as string) ?? null,
    number: (r.number as string) ?? null,
    rarity: (r.rarity as string) ?? null,
    cardType: (r.card_type as string) ?? null,
    url: (r.url as string) ?? null,
    isSealed: Boolean(r.is_sealed),
    market: num(r.market),
    chg7d: num(r.chg_7d_pct),
    chg30d: num(r.chg_30d_pct),
    chg90d: num(r.chg_90d_pct),
    chg180d: num(r.chg_180d_pct),
    high180d: num(r.high_180d),
    low180d: num(r.low_180d),
    volatility30d: num(r.volatility_30d),
    movementVerdict: (r.movement_verdict as string) ?? null,
  };
}

// Lazy fragment: evaluating `sql`...`` at module scope would construct the DB
// client at import time (and crash the build when env vars aren't present).
// Calling cardSelect() defers that to request time.
const cardSelect = () => sql`
  select
    p.product_id, w.sub_type, p.name, p.clean_name, p.image_url,
    p.group_id, g.name as set_name, g.abbreviation as set_abbr,
    p.number, p.rarity, p.card_type, p.url, p.is_sealed,
    w.market, w.chg_7d_pct, w.chg_30d_pct, w.chg_90d_pct, w.chg_180d_pct,
    w.high_180d, w.low_180d, w.volatility_30d, w.movement_verdict
  from price_windows w
  join products p on p.product_id = w.product_id
  left join groups g on g.group_id = p.group_id
`;

export async function getMarketStats(): Promise<MarketStats> {
  // Single round-trip — running these as parallel queries over the transaction
  // pooler (pool max 3) intermittently corrupts postgres.js connection state
  // ("Cannot read properties of undefined (reading 'length')").
  const rows = await sql`
    select
      (select count(*)::int from products) as products,
      (select count(*)::int from groups) as sets,
      (select count(*)::int from price_windows) as tracked_series,
      (select max(as_of) from price_windows) as as_of,
      (select coalesce(sum(market),0) from price_windows w
         where not exists (select 1 from products p
           where p.product_id = w.product_id and p.is_sealed)) as total_market,
      (select reltuples::bigint from pg_class where relname='daily_prices') as daily_rows
  `;
  const r = rows[0] ?? {};
  return {
    products: Number(r.products ?? 0),
    sets: Number(r.sets ?? 0),
    trackedSeries: Number(r.tracked_series ?? 0),
    dailyRows: Number(r.daily_rows ?? 0),
    asOf: toIsoDateOnly(r.as_of),
    totalMarketValue: num(r.total_market),
  };
}

export interface MoverOpts {
  period?: "7d" | "30d" | "90d" | "180d";
  direction?: "up" | "down";
  limit?: number;
  minMarket?: number;
  sealedOnly?: boolean;
  singlesOnly?: boolean;
  /** Include cards whose move was flagged as listing-driven parking. Default false. */
  includeParked?: boolean;
}

export async function getTopMovers(opts: MoverOpts = {}): Promise<CardSummary[]> {
  const {
    period = "7d",
    direction = "up",
    limit = 20,
    minMarket = 5,
    sealedOnly = false,
    singlesOnly = true,
    includeParked = false,
  } = opts;
  const col = {
    "7d": sql`w.chg_7d_pct`,
    "30d": sql`w.chg_30d_pct`,
    "90d": sql`w.chg_90d_pct`,
    "180d": sql`w.chg_180d_pct`,
  }[period];
  const order = direction === "up" ? sql`desc` : sql`asc`;
  const sealedFilter = sealedOnly
    ? sql`and p.is_sealed`
    : singlesOnly
      ? sql`and not p.is_sealed`
      : sql``;
  // Hide listing-driven parking / suspicious spikes from the movers board so a
  // thin card re-listed high doesn't masquerade as a top gainer.
  const parkedFilter = includeParked
    ? sql``
    : sql`and (w.movement_verdict is null
              or w.movement_verdict not in ('suspicious', 'likely_parking'))`;

  const rows = await sql`
    ${cardSelect()}
    where w.market >= ${minMarket} and ${col} is not null
      and w.data_points >= 5 ${sealedFilter} ${parkedFilter}
    order by ${col} ${order}
    limit ${limit}
  `;
  return rows.map(toCardSummary);
}

export async function searchCards(
  query: string,
  limit = 30,
): Promise<CardSummary[]> {
  const q = query.trim();
  if (!q) return [];

  // Tokenized AND match so "Umbreon ex 161" matches "Umbreon ex - 161/131".
  // Each token uses ilike against the GIN trigram index on products.name; the
  // first token (usually the Pokémon name) is the most selective. We order by
  // a cheap prefix-match flag + market, avoiding a per-row similarity() scan.
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 5);
  if (tokens.length === 0) return [];

  let whereTokens = sql`p.name ilike ${"%" + tokens[0] + "%"}`;
  for (const t of tokens.slice(1)) {
    whereTokens = sql`${whereTokens} and p.name ilike ${"%" + t + "%"}`;
  }

  const rows = await sql`
    ${cardSelect()}
    where ${whereTokens}
    order by (p.name ilike ${q + "%"}) desc, w.market desc nulls last
    limit ${limit}
  `;
  return rows.map(toCardSummary);
}

export async function getCard(
  productId: number,
  subType?: string,
): Promise<CardSummary | null> {
  const rows = subType
    ? await sql`${cardSelect()} where w.product_id = ${productId} and w.sub_type = ${subType} limit 1`
    : await sql`${cardSelect()} where w.product_id = ${productId} order by w.market desc nulls last limit 1`;
  return rows[0] ? toCardSummary(rows[0]) : null;
}

export async function getCardVariants(productId: number): Promise<CardSummary[]> {
  const rows = await sql`${cardSelect()} where w.product_id = ${productId} order by w.market desc nulls last`;
  return rows.map(toCardSummary);
}

export async function getPriceHistory(
  productId: number,
  subType: string,
  days = 180,
): Promise<PricePoint[]> {
  // The displayed sub_type comes from price_windows (e.g. "Holofoil"), but
  // daily_prices may key the same product under a different sub_type (commonly
  // "Normal"). Prefer the requested sub_type; otherwise fall back to the
  // product's most-populated daily series. Anchor the window to the latest
  // AVAILABLE date (the warehouse archive can be stale), not current_date, so a
  // stale warehouse still renders a full chart.
  const rows = await sql`
    with picked as (
      select sub_type
      from daily_prices
      where product_id = ${productId}
      group by sub_type
      order by (sub_type = ${subType}) desc, count(*) desc
      limit 1
    ),
    bounds as (
      select max(dp.date) as max_date
      from daily_prices dp, picked
      where dp.product_id = ${productId} and dp.sub_type = picked.sub_type
    )
    select dp.date, dp.low, dp.mid, dp.high, dp.market
    from daily_prices dp, picked, bounds
    where dp.product_id = ${productId}
      and dp.sub_type = picked.sub_type
      and dp.date >= bounds.max_date - ${days}::int
    order by dp.date asc
  `;
  return rows.map((r) => ({
    date: toIsoDateOnly(r.date) ?? String(r.date),
    low: num(r.low),
    mid: num(r.mid),
    high: num(r.high),
    market: num(r.market),
  }));
}

export async function getSets(limit = 60): Promise<SetSummary[]> {
  const rows = await sql`
    select g.group_id, g.name, g.abbreviation, g.published_on,
      count(distinct w.product_id)::int card_count,
      round(avg(w.market)::numeric, 2) avg_market,
      round(sum(w.market)::numeric, 2) total_market,
      round(avg(w.chg_30d_pct)::numeric, 2) avg_chg_30d
    from groups g
    join products p on p.group_id = g.group_id and not p.is_sealed
    join price_windows w on w.product_id = p.product_id
    where w.market is not null
    group by g.group_id, g.name, g.abbreviation, g.published_on
    order by total_market desc nulls last
    limit ${limit}
  `;
  return rows.map((r) => ({
    groupId: Number(r.group_id),
    name: String(r.name),
    abbreviation: (r.abbreviation as string) ?? null,
    publishedOn: toIsoDateOnly(r.published_on),
    cardCount: Number(r.card_count),
    avgMarket: num(r.avg_market),
    totalMarket: num(r.total_market),
    avgChg30d: num(r.avg_chg_30d),
  }));
}

export async function getSet(groupId: number) {
  const rows = await sql`select group_id, name, abbreviation, published_on from groups where group_id = ${groupId}`;
  if (!rows[0]) return null;
  return {
    groupId: Number(rows[0].group_id),
    name: String(rows[0].name),
    abbreviation: (rows[0].abbreviation as string) ?? null,
    publishedOn: toIsoDateOnly(rows[0].published_on),
  };
}

export async function getSetCards(
  groupId: number,
  limit = 300,
): Promise<CardSummary[]> {
  const rows = await sql`
    ${cardSelect()}
    where p.group_id = ${groupId} and not p.is_sealed
    order by w.market desc nulls last
    limit ${limit}
  `;
  return rows.map(toCardSummary);
}

// ---- Liquidity / graded / social / signals / memory --------------------

export async function getLiquidity(productId: number): Promise<Liquidity[]> {
  const rows = await sql`
    select * from liquidity where product_id = ${productId} order by source
  `;
  return rows.map((r) => ({
    productId: Number(r.product_id),
    subType: String(r.sub_type),
    source: String(r.source),
    activeListings: num(r.active_listings),
    totalQuantity: num(r.total_quantity),
    avgDailyQtySold: num(r.avg_daily_qty_sold),
    totalQtySold90d: num(r.total_qty_sold_90d),
    soldVelocity: num(r.sold_velocity),
    bidAskSpreadPct: num(r.bid_ask_spread_pct),
    liquidityScore: num(r.liquidity_score),
    asOf: toIsoTimestamp(r.as_of),
  }));
}

export interface StoredMovement {
  verdict: string | null;
  confidence: number | null;
  codes: string[];
}

/** Precomputed movement-quality verdict written by `pipeline.movement`. */
export async function getStoredMovement(
  productId: number,
  subType: string,
): Promise<StoredMovement | null> {
  const rows = await sql`
    select movement_verdict, movement_confidence, movement_codes
    from price_windows
    where product_id = ${productId} and sub_type = ${subType}
    limit 1
  `;
  if (!rows[0]) return null;
  return {
    verdict: (rows[0].movement_verdict as string) ?? null,
    confidence: num(rows[0].movement_confidence),
    codes: (rows[0].movement_codes as string[]) ?? [],
  };
}

/** Highest impact score among bullish buy/hype creator posts on a card. */
export async function getBullishCreatorImpact(
  productId: number,
): Promise<number | null> {
  const rows = await sql`
    select max(c.impact_score) as impact
    from posts po
    join creators c on c.id = po.creator_id
    where ${productId} = any(po.mentioned_products)
      and po.sentiment = 'bullish' and po.signal in ('buy', 'hype')
  `;
  return num(rows[0]?.impact);
}

export async function getGradedComps(productId: number): Promise<GradedComp[]> {
  const rows = await sql`
    select distinct on (grade) product_id, grader, grade, sample_size, avg_sold,
      last_sold, raw_market, grade_multiple, as_of
    from graded_comps where product_id = ${productId}
    order by grade desc, as_of desc
  `;
  return rows.map((r) => ({
    productId: Number(r.product_id),
    grader: String(r.grader),
    grade: Number(r.grade),
    sampleSize: num(r.sample_size),
    avgSold: num(r.avg_sold),
    lastSold: num(r.last_sold),
    rawMarket: num(r.raw_market),
    gradeMultiple: num(r.grade_multiple),
    asOf: toIsoTimestamp(r.as_of),
  }));
}

export async function getRecentSignals(limit = 30): Promise<Signal[]> {
  const rows = await sql`
    select * from signals order by created_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    severity: String(r.severity) as Signal["severity"],
    productId: r.product_id ? Number(r.product_id) : null,
    subType: (r.sub_type as string) ?? null,
    creatorId: r.creator_id ? Number(r.creator_id) : null,
    title: String(r.title),
    body: (r.body as string) ?? null,
    metrics: (r.metrics as Record<string, unknown>) ?? null,
    links: (r.links as Record<string, unknown>) ?? null,
    status: String(r.status),
    createdAt: toIsoTimestamp(r.created_at),
  }));
}

export async function getRecentPosts(limit = 30): Promise<CreatorPost[]> {
  const rows = await sql`
    select po.*, c.handle, c.platform as c_platform
    from posts po left join creators c on c.id = po.creator_id
    order by po.posted_at desc nulls last limit ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    creatorId: r.creator_id ? Number(r.creator_id) : null,
    handle: (r.handle as string) ?? null,
    platform: String(r.platform ?? r.c_platform ?? ""),
    postUrl: (r.post_url as string) ?? null,
    postedAt: r.posted_at ? toIsoTimestamp(r.posted_at) : null,
    caption: (r.caption as string) ?? null,
    likes: num(r.likes),
    views: num(r.views),
    sentiment: (r.sentiment as string) ?? null,
    signal: (r.signal as string) ?? null,
    mentionedProducts: (r.mentioned_products as number[]) ?? null,
    summary: (r.summary as string) ?? null,
    impactPct: num(r.impact_pct),
  }));
}

export interface GradeArbRow {
  productId: number;
  name: string;
  setName: string | null;
  subType: string;
  rawMarket: number | null;
  psa10: number | null;
  gradeMultiple: number | null;
  sampleSize: number | null;
  liquidityScore: number | null;
}

export async function getGradeArbitrageBoard(limit = 12): Promise<GradeArbRow[]> {
  const rows = await sql`
    select distinct on (gc.product_id)
      gc.product_id, p.name, g.name as set_name,
      gc.raw_market, gc.avg_sold as psa10, gc.grade_multiple, gc.sample_size,
      l.liquidity_score
    from graded_comps gc
    join products p on p.product_id = gc.product_id
    left join groups g on g.group_id = p.group_id
    left join liquidity l on l.product_id = gc.product_id
    where gc.grade = 10 and gc.grade_multiple is not null
      and not p.is_sealed
    order by gc.product_id, gc.as_of desc
  `;
  return rows
    .map((r) => ({
      productId: Number(r.product_id),
      name: String(r.name),
      setName: (r.set_name as string) ?? null,
      subType: "Holofoil",
      rawMarket: num(r.raw_market),
      psa10: num(r.psa10),
      gradeMultiple: num(r.grade_multiple),
      sampleSize: num(r.sample_size),
      liquidityScore: num(r.liquidity_score),
    }))
    .sort((a, b) => (b.gradeMultiple ?? 0) - (a.gradeMultiple ?? 0))
    .slice(0, limit);
}

export interface LiquidityBoardRow {
  productId: number;
  name: string;
  setName: string | null;
  source: string;
  liquidityScore: number | null;
  soldVelocity: number | null;
  activeListings: number | null;
  bidAskSpreadPct: number | null;
  market: number | null;
}

export async function getLiquidityBoard(limit = 12): Promise<LiquidityBoardRow[]> {
  const rows = await sql`
    select l.product_id, p.name, g.name as set_name, l.source, l.liquidity_score,
      l.sold_velocity, l.active_listings, l.bid_ask_spread_pct, w.market
    from liquidity l
    join products p on p.product_id = l.product_id
    left join groups g on g.group_id = p.group_id
    left join price_windows w on w.product_id = l.product_id and w.sub_type = l.sub_type
    order by l.liquidity_score desc nulls last
    limit ${limit}
  `;
  return rows.map((r) => ({
    productId: Number(r.product_id),
    name: String(r.name),
    setName: (r.set_name as string) ?? null,
    source: String(r.source),
    liquidityScore: num(r.liquidity_score),
    soldVelocity: num(r.sold_velocity),
    activeListings: num(r.active_listings),
    bidAskSpreadPct: num(r.bid_ask_spread_pct),
    market: num(r.market),
  }));
}

export interface SetupCandidate {
  productId: number;
  name: string;
  setName: string | null;
  subType: string;
  market: number | null;
  chg7d: number | null;
  chg30d: number | null;
  chg90d: number | null;
  high180d: number | null;
  low180d: number | null;
  activeListings: number | null;
  totalQuantity: number | null;
  soldVelocity: number | null;
  liquidityScore: number | null;
  bidAskSpreadPct: number | null;
  creatorMentions: number;
  bullishMentions: number;
  maxCreatorImpact: number | null;
  psa10: number | null;
  gradeMultiple: number | null;
  gradeSampleSize: number | null;
  setupScore: number;
}

export interface SetupCandidateOpts {
  limit?: number;
  minMarket?: number;
  maxActiveListings?: number;
  max7dChangePct?: number;
  max30dChangePct?: number;
  min30dChangePct?: number;
}

export async function getSetupCandidates(
  opts: SetupCandidateOpts = {},
): Promise<SetupCandidate[]> {
  const {
    limit = 8,
    minMarket = 10,
    maxActiveListings = 30,
    max7dChangePct = 20,
    max30dChangePct = 35,
    min30dChangePct = -20,
  } = opts;

  const rows = await sql`
    with liq as (
      select distinct on (product_id, sub_type)
        product_id, sub_type, source, active_listings, total_quantity,
        sold_velocity, liquidity_score, bid_ask_spread_pct, as_of
      from liquidity
      order by product_id, sub_type, (source = 'tcgplayer') desc, as_of desc
    ),
    social as (
      select mp.product_id,
        count(*)::int as creator_mentions,
        count(*) filter (where po.sentiment = 'bullish' or po.signal in ('buy', 'hype'))::int
          as bullish_mentions,
        max(c.impact_score) as max_creator_impact
      from posts po
      left join creators c on c.id = po.creator_id
      cross join lateral unnest(coalesce(po.mentioned_products, array[]::integer[])) mp(product_id)
      group by mp.product_id
    ),
    gc10 as (
      select distinct on (product_id)
        product_id, avg_sold as psa10, grade_multiple, sample_size
      from graded_comps
      where grade = 10
      order by product_id, as_of desc
    ),
    scored as (
      select
        p.product_id, p.name, g.name as set_name, w.sub_type,
        w.market, w.chg_7d_pct, w.chg_30d_pct, w.chg_90d_pct,
        w.high_180d, w.low_180d,
        l.active_listings, l.total_quantity, l.sold_velocity,
        l.liquidity_score, l.bid_ask_spread_pct,
        coalesce(s.creator_mentions, 0) as creator_mentions,
        coalesce(s.bullish_mentions, 0) as bullish_mentions,
        s.max_creator_impact,
        gc10.psa10, gc10.grade_multiple, gc10.sample_size as grade_sample_size,
        round((
          least(30, greatest(0, ${maxActiveListings} - coalesce(l.active_listings, ${maxActiveListings}))) +
          least(25, greatest(0, coalesce(l.sold_velocity, 0)) * 12) +
          least(20, greatest(0, coalesce(w.chg_90d_pct, 0)) / 3) +
          least(15, coalesce(s.bullish_mentions, 0) * 5 + coalesce(s.max_creator_impact, 0) / 10) +
          least(10, greatest(0, coalesce(gc10.grade_multiple, 0) - 1) * 3)
        )::numeric, 2) as setup_score
      from price_windows w
      join products p on p.product_id = w.product_id
      left join groups g on g.group_id = p.group_id
      join liq l on l.product_id = w.product_id and l.sub_type = w.sub_type
      left join social s on s.product_id = w.product_id
      left join gc10 on gc10.product_id = w.product_id
      where not p.is_sealed
        and w.market >= ${minMarket}
        and coalesce(w.chg_7d_pct, 0) <= ${max7dChangePct}
        and coalesce(w.chg_30d_pct, 0) between ${min30dChangePct} and ${max30dChangePct}
        and l.active_listings <= ${maxActiveListings}
        and (w.movement_verdict is null
             or w.movement_verdict not in ('suspicious', 'likely_parking'))
    )
    select *
    from scored
    order by setup_score desc nulls last, sold_velocity desc nulls last, market desc nulls last
    limit ${limit}
  `;

  return rows.map((r) => ({
    productId: Number(r.product_id),
    name: String(r.name),
    setName: (r.set_name as string) ?? null,
    subType: String(r.sub_type),
    market: num(r.market),
    chg7d: num(r.chg_7d_pct),
    chg30d: num(r.chg_30d_pct),
    chg90d: num(r.chg_90d_pct),
    high180d: num(r.high_180d),
    low180d: num(r.low_180d),
    activeListings: num(r.active_listings),
    totalQuantity: num(r.total_quantity),
    soldVelocity: num(r.sold_velocity),
    liquidityScore: num(r.liquidity_score),
    bidAskSpreadPct: num(r.bid_ask_spread_pct),
    creatorMentions: Number(r.creator_mentions ?? 0),
    bullishMentions: Number(r.bullish_mentions ?? 0),
    maxCreatorImpact: num(r.max_creator_impact),
    psa10: num(r.psa10),
    gradeMultiple: num(r.grade_multiple),
    gradeSampleSize: num(r.grade_sample_size),
    setupScore: Number(r.setup_score ?? 0),
  }));
}

export interface TopCreator {
  id: number;
  handle: string;
  platform: string;
  impactScore: number;
  flagged: boolean;
  watchlisted: boolean;
  tier: string | null;
  posts: number;
}

export async function getTopCreators(limit = 10): Promise<TopCreator[]> {
  const rows = await sql`
    select c.id, c.handle, c.platform, c.impact_score, c.flagged,
           c.watchlisted, c.tier, count(po.id) posts
    from creators c left join posts po on po.creator_id = c.id
    group by c.id, c.handle, c.platform, c.impact_score, c.flagged, c.watchlisted, c.tier
    order by c.watchlisted desc, c.impact_score desc nulls last, posts desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    handle: String(r.handle),
    platform: String(r.platform),
    impactScore: Number(r.impact_score ?? 0),
    flagged: Boolean(r.flagged),
    watchlisted: Boolean(r.watchlisted),
    tier: (r.tier as string) ?? null,
    posts: Number(r.posts),
  }));
}

export async function getMarketMemory(
  scope = "market",
  limit = 12,
): Promise<MarketMemory[]> {
  const rows = await sql`
    select * from market_memory
    where scope = ${scope} or ${scope} = 'all'
    order by created_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    scope: String(r.scope),
    periodStart: toIsoDateOnly(r.period_start),
    periodEnd: toIsoDateOnly(r.period_end),
    title: (r.title as string) ?? null,
    narrative: String(r.narrative),
    tags: (r.tags as string[]) ?? null,
    metrics: (r.metrics as Record<string, unknown>) ?? null,
    createdAt: toIsoTimestamp(r.created_at),
  }));
}

// ---- Reddit social -> price correlation (the hypothesis findings) ----------

export interface SocialPriceFinding {
  productId: number;
  name: string;
  setName: string | null;
  eventDate: string | null;
  socialZ: number | null;
  socialScore: number | null;
  tcgChg1d: number | null;
  tcgChg3d: number | null;
  tcgChg7d: number | null;
  ebayChg7d: number | null;
  preceded: boolean | null;
  corrStrength: number | null;
  topThreadUrl: string | null;
}

/**
 * Top social->price findings written by `pipeline.reddit_corr`: Reddit spike
 * days ranked by how strongly they preceded a subsequent price move. Powers the
 * "social moved the market" surface and the agent's social-signal recall.
 */
export async function getSocialPriceFindings(
  limit = 20,
): Promise<SocialPriceFinding[]> {
  const rows = await sql`
    select s.product_id, p.name, g.name as set_name, s.event_date, s.social_z,
           s.social_score, s.tcg_chg_1d, s.tcg_chg_3d, s.tcg_chg_7d, s.ebay_chg_7d,
           s.preceded, s.corr_strength, s.top_thread_url
    from social_price_corr s
    join products p on p.product_id = s.product_id
    left join groups g on g.group_id = p.group_id
    order by s.corr_strength desc nulls last
    limit ${limit}
  `;
  return rows.map((r) => ({
    productId: Number(r.product_id),
    name: String(r.name ?? ""),
    setName: (r.set_name as string) ?? null,
    eventDate: toIsoDateOnly(r.event_date),
    socialZ: num(r.social_z),
    socialScore: num(r.social_score),
    tcgChg1d: num(r.tcg_chg_1d),
    tcgChg3d: num(r.tcg_chg_3d),
    tcgChg7d: num(r.tcg_chg_7d),
    ebayChg7d: num(r.ebay_chg_7d),
    preceded: r.preceded === null || r.preceded === undefined ? null : Boolean(r.preceded),
    corrStrength: num(r.corr_strength),
    topThreadUrl: (r.top_thread_url as string) ?? null,
  }));
}
