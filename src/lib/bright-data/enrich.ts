import "server-only";
import { sql } from "@/lib/db";
import type { CardSummary } from "@/lib/types";
import {
  applyAbsorptionToScore,
  computeAbsorption,
} from "./absorption";
import { scanGradedSold, type EbayScan } from "./ebay";
import {
  aggregateVelocity,
  getTcgDetails,
  getTcgListings,
  getTcgSalesHistory,
  type TcgDetails,
} from "./tcgplayer";

/**
 * Enrichment layer: combine live Bright Data marketplace signals into the
 * warehouse's `liquidity` and `graded_comps` tables.
 *
 *   Liquidity  = TCGplayer depth (listings/sellers) + sold velocity (weekly
 *                buckets) + bid/ask spread (lowest ask vs market). Authoritative
 *                JSON via the internal TCGplayer APIs through Web Unlocker.
 *   Graded     = eBay PSA-10/9 realized sold comps -> raw->graded multiple.
 *
 * Daily preload (scripts/bulk-liquidity.mjs) keeps browse paths warm; this
 * module also supports on-demand force refresh. Each write appends a snapshot
 * for consumption vs replenishment scoring.
 */

function cardQueryString(card: CardSummary): string {
  const bits = [card.name];
  if (card.number) bits.push(card.number);
  if (card.setName) bits.push(card.setName.replace(/^SV:\s*/i, ""));
  return bits.join(" ");
}

/** 0-100 composite liquidity score from sold velocity, depth, and spread. */
export function liquidityScore(params: {
  weeklyQtySold: number;
  activeListings: number;
  sellers: number;
  bidAskSpreadPct: number | null;
}): number {
  const { weeklyQtySold, activeListings, sellers, bidAskSpreadPct } = params;
  // Velocity dominates — a card that actually sells is liquid (cap 55).
  const velocityScore = Math.min(55, weeklyQtySold * 4);
  // Healthy seller competition (cap 25).
  const sellerScore = Math.min(25, sellers * 1.5);
  // Some listing depth is good; zero supply is illiquid (cap 10).
  const depthScore = activeListings === 0 ? 0 : Math.min(10, 4 + activeListings * 0.2);
  // Tight bid/ask = liquid (cap 10).
  const spreadScore =
    bidAskSpreadPct === null ? 5 : Math.max(0, 10 - Math.abs(bidAskSpreadPct) * 0.25);
  return Math.round(Math.min(100, velocityScore + sellerScore + depthScore + spreadScore));
}

export interface LiquidityResult {
  productId: number;
  subType: string;
  details: TcgDetails | null;
  activeListings: number;
  sellers: number;
  weeklyQtySold: number;
  weeklyTransactions: number;
  soldPerDay: number;
  bidAskSpreadPct: number | null;
  score: number;
  consumptionRate: number | null;
  replenishmentRate: number | null;
  absorptionRatio: number | null;
  topListings: { price: number; shipping: number; condition: string; seller: string; rating: number }[];
}

