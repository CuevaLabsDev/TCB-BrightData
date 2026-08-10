/**
 * TCGplayer listing book analysis: buyout cost (price + shipping) and
 * ask-ladder gaps (how much supply sits before the next price jump).
 */

export interface LadderListing {
  price: number;
  shippingPrice: number;
  quantity: number;
}

export interface LadderLevel {
  /** Landed ask = price + shipping (USD). */
  landed: number;
  /** Units available at this exact landed price. */
  qty: number;
  /** Cumulative units at or below this landed price. */
  cumQty: number;
  /** Cumulative USD to buy all units up through this level. */
  cumCost: number;
}

export interface PriceGap {
  /** Landed ask just before the jump. */
  fromLanded: number;
  /** Next landed ask after the jump. */
  toLanded: number;
  /** Absolute USD gap. */
  gapUsd: number;
  /** Gap as % of fromLanded. */
  gapPct: number;
  /** Units that must be bought to clear through `fromLanded` and reach `toLanded`. */
  qtyToClear: number;
  /** USD to buy those units (through fromLanded inclusive). */
  costToClear: number;
}

export interface ListingLadderAnalysis {
  levels: LadderLevel[];
  /** Sum of (price + shipping) × qty across fetched listings. */
  buyoutUsd: number;
  buyoutQty: number;
  listingRows: number;
  lowestLanded: number | null;
  highestLanded: number | null;
  /** True when fetch was page-capped vs full book. */
  partial: boolean;
  gaps: PriceGap[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Collapse individual listings into sorted landed-price levels. */
export function buildLadderLevels(listings: LadderListing[]): LadderLevel[] {
  const byLanded = new Map<number, number>();
  for (const l of listings) {
    if (!(l.quantity > 0)) continue;
    const price = Number(l.price) || 0;
    const ship = Number(l.shippingPrice) || 0;
    if (price <= 0) continue;
    const landed = round2(price + ship);
    byLanded.set(landed, (byLanded.get(landed) ?? 0) + l.quantity);
  }

  const landedPrices = [...byLanded.keys()].sort((a, b) => a - b);
  const levels: LadderLevel[] = [];
  let cumQty = 0;
  let cumCost = 0;
  for (const landed of landedPrices) {
    const qty = byLanded.get(landed) ?? 0;
    cumQty += qty;
    cumCost = round2(cumCost + landed * qty);
    levels.push({ landed, qty, cumQty, cumCost });
  }
  return levels;
}

/**
 * Detect meaningful ask jumps. Default: ≥15% or ≥$1 absolute (whichever is larger floor).
 */
export function findPriceGaps(
  levels: LadderLevel[],
  opts: { minGapPct?: number; minGapUsd?: number } = {},
): PriceGap[] {
  const minGapPct = opts.minGapPct ?? 15;
  const minGapUsd = opts.minGapUsd ?? 1;
  const gaps: PriceGap[] = [];

  for (let i = 0; i < levels.length - 1; i++) {
    const from = levels[i]!;
    const to = levels[i + 1]!;
    const gapUsd = round2(to.landed - from.landed);
    if (gapUsd <= 0) continue;
    const gapPct = from.landed > 0 ? round1((gapUsd / from.landed) * 100) : 0;
    if (gapPct < minGapPct && gapUsd < minGapUsd) continue;

    gaps.push({
      fromLanded: from.landed,
      toLanded: to.landed,
      gapUsd,
      gapPct,
      qtyToClear: from.cumQty,
      costToClear: from.cumCost,
    });
  }
  return gaps;
}

/**
 * Units (and USD) to buy so the next remaining ask is ≥ targetLanded.
 * Example: market at $4, target $8 → qty of all listings with landed < $8.
 */
export function qtyToReachAsk(
  levels: LadderLevel[],
  targetLanded: number,
): { qty: number; costUsd: number; nextAsk: number | null } {
  if (!levels.length || !(targetLanded > 0)) {
    return { qty: 0, costUsd: 0, nextAsk: null };
  }
  let qty = 0;
  let costUsd = 0;
  let nextAsk: number | null = null;
  for (const lvl of levels) {
    if (lvl.landed < targetLanded) {
      qty = lvl.cumQty;
      costUsd = lvl.cumCost;
    } else {
      nextAsk = lvl.landed;
      break;
    }
  }
  if (nextAsk === null && levels.length) {
    // Entire book is below target.
    const last = levels[levels.length - 1]!;
    return { qty: last.cumQty, costUsd: last.cumCost, nextAsk: null };
  }
  return { qty, costUsd: round2(costUsd), nextAsk };
}

export function analyzeListingLadder(
  listings: LadderListing[],
  opts: { partial?: boolean; minGapPct?: number; minGapUsd?: number } = {},
): ListingLadderAnalysis {
  const levels = buildLadderLevels(listings);
  const buyoutQty = levels.length ? levels[levels.length - 1]!.cumQty : 0;
  const buyoutUsd = levels.length ? levels[levels.length - 1]!.cumCost : 0;
  const gaps = findPriceGaps(levels, opts);

  // Cap stored levels for jsonb size — keep every level up to 80, else decimate.
  const storedLevels =
    levels.length <= 80
      ? levels
      : levels.filter((_, i) => i === 0 || i === levels.length - 1 || i % Math.ceil(levels.length / 60) === 0);

  return {
    levels: storedLevels,
    buyoutUsd,
    buyoutQty,
    listingRows: listings.length,
    lowestLanded: levels[0]?.landed ?? null,
    highestLanded: levels[levels.length - 1]?.landed ?? null,
    partial: Boolean(opts.partial),
    gaps: gaps.slice(0, 12),
  };
}

/** Compact shape persisted on liquidity.raw */
export function ladderToRaw(analysis: ListingLadderAnalysis) {
  return {
    buyoutUsd: analysis.buyoutUsd,
    buyoutQty: analysis.buyoutQty,
    listingRows: analysis.listingRows,
    lowestLanded: analysis.lowestLanded,
    highestLanded: analysis.highestLanded,
    partial: analysis.partial,
    gaps: analysis.gaps,
    levels: analysis.levels.map((l) => ({
      landed: l.landed,
      qty: l.qty,
      cumQty: l.cumQty,
      cumCost: l.cumCost,
    })),
  };
}

export type StoredListingLadder = ReturnType<typeof ladderToRaw>;

export function parseStoredLadder(raw: unknown): StoredListingLadder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ladder = (r.listingLadder ?? r.ladder) as Record<string, unknown> | undefined;
  if (!ladder || typeof ladder !== "object") return null;
  if (typeof ladder.buyoutUsd !== "number") return null;
  return ladder as unknown as StoredListingLadder;
}
