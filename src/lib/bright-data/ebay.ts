import "server-only";
import * as cheerio from "cheerio";
import { unlockPage } from "./client";

/**
 * eBay marketplace intelligence via Bright Data Web Unlocker.
 *
 * eBay is heavily bot-protected; we route the search-results pages through the
 * Web Unlocker and parse them with cheerio. Two views matter for liquidity:
 *   - ACTIVE listings  (supply / asking prices)
 *   - SOLD listings    (demand / realized prices, true velocity)
 */

export interface EbayListing {
  title: string;
  price: number;
  url?: string;
  sold?: boolean;
  soldDate?: string;
  /** Parsed sold date when caption could be interpreted. */
  soldAt?: Date | null;
}

export interface EbayScan {
  query: string;
  sold: boolean;
  count: number;
  prices: number[];
  listings: EbayListing[];
  avg: number | null;
  /** Converged market = IQR-trimmed median of sold prices. */
  median: number | null;
  market: number | null;
  low: number | null;
  high: number | null;
  soldPerDay: number | null;
  soldPerMonth: number | null;
  lookbackDays: number | null;
  datedCount: number;
  pagesFetched: number;
}

function parsePrice(text: string | undefined): number | null {
  if (!text) return null;
  // take the first $-amount; handle ranges like "$10.00 to $20.00"
  const m = text.replace(/,/g, "").match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quartile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

/** Drop IQR outliers; fall back to 0.1×–10× median band when n is tiny. */
function filterOutliers(prices: number[]): number[] {
  const raw = prices.filter((p) => p > 0);
  if (raw.length < 4) {
    const med = median(raw);
    if (med === null) return raw;
    return raw.filter((p) => p >= med * 0.1 && p <= med * 10);
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const q1 = quartile(sorted, 0.25);
  const q3 = quartile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) {
    const med = median(raw);
    if (med === null) return raw;
    return raw.filter((p) => p >= med * 0.1 && p <= med * 10);
  }
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const filtered = raw.filter((p) => p >= lo && p <= hi);
  return filtered.length ? filtered : raw;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/** Parse eBay sold captions like "Sold  Jul 20" or "Sold  Jun 15, 2025". */
export function parseSoldDate(text: string | undefined, now = new Date()): Date | null {
  if (!text) return null;
  const m = text.match(
    /sold\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?|sold\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
  );
  if (!m) return null;

  let year: number;
  let month: number;
  let day: number;

  if (m[4]) {
    const mon = MONTHS[m[4].toLowerCase()];
    if (mon === undefined) return null;
    month = mon;
    day = Number(m[5]);
    year = m[6] ? Number(m[6]) : now.getFullYear();
  } else {
    month = Number(m[1]) - 1;
    day = Number(m[2]);
    const yRaw = m[3];
    if (yRaw) {
      year = Number(yRaw);
      if (year < 100) year += 2000;
    } else {
      year = now.getFullYear();
    }
  }

  if (!Number.isFinite(day) || day < 1 || day > 31 || month < 0 || month > 11) {
    return null;
  }

  let d = new Date(year, month, day);
  // Captions without a year that land in the future are from last year.
  if (!m[3] && !m[6] && d.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    d = new Date(year - 1, month, day);
  }
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function computeVelocity(listings: EbayListing[], now = new Date()) {
  const MS_DAY = 24 * 60 * 60 * 1000;
  const windowMs = 30 * MS_DAY;
  const cutoff = now.getTime() - windowMs;
  const dated = listings
    .map((l) => l.soldAt)
    .filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()))
    .filter((d) => d.getTime() >= cutoff && d.getTime() <= now.getTime() + MS_DAY);

  if (dated.length === 0) {
    return { soldPerDay: null, soldPerMonth: null, lookbackDays: null, datedCount: 0 };
  }

  const oldest = Math.min(...dated.map((d) => d.getTime()));
  const spanDays = Math.max(1, Math.ceil((now.getTime() - oldest) / MS_DAY));
  const lookbackDays = Math.min(30, spanDays);
  const soldPerDay = Math.round((dated.length / lookbackDays) * 100) / 100;
  const soldPerMonth = Math.round(soldPerDay * 30 * 100) / 100;
  return { soldPerDay, soldPerMonth, lookbackDays, datedCount: dated.length };
}

/**
 * Page size for sold comps — enough to converge a median; paginate for coverage.
 * (Reverted from the 24-item speed cut once Unlocker expect-elements was removed.)
 */
const EBAY_PAGE_SIZE = 60;
const EBAY_MAX_PAGES = 3;
/** Healthy Unlocker budget after zone fix; one retry on transient failures. */
const EBAY_TIMEOUT_MS = 90_000;

function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const name = "name" in e ? String((e as { name?: string }).name) : "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout|timeout/i.test(e.message)
  );
}

async function unlockPageWithRetry(url: string): Promise<string> {
  const attempt = () => unlockPage(url, { timeoutMs: EBAY_TIMEOUT_MS });
  try {
    return await attempt();
  } catch (e) {
    // Retry once on timeout, empty body, or adaptive rate limit.
    const msg = e instanceof Error ? e.message : "";
    const retryable =
      isTimeoutError(e) ||
      /empty body|rate limit|bucket_rate_limit|waiting for selector/i.test(msg);
    if (!retryable) throw e;
    await new Promise((r) => setTimeout(r, 2500));
    return attempt();
  }
}

