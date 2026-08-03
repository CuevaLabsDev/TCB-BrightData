import "server-only";
import { unlockerRequest } from "./client";

/**
 * TCGplayer marketplace intelligence via Bright Data Web Unlocker.
 *
 * Ports the internal-API approach proven in tcb-collector (providers/tcgplayer.py)
 * but routes every call through Bright Data — which solves the DataDome bot
 * challenge that otherwise requires Playwright + stealth cookies.
 *
 * Three endpoints:
 *   GET  mp-search-api/v2/product/{id}/details          -> market price, depth
 *   POST mp-search-api/v1/product/{id}/listings         -> live listing depth + sellers
 *   GET  infinite-api/price/history/{id}/detailed       -> weekly sold velocity
 */

const LISTINGS_HOST = "mp-search-api.tcgplayer.com";
const HISTORY_HOST = "infinite-api.tcgplayer.com";

function tcgHeaders(productId: number): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://www.tcgplayer.com",
    Referer: `https://www.tcgplayer.com/product/${productId}/`,
  };
}

export interface TcgDetails {
  productName: string;
  setName: string;
  setId: number | null;
  marketPrice: number | null;
  medianPrice: number | null;
  lowestPrice: number | null;
  lowestPriceWithShipping: number | null;
  totalListings: number | null;
  totalSellers: number | null;
}

export interface TcgListing {
  price: number;
  shippingPrice: number;
  condition: string;
  printing: string;
  quantity: number;
  sellerName: string;
  sellerRating: number;
  directSeller: boolean;
}

export interface TcgSalesBucket {
  bucketStartDate: string;
  marketPrice: number | null;
  quantitySold: number;
  transactionCount: number;
  lowSalePrice: number | null;
  highSalePrice: number | null;
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Soft JSON targets — fail faster than the default 60s HTML Unlocker budget. */
const TCG_TIMEOUT_MS = 35_000;

export async function getTcgDetails(productId: number): Promise<TcgDetails | null> {
  const text = await unlockerRequest(
    `https://${LISTINGS_HOST}/v2/product/${productId}/details`,
    { method: "GET", headers: tcgHeaders(productId), timeoutMs: TCG_TIMEOUT_MS },
  );
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    productName: String(j.productName ?? ""),
    setName: String(j.setName ?? ""),
    setId: n(j.setId),
    marketPrice: n(j.marketPrice),
    medianPrice: n(j.medianPrice),
    lowestPrice: n(j.lowestPrice),
    lowestPriceWithShipping: n(j.lowestPriceWithShipping),
    totalListings: n(j.listings),
    totalSellers: n(j.sellers),
  };
}

function listingsBody(
  from: number,
  size: number,
  printing?: string,
): string {
  const term: Record<string, string> = { sellerStatus: "Live" };
  // TCGplayer `printing` matches warehouse `sub_type` (Normal, Holofoil, …).
  if (printing) term.printing = printing;
  return JSON.stringify({
    filters: {
      term,
      range: { quantity: { gte: 1 } },
      exclude: { channelExclusion: 0 },
    },
    from,
    size,
    sort: { field: "price+shipping", order: "asc" },
    context: { shippingCountry: "US", cart: {} },
    aggregations: ["listingType"],
  });
}

export interface GetTcgListingsOpts {
  /** Warehouse sub_type / TCG printing — required for correct per-variant supply. */
  printing?: string;
  /** Cap pages; omit to fetch all (exact qty). */
  maxPages?: number;
}

/**
 * Fetch live TCGplayer listings (50/page, API max that works).
 * Pass `printing` (= sub_type) to scope to that finish; otherwise all printings mix.
 * Default: page until every matching listing is retrieved so qty is exact.
 */
