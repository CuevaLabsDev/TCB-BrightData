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
}

export interface EbayScan {
  query: string;
  sold: boolean;
  count: number;
  prices: number[];
  listings: EbayListing[];
  avg: number | null;
  median: number | null;
  low: number | null;
  high: number | null;
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

/** Soft cap — enough sold comps for a stable median without a max-weight page. */
const EBAY_PAGE_SIZE = "24";
/** eBay HTML Unlocker is the slow path; fail before burning the full 60s budget. */
const EBAY_TIMEOUT_MS = 45_000;

function buildUrl(query: string, sold: boolean): string {
  const p = new URLSearchParams({ _nkw: query, _ipg: EBAY_PAGE_SIZE });
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
): EbayScan {
  // Filter outliers: drop prices < $1 and absurd > 100x median noise
  const rawPrices = listings.map((l) => l.price).filter((p) => p > 0);
  const med = median(rawPrices);
  const prices =
    med !== null
      ? rawPrices.filter((p) => p >= med * 0.1 && p <= med * 10)
      : rawPrices;

  const avg = prices.length
    ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
    : null;

  return {
    query,
    sold,
    count: prices.length,
    prices,
    listings: listings.slice(0, 40),
    avg,
    median: med !== null ? Math.round(med * 100) / 100 : null,
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
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
}

/** Scan eBay search results for a query (active or sold). */
export async function scanEbay(
  query: string,
  sold: boolean,
  opts: ScanEbayOpts = {},
): Promise<EbayScan> {
  const html = await unlockPage(buildUrl(query, sold), { timeoutMs: EBAY_TIMEOUT_MS });
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
      .find(".s-item__caption--signal, .POSITIVE, .s-item__title--tagblock")
      .first()
      .text()
      .trim();
    listings.push({ title, price, url, sold, soldDate: soldDateText || undefined });
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

  return summarizeListings(query, sold, listings);
}

/** PSA-graded sold comps for a card (grade 9/10). */
export async function scanGradedSold(
  cardQuery: string,
  grade: number,
): Promise<EbayScan> {
  // eBay search is fuzzy — require the grade in the title so sealed products /
  // adjacent singles don't pollute comps.
  return scanEbay(`${cardQuery} PSA ${grade}`, true, {
    allowPriceFallback: false,
    titleMatch: new RegExp(`\\bPSA\\s*${grade}\\b`, "i"),
  });
}