function buildUrl(query: string, sold: boolean, page = 1): string {
  const p = new URLSearchParams({
    _nkw: query,
    _ipg: String(EBAY_PAGE_SIZE),
  });
  if (page > 1) p.set("_pgn", String(page));
  if (sold) {
    p.set("LH_Sold", "1");
    p.set("LH_Complete", "1");
  }
  return `https://www.ebay.com/sch/i.html?${p.toString()}`;
}

function summarizeListings(
  query: string,
  sold: boolean,
  listings: EbayListing[],
  pagesFetched = 1,
): EbayScan {
  const rawPrices = listings.map((l) => l.price).filter((p) => p > 0);
  const prices = filterOutliers(rawPrices);
  const med = median(prices);
  const market = med !== null ? Math.round(med * 100) / 100 : null;
  const avg = prices.length
    ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
    : null;
  const velocity = sold
    ? computeVelocity(listings)
    : { soldPerDay: null, soldPerMonth: null, lookbackDays: null, datedCount: 0 };

  return {
    query,
    sold,
    count: prices.length,
    prices,
    listings: listings.slice(0, 80),
    avg,
    median: market,
    market,
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    soldPerDay: velocity.soldPerDay,
    soldPerMonth: velocity.soldPerMonth,
    lookbackDays: velocity.lookbackDays,
    datedCount: velocity.datedCount,
    pagesFetched,
  };
}

export interface ScanEbayOpts {
  /**
   * When false, skip the "$X.XX anywhere in HTML" fallback. Graded comps need
   * real titles — inventing rows from bare price matches fabricates PSA data.
   */
  allowPriceFallback?: boolean;
  /** Keep only listings whose title matches (e.g. /\bPSA\s*10\b/i). */
  titleMatch?: RegExp;
  /** Max sold-result pages to walk (graded defaults to 3). */
  maxPages?: number;
}

function parseListingsFromHtml(
  html: string,
  query: string,
  sold: boolean,
  opts: ScanEbayOpts,
): EbayListing[] {
  const $ = cheerio.load(html);
  let listings: EbayListing[] = [];

  $("li.s-item, .s-card").each((_, el) => {
    const node = $(el);
    const title = node.find(".s-item__title, .s-card__title").first().text().trim();
    if (!title || /shop on ebay/i.test(title)) return;
    const priceText = node.find(".s-item__price, .s-card__price").first().text().trim();
    const price = parsePrice(priceText);
    if (price === null) return;
    const url = node.find("a.s-item__link, a").first().attr("href");
    const soldDateText = node
      .find(".s-item__caption--signal, .POSITIVE, .s-item__title--tagblock, .s-item__endedDate")
      .first()
      .text()
      .trim();
    const soldAt = sold ? parseSoldDate(soldDateText || undefined) : null;
    listings.push({
      title,
      price,
      url,
      sold,
      soldDate: soldDateText || undefined,
      soldAt,
    });
  });

  // Fallback: if structured parse missed (eBay markup drift), regex the body.
  // Opt-out for graded scans — bare prices without titles are not comps.
  if (listings.length === 0 && opts.allowPriceFallback !== false) {
    const matches = html.match(/\$[\d,]+\.\d{2}/g) || [];
    for (const m of matches.slice(0, 40)) {
      const price = parsePrice(m);
      if (price !== null && price > 0) listings.push({ title: query, price, sold });
    }
  }

  if (opts.titleMatch) {
    listings = listings.filter((l) => opts.titleMatch!.test(l.title));
  }

  return listings;
}

/** Scan eBay search results for a query (active or sold). */
export async function scanEbay(
  query: string,
  sold: boolean,
  opts: ScanEbayOpts = {},
): Promise<EbayScan> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 1, EBAY_MAX_PAGES));
  const all: EbayListing[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const html = await unlockPageWithRetry(buildUrl(query, sold, page));
    pagesFetched++;
    const pageListings = parseListingsFromHtml(html, query, sold, opts);
    // Structured miss on page 1 with no title filter still allows fallback inside parser.
    if (pageListings.length === 0) break;

    all.push(...pageListings);
    // Stop early when the page is short — no more results.
    if (pageListings.length < EBAY_PAGE_SIZE * 0.4) break;
  }

  return summarizeListings(query, sold, all, pagesFetched);
}

/** PSA-graded sold comps for a card (grade 9/10). */
export async function scanGradedSold(
  cardQuery: string,
  grade: number,
): Promise<EbayScan> {
  // eBay search is fuzzy — require the grade in the title so sealed products /
  // adjacent singles don't pollute comps. Walk up to 3 pages for a stable market.
  return scanEbay(`${cardQuery} PSA ${grade}`, true, {
    allowPriceFallback: false,
    titleMatch: new RegExp(`\\bPSA\\s*${grade}\\b`, "i"),
    maxPages: EBAY_MAX_PAGES,
  });
}