export async function getTcgListings(
  productId: number,
  opts: GetTcgListingsOpts = {},
): Promise<{
  total: number;
  listings: TcgListing[];
  totalQuantity: number;
  sellers: number;
}> {
  const size = 50;
  /** Safety ceiling — ~2500 listing rows; deeper markets are extreme outliers. */
  const pageCap = opts.maxPages ?? 50;
  const all: TcgListing[] = [];
  let total = 0;

  for (let page = 0; page < pageCap; page++) {
    const text = await unlockerRequest(
      `https://${LISTINGS_HOST}/v1/product/${productId}/listings`,
      {
        method: "POST",
        body: listingsBody(page * size, size, opts.printing),
        headers: tcgHeaders(productId),
        timeoutMs: TCG_TIMEOUT_MS,
      },
    );
    let inner: Record<string, unknown>;
    try {
      const j = JSON.parse(text) as { results?: Record<string, unknown>[] };
      inner = j.results?.[0] ?? {};
    } catch {
      break;
    }
    total = n(inner.totalResults) ?? total;
    const batch = (inner.results as Record<string, unknown>[] | undefined) ?? [];
    for (const r of batch) {
      all.push({
        price: n(r.price) ?? 0,
        shippingPrice: n(r.shippingPrice) ?? 0,
        condition: String(r.condition ?? ""),
        printing: String(r.printing ?? ""),
        quantity: n(r.quantity) ?? 0,
        sellerName: String(r.sellerName ?? ""),
        sellerRating: n(r.sellerRating) ?? 0,
        directSeller: Boolean(r.directSeller),
      });
    }
    if (batch.length < size) break;
    if (total > 0 && all.length >= total) break;
  }
  const totalQuantity = all.reduce((s, l) => s + l.quantity, 0);
  const sellers = new Set(all.map((l) => l.sellerName).filter(Boolean)).size;
  return { total, listings: all, totalQuantity, sellers };
}

export interface TcgSalesSeries {
  variant: string;
  condition: string;
  buckets: TcgSalesBucket[];
}

export async function getTcgSalesHistory(
  productId: number,
  range: "quarter" | "annual" = "quarter",
): Promise<TcgSalesSeries[]> {
  const text = await unlockerRequest(
    `https://${HISTORY_HOST}/price/history/${productId}/detailed?range=${range}`,
    { method: "GET", headers: tcgHeaders(productId), timeoutMs: TCG_TIMEOUT_MS },
  );
  let result: Record<string, unknown>[];
  try {
    const j = JSON.parse(text) as { result?: Record<string, unknown>[] };
    result = j.result ?? [];
  } catch {
    return [];
  }
  return result.map((s) => ({
    variant: String(s.variant ?? ""),
    condition: String(s.condition ?? ""),
    buckets: ((s.buckets as Record<string, unknown>[]) ?? []).map((b) => ({
      bucketStartDate: String(b.bucketStartDate ?? ""),
      marketPrice: n(b.marketPrice),
      quantitySold: n(b.quantitySold) ?? 0,
      transactionCount: n(b.transactionCount) ?? 0,
      lowSalePrice: n(b.lowSalePrice),
      highSalePrice: n(b.highSalePrice),
    })),
  }));
}

/**
 * Aggregate sold velocity over the most recent N weeks.
 * Pass `variant` (= warehouse sub_type) to keep only that printing's buckets.
 */
export function aggregateVelocity(
  series: TcgSalesSeries[],
  weeks = 13,
  variant?: string,
) {
  let qty = 0;
  let txns = 0;
  let weeksCounted = 0;
  const seen = new Set<string>();
  const filtered =
    variant != null && variant !== ""
      ? series.filter((s) => s.variant.toLowerCase() === variant.toLowerCase())
      : series;
  for (const s of filtered) {
    for (const b of s.buckets.slice(0, weeks)) {
      qty += b.quantitySold;
      txns += b.transactionCount;
      if (!seen.has(b.bucketStartDate)) {
        seen.add(b.bucketStartDate);
        weeksCounted++;
      }
    }
  }
  const days = Math.max(1, weeksCounted * 7);
  return {
    qtySold: qty,
    transactions: txns,
    weeks: weeksCounted,
    perDay: Math.round((qty / days) * 100) / 100,
  };
}