async function loadPriorSnapshot(
  productId: number,
  subType: string,
): Promise<{
  asOf: Date;
  activeListings: number | null;
  totalQuantity: number | null;
  soldVelocity: number | null;
} | null> {
  const rows = await sql`
    select as_of, active_listings, total_quantity, sold_velocity
    from liquidity_snapshots
    where product_id = ${productId}
      and sub_type = ${subType}
      and source = 'tcgplayer'
    order by as_of desc
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    asOf: r.as_of instanceof Date ? r.as_of : new Date(String(r.as_of)),
    activeListings: r.active_listings === null ? null : Number(r.active_listings),
    totalQuantity: r.total_quantity === null ? null : Number(r.total_quantity),
    soldVelocity: r.sold_velocity === null ? null : Number(r.sold_velocity),
  };
}

/** Live TCGplayer liquidity scan for a card, persisted to `liquidity` + snapshot. */
export async function enrichLiquidity(card: CardSummary): Promise<LiquidityResult> {
  const [details, listingsData, salesSeries, prior] = await Promise.all([
    getTcgDetails(card.productId),
    getTcgListings(card.productId, 1),
    getTcgSalesHistory(card.productId, "quarter"),
    loadPriorSnapshot(card.productId, card.subType),
  ]);

  const vel = aggregateVelocity(salesSeries, 13);
  const activeListings = details?.totalListings ?? listingsData.total;
  const totalQuantity = listingsData.listings.reduce((s, l) => s + l.quantity, 0);
  const sellers = details?.totalSellers ?? 0;
  const market = details?.marketPrice ?? card.market;
  const lowestAsk = details?.lowestPrice ?? listingsData.listings[0]?.price ?? null;

  const bidAskSpreadPct =
    lowestAsk !== null && market
      ? Math.round(((lowestAsk - market) / market) * 1000) / 10
      : null;

  const baseScore = liquidityScore({
    weeklyQtySold: vel.weeks ? vel.qtySold / vel.weeks : 0,
    activeListings,
    sellers,
    bidAskSpreadPct,
  });

  const now = new Date();
  const absorption = computeAbsorption(
    {
      asOf: now,
      activeListings,
      totalQuantity,
      soldVelocity: vel.perDay,
    },
    prior,
  );
  const score = applyAbsorptionToScore(baseScore, absorption.scoreDelta);

  await sql`
    insert into liquidity
      (product_id, sub_type, source, as_of, active_listings, total_quantity,
       total_qty_sold_90d, total_txn_90d, sold_velocity, bid_ask_spread_pct,
       liquidity_score, sellers, consumption_rate, replenishment_rate,
       absorption_ratio, raw)
    values
      (${card.productId}, ${card.subType}, 'tcgplayer', ${now.toISOString()},
       ${activeListings}, ${totalQuantity},
       ${vel.qtySold}, ${vel.transactions}, ${vel.perDay}, ${bidAskSpreadPct},
       ${score}, ${sellers}, ${absorption.consumptionRate},
       ${absorption.replenishmentRate}, ${absorption.absorptionRatio},
       ${sql.json({
         marketPrice: market,
         lowestAsk,
         sellers,
         velocityWeeks: vel.weeks,
         query: cardQueryString(card),
         baseScore,
         absorptionScoreDelta: absorption.scoreDelta,
       } as never)})
    on conflict (product_id, sub_type, source) do update set
      as_of = excluded.as_of,
      active_listings = excluded.active_listings,
      total_quantity = excluded.total_quantity,
      total_qty_sold_90d = excluded.total_qty_sold_90d,
      total_txn_90d = excluded.total_txn_90d,
      sold_velocity = excluded.sold_velocity,
      bid_ask_spread_pct = excluded.bid_ask_spread_pct,
      liquidity_score = excluded.liquidity_score,
      sellers = excluded.sellers,
      consumption_rate = excluded.consumption_rate,
      replenishment_rate = excluded.replenishment_rate,
      absorption_ratio = excluded.absorption_ratio,
      raw = excluded.raw
  `;

  await sql`
    insert into liquidity_snapshots
      (product_id, sub_type, source, as_of, active_listings, total_quantity,
       sellers, sold_velocity, total_qty_sold_90d, bid_ask_spread_pct,
       liquidity_score, listings_delta, qty_delta, consumption_rate,
       replenishment_rate, absorption_ratio)
    values
      (${card.productId}, ${card.subType}, 'tcgplayer', ${now.toISOString()},
       ${activeListings}, ${totalQuantity}, ${sellers}, ${vel.perDay},
       ${vel.qtySold}, ${bidAskSpreadPct}, ${score},
       ${absorption.listingsDelta}, ${absorption.qtyDelta},
       ${absorption.consumptionRate}, ${absorption.replenishmentRate},
       ${absorption.absorptionRatio})
  `;

  return {
    productId: card.productId,
    subType: card.subType,
    details,
    activeListings,
    sellers,
    weeklyQtySold: vel.qtySold,
    weeklyTransactions: vel.transactions,
    soldPerDay: vel.perDay,
    bidAskSpreadPct,
    score,
    consumptionRate: absorption.consumptionRate,
    replenishmentRate: absorption.replenishmentRate,
    absorptionRatio: absorption.absorptionRatio,
    topListings: listingsData.listings.slice(0, 8).map((l) => ({
      price: l.price,
      shipping: l.shippingPrice,
      condition: l.condition,
      seller: l.sellerName,
      rating: l.sellerRating,
    })),
  };
}

export interface GradedResult {
  productId: number;
  grade: number;
  scan: EbayScan;
  rawMarket: number | null;
  gradeMultiple: number | null;
}

/**
 * Live PSA-graded comps for a card, persisted to `graded_comps`.
 *
 * Sealed product (ETB / case / booster box) is skipped — PSA grades apply to
 * singles. Searching eBay for "… Case PSA 10" returns fuzzy unrelated singles
 * and used to get stored as comps.
 *
 * Grades are fetched **sequentially** on purpose: two parallel eBay Unlocker
 * HTML calls contend on the same zone and often make wall-clock *worse*
 * (measured ~39s parallel vs ~21s for a single PSA-10). Live refresh passes
 * `[10, 9]`; callers on a tighter time budget can pass `[10]` only.
 */
export async function enrichGraded(
  card: CardSummary,
  grades: number[] = [10, 9],
): Promise<GradedResult[]> {
  if (card.isSealed) {
    // Drop any prior bogus rows from before the sealed skip.
    await sql`delete from graded_comps where product_id = ${card.productId}`;
    return [];
  }

  const q = cardQueryString(card);
  const raw = card.market;
  const out: GradedResult[] = [];

  for (const grade of grades) {
    const scan = await scanGradedSold(q, grade);
    // Explicit empty: caller surfaces sampleSize 0 instead of reusing stale rows.
    if (scan.count === 0) continue;

    const market = scan.market ?? scan.median;
    const gradeMultiple =
      raw && market ? Math.round((market / raw) * 100) / 100 : null;

    await sql`
      insert into graded_comps
        (product_id, grader, grade, source, as_of, sample_size, avg_sold,
         last_sold, low_sold, high_sold, raw_market, grade_multiple,
         sold_per_day, sold_per_month, raw)
      values
        (${card.productId}, 'PSA', ${grade}, 'ebay', now(),
         ${scan.count}, ${scan.avg}, ${market}, ${scan.low}, ${scan.high},
         ${raw}, ${gradeMultiple}, ${scan.soldPerDay}, ${scan.soldPerMonth},
         ${sql.json({
           query: `${q} PSA ${grade}`,
           lookbackDays: scan.lookbackDays,
           datedCount: scan.datedCount,
           pagesFetched: scan.pagesFetched,
           market,
         } as never)})
    `;

    out.push({ productId: card.productId, grade, scan, rawMarket: raw, gradeMultiple });
  }
  return out;
}
