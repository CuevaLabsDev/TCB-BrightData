#!/usr/bin/env node
/**
 * Daily / backfill TCGplayer liquidity preload via Bright Data Web Unlocker.
 *
 * Selects non-sealed price_windows under --max-market (default 2), stale-first,
 * fetches details + sales history (listings optional), upserts `liquidity`,
 * appends `liquidity_snapshots`, and records an `ingest_runs` row.
 *
 * Usage:
 *   node scripts/bulk-liquidity.mjs --limit 50
 *   node scripts/bulk-liquidity.mjs --max-market 2 --stale-hours 24 --limit 500 --concurrency 8
 *   node scripts/bulk-liquidity.mjs --mode async --limit 100   # needs BRIGHT_DATA_UNLOCKER_ASYNC_ZONE
 *   node scripts/bulk-liquidity.mjs --endpoints details,sales,listings
 *   node scripts/bulk-liquidity.mjs --from-queue              # set-ranked budgeted queue
 *
 * Env: SUPABASE_DB_URL | PIPELINE_DB_URL, BRIGHT_DATA_API_KEY,
 *      BRIGHT_DATA_TCGPLAYER_UNLOCKER_ZONE | BRIGHT_DATA_UNLOCKER_ZONE
 *      [, BRIGHT_DATA_TCGPLAYER_UNLOCKER_ASYNC_ZONE | BRIGHT_DATA_UNLOCKER_ASYNC_ZONE]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
try {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    if (env[k] === undefined) env[k] = t.slice(i + 1).trim();
  }
} catch {
  /* .env.local optional when env already injected (GHA) */
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
}

const MAX_MARKET = Number(arg("max-market", "2"));
const STALE_HOURS = Number(arg("stale-hours", "24"));
const LIMIT = Number(arg("limit", "500"));
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "3")));
const MODE = String(arg("mode", "sync")); // sync | async
const FROM_QUEUE = arg("from-queue", false) === true || arg("from-queue", false) === "true";
const QUEUE_DATE = String(arg("queue-date", "")) || null; // YYYY-MM-DD; default today UTC
const ENDPOINTS = String(arg("endpoints", "details,sales,listings"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_LISTINGS = ENDPOINTS.includes("listings");
/** TCG listings page size (API max that returns rows). */
const LISTINGS_PAGE_SIZE = 50;
/** Safety cap — 50 pages × 50 = 2500 listing rows. Spotlight queue caps at 2. */
const LISTINGS_MAX_PAGES = Math.max(1, Number(arg("listings-max-pages", "50")));
const SPOTLIGHT_LISTINGS_MAX_PAGES = Math.max(1, Number(arg("spotlight-listings-pages", "2")));
/** Per-request Unlocker attempts (empty body / 502 / timeout). */
const UNLOCK_RETRIES = 4;
/** Fail the GHA job if failure rate exceeds this (after retries). */
const MAX_FAIL_RATE = 0.05;
const PREFLIGHT_PRODUCT_ID = Number(arg("preflight-product-id", "610516"));

/** Shared backoff when the Unlocker zone starts returning empties/502s. */
let zoneCooldownUntil = 0;
let consecutiveTransientFails = 0;
let consecutiveUnlockOk = 0;
let cooldownLevel = 0;
let fatalUnlockError = null;

const API = "https://api.brightdata.com/request";
const ASYNC_SUBMIT = "https://api.brightdata.com/unblocker/req";
const ASYNC_RESULT = "https://api.brightdata.com/unblocker/get_result";
function cleanSecret(v) {
  if (v == null) return "";
  let s = String(v).trim();
  // Strip accidental wrapping quotes / Bearer prefix from pasted secrets.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, "").trim();
  return s;
}

const KEY = cleanSecret(env.BRIGHT_DATA_API_KEY);
const SYNC_ZONE =
  cleanSecret(env.BRIGHT_DATA_TCGPLAYER_UNLOCKER_ZONE) ||
  cleanSecret(env.BRIGHT_DATA_UNLOCKER_ZONE) ||
  "tcb_1";
const ASYNC_ZONE =
  cleanSecret(env.BRIGHT_DATA_TCGPLAYER_UNLOCKER_ASYNC_ZONE) ||
  cleanSecret(env.BRIGHT_DATA_UNLOCKER_ASYNC_ZONE);
const DB_URL = cleanSecret(env.PIPELINE_DB_URL || env.SUPABASE_DB_URL || env.DATABASE_URL);

if (!KEY) {
  console.error("BRIGHT_DATA_API_KEY missing");
  process.exit(1);
}
if (!DB_URL) {
  console.error("PIPELINE_DB_URL / SUPABASE_DB_URL missing");
  process.exit(1);
}
if (MODE === "async" && !ASYNC_ZONE) {
  console.error(
    "BRIGHT_DATA_TCGPLAYER_UNLOCKER_ASYNC_ZONE or BRIGHT_DATA_UNLOCKER_ASYNC_ZONE required for --mode async",
  );
  process.exit(1);
}
if (!cleanSecret(env.BRIGHT_DATA_TCGPLAYER_UNLOCKER_ZONE) && /ebay/i.test(SYNC_ZONE)) {
  console.error(
    "BRIGHT_DATA_TCGPLAYER_UNLOCKER_ZONE is required for liquidity; the fallback BRIGHT_DATA_UNLOCKER_ZONE appears eBay-specific.",
  );
  process.exit(1);
}

console.log(
  `[bulk-liquidity] auth key_len=${KEY.length} zone=${JSON.stringify(SYNC_ZONE)} async_zone=${ASYNC_ZONE ? "set" : "unset"}`,
);

const sql = postgres(DB_URL, { prepare: false, ssl: "require", max: CONCURRENCY + 2 });
const n = (v) =>
  v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const tcgHeaders = (pid) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://www.tcgplayer.com",
  Referer: `https://www.tcgplayer.com/product/${pid}/`,
});

function liquidityScore({ weeklyQtySold, activeListings, sellers, bidAskSpreadPct }) {
  const v = Math.min(55, weeklyQtySold * 4);
  const s = Math.min(25, sellers * 1.5);
  const d = activeListings === 0 ? 0 : Math.min(10, 4 + activeListings * 0.2);
  const sp =
    bidAskSpreadPct === null ? 5 : Math.max(0, 10 - Math.abs(bidAskSpreadPct) * 0.25);
  return Math.round(Math.min(100, v + s + d + sp));
}

function computeAbsorption(current, prior) {
  const EPS = 0.05;
  const round2 = (x) => Math.round(x * 100) / 100;
  const round4 = (x) => Math.round(x * 10000) / 10000;
  const consumptionRate =
    current.soldVelocity !== null && Number.isFinite(current.soldVelocity)
      ? round2(current.soldVelocity)
      : null;
  if (!prior) {
    return {
      listingsDelta: null,
      qtyDelta: null,
      consumptionRate,
      replenishmentRate: null,
      absorptionRatio: null,
      scoreDelta: 0,
    };
  }
  const days = Math.max(
    1 / 24,
    (current.asOf.getTime() - prior.asOf.getTime()) / (24 * 60 * 60 * 1000),
  );
  const listingsDelta =
    current.activeListings !== null && prior.activeListings !== null
      ? current.activeListings - prior.activeListings
      : null;
  const qtyDelta =
    current.totalQuantity !== null && prior.totalQuantity !== null
      ? current.totalQuantity - prior.totalQuantity
      : null;
  const depthDelta = qtyDelta !== null ? qtyDelta : listingsDelta;
  const replenishmentRate =
    depthDelta !== null && depthDelta > 0
      ? round2(depthDelta / days)
      : depthDelta !== null
        ? 0
        : null;
  let absorptionRatio = null;
  if (consumptionRate !== null && replenishmentRate !== null) {
    absorptionRatio = round4(consumptionRate / Math.max(replenishmentRate, EPS));
  }
  let scoreDelta = 0;
  if (absorptionRatio !== null) {
    if (absorptionRatio >= 2) scoreDelta = 10;
    else if (absorptionRatio >= 1) scoreDelta = 5;
    else if (absorptionRatio >= 0.5) scoreDelta = 0;
    else if (absorptionRatio >= 0.2) scoreDelta = -5;
    else scoreDelta = -10;
  } else if (consumptionRate !== null && consumptionRate > 0.5 && replenishmentRate === 0) {
    scoreDelta = 8;
  }
  return {
    listingsDelta,
    qtyDelta,
    consumptionRate,
    replenishmentRate,
    absorptionRatio,
    scoreDelta,
  };
}

function isTransientUnlockError(msg) {
  return /empty Unlocker body|aborted due to timeout|timeout|Unlocker 502|Unlocker 503|Unlocker 429|fetch failed|rate limit|ECONNRESET|socket/i.test(
    msg,
  );
}

function isFatalUnlockError(msg) {
  return /account is suspended|client_10020|proxy authentication required|invalid api key|credentials|zone .*not found|Unlocker 401|Unlocker 407/i.test(
    msg,
  );
}

async function waitZoneCooldown() {
  const wait = zoneCooldownUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function noteTransientFail() {
  consecutiveUnlockOk = 0;
  consecutiveTransientFails++;
  // After a burst of empties/502s, pause the whole pool — zone is saturated.
  if (consecutiveTransientFails >= 8) {
    cooldownLevel = Math.min(cooldownLevel + 1, 4);
    const coolMs = Math.min(180_000, 15_000 * Math.pow(2, cooldownLevel - 1));
    zoneCooldownUntil = Math.max(zoneCooldownUntil, Date.now() + coolMs);
    console.warn(
      `[bulk-liquidity] zone cooldown ${Math.round(coolMs / 1000)}s after transient burst (level ${cooldownLevel})`,
    );
    consecutiveTransientFails = 0;
  }
}

function noteUnlockOk() {
  consecutiveTransientFails = 0;
  consecutiveUnlockOk++;
  if (consecutiveUnlockOk >= 25 && cooldownLevel > 0) {
    cooldownLevel--;
    consecutiveUnlockOk = 0;
  }
}

function unwrapBrightDataResponse(text, url) {
  if (!text.trim()) throw new Error("empty Unlocker body");
  let wrapped;
  try {
    wrapped = JSON.parse(text);
  } catch {
    return text;
  }
  if (!wrapped || typeof wrapped !== "object" || !("status_code" in wrapped)) {
    return text;
  }

  const headers = wrapped.headers || {};
  const brdError =
    headers["x-brd-error"] ||
    headers["x-brd-error-code"] ||
    headers["x-brd-err-msg"] ||
    headers["x-brd-err-code"] ||
    headers["x-luminati-error"] ||
    headers["x-luminati-error-code"] ||
    wrapped.error ||
    wrapped.error_message;
  const status = Number(wrapped.status_code);
  if (brdError || status >= 400) {
    throw new Error(
      `Unlocker upstream ${Number.isFinite(status) ? status : "?"}: ${String(
        brdError || "unknown Bright Data error",
      ).slice(0, 220)}`,
    );
  }
  if (typeof wrapped.body === "string" && wrapped.body.trim()) return wrapped.body;
  throw new Error(`empty Unlocker body after upstream ${status || "?"} for ${url.slice(0, 120)}`);
}

async function syncUnlockOnce(url, { method = "GET", body, headers } = {}) {
  const payload = { zone: SYNC_ZONE, url, format: "json", country: "us" };
  if (method !== "GET") payload.method = method;
  if (body) payload.body = body;
  if (headers) payload.headers = headers;
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Unlocker ${res.status}: ${text.slice(0, 200)}`);
  return unwrapBrightDataResponse(text, url);
}

async function syncUnlock(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= UNLOCK_RETRIES; attempt++) {
    await waitZoneCooldown();
    try {
      const text = await syncUnlockOnce(url, opts);
      noteUnlockOk();
      return text;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (isFatalUnlockError(msg)) {
        fatalUnlockError = msg;
        break;
      }
      if (!isTransientUnlockError(msg) || attempt === UNLOCK_RETRIES) break;
      noteTransientFail();
      // 2s, 5s, 12s — give DataDome/Unlocker room to recover.
      const backoff = Math.round(2000 * Math.pow(2.2, attempt - 1));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  if (!isFatalUnlockError(lastErr instanceof Error ? lastErr.message : String(lastErr))) {
    noteTransientFail();
  }
  throw lastErr;
}

async function asyncUnlock(url, { method = "GET", body, headers } = {}) {
  const payload = { url, format: "raw" };
  if (method !== "GET") payload.method = method;
  if (body) payload.body = body;
  if (headers) payload.headers = headers;
  const submit = await fetch(`${ASYNC_SUBMIT}?zone=${encodeURIComponent(ASYNC_ZONE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`Async submit ${submit.status}: ${submitText.slice(0, 200)}`);
  let responseId = submit.headers.get("x-response-id")?.trim();
  if (!responseId) {
    try {
      responseId = JSON.parse(submitText).response_id;
    } catch {
      /* ignore */
    }
  }
  if (!responseId) throw new Error(`no response_id: ${submitText.slice(0, 200)}`);

  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < 10 * 60_000) {
    const wait = attempt === 0 ? 20_000 : attempt === 1 ? 10_000 : 5_000;
    await new Promise((r) => setTimeout(r, wait));
    attempt++;
    const res = await fetch(
      `${ASYNC_RESULT}?response_id=${encodeURIComponent(responseId)}`,
      { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60_000) },
    );
    if (res.status === 202) continue;
    const text = await res.text();
    if (!res.ok) throw new Error(`get_result ${res.status}: ${text.slice(0, 200)}`);
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* raw */
    }
    if (j && typeof j === "object") {
      const status = Number(j.status_code);
      const headers = j.headers || {};
      const brdError =
        headers["x-brd-error"] ||
        headers["x-brd-error-code"] ||
        headers["x-brd-err-msg"] ||
        headers["x-brd-err-code"] ||
        j.error ||
        j.error_message;
      if (brdError || status >= 400) {
        throw new Error(
          `Unlocker upstream ${Number.isFinite(status) ? status : "?"}: ${String(
            brdError || "unknown Bright Data error",
          ).slice(0, 220)}`,
        );
      }
      if (typeof j.body === "string") return j.body;
    }
    return text;
  }
  throw new Error(`async timeout ${responseId}`);
}

const unlock = MODE === "async" ? asyncUnlock : syncUnlock;

async function tcgDetails(pid) {
  let t;
  try {
    t = await unlock(`https://mp-search-api.tcgplayer.com/v2/product/${pid}/details`, {
      headers: tcgHeaders(pid),
    });
  } catch (e) {
    throw new Error(`details: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const j = JSON.parse(t);
    return {
      marketPrice: n(j.marketPrice),
      lowestPrice: n(j.lowestPrice),
      totalListings: n(j.listings),
      totalSellers: n(j.sellers),
    };
  } catch {
    return null;
  }
}

function analyzeListingLadder(listings, partial) {
  const byLanded = new Map();
  for (const l of listings) {
    const qty = n(l.quantity) || 0;
    const price = n(l.price) || 0;
    if (qty <= 0 || price <= 0) continue;
    const landed = Math.round((price + (n(l.shippingPrice) || 0)) * 100) / 100;
    byLanded.set(landed, (byLanded.get(landed) || 0) + qty);
  }
  const prices = [...byLanded.keys()].sort((a, b) => a - b);
  const levels = [];
  let cumQty = 0;
  let cumCost = 0;
  for (const landed of prices) {
    const qty = byLanded.get(landed) || 0;
    cumQty += qty;
    cumCost = Math.round((cumCost + landed * qty) * 100) / 100;
    levels.push({ landed, qty, cumQty, cumCost });
  }
  const gaps = [];
  for (let i = 0; i < levels.length - 1; i++) {
    const from = levels[i];
    const to = levels[i + 1];
    const gapUsd = Math.round((to.landed - from.landed) * 100) / 100;
    const gapPct = from.landed > 0 ? Math.round((gapUsd / from.landed) * 1000) / 10 : 0;
    if (gapPct < 15 && gapUsd < 1) continue;
    gaps.push({
      fromLanded: from.landed,
      toLanded: to.landed,
      gapUsd,
      gapPct,
      qtyToClear: from.cumQty,
      costToClear: from.cumCost,
    });
    if (gaps.length >= 12) break;
  }
  const stored =
    levels.length <= 80
      ? levels
      : levels.filter(
          (_, i) => i === 0 || i === levels.length - 1 || i % Math.ceil(levels.length / 60) === 0,
        );
  return {
    buyoutUsd: cumCost,
    buyoutQty: cumQty,
    listingRows: listings.length,
    lowestLanded: levels[0]?.landed ?? null,
    highestLanded: levels[levels.length - 1]?.landed ?? null,
    partial: Boolean(partial),
    gaps,
    levels: stored,
  };
}

async function tcgListings(pid, printing, maxPages = LISTINGS_MAX_PAGES) {
  let total = 0;
  let qty = 0;
  let lowest = null;
  let fetched = 0;
  const sellers = new Set();
  const rows = [];
  const pageCap = Math.max(1, maxPages);

  for (let page = 0; page < pageCap; page++) {
    const term = { sellerStatus: "Live" };
    // Warehouse sub_type === TCG printing (Normal, Holofoil, Reverse Holofoil, …).
    if (printing) term.printing = printing;
    const body = JSON.stringify({
      filters: {
        term,
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
      from: page * LISTINGS_PAGE_SIZE,
      size: LISTINGS_PAGE_SIZE,
      sort: { field: "price+shipping", order: "asc" },
      context: { shippingCountry: "US", cart: {} },
      aggregations: ["listingType"],
    });
    let t;
    try {
      t = await unlock(`https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`, {
        method: "POST",
        body,
        headers: tcgHeaders(pid),
      });
    } catch (e) {
      throw new Error(`listings page ${page + 1}: ${e instanceof Error ? e.message : e}`);
    }
    let batch = [];
    try {
      const inner = (JSON.parse(t).results || [{}])[0] || {};
      total = n(inner.totalResults) || total;
      batch = inner.results || [];
    } catch {
      break;
    }
    if (page === 0 && batch.length) {
      const first = batch[0];
      lowest = (n(first.price) || 0) + (n(first.shippingPrice) || 0) || n(first.price);
    }
    for (const l of batch) {
      const q = n(l.quantity) || 0;
      qty += q;
      if (l.sellerName) sellers.add(l.sellerName);
      rows.push({
        price: n(l.price) || 0,
        shippingPrice: n(l.shippingPrice) || 0,
        quantity: q,
      });
    }
    fetched += batch.length;
    if (batch.length < LISTINGS_PAGE_SIZE) break;
    if (total > 0 && fetched >= total) break;
  }

  const partial = total > 0 && fetched < total;
  return {
    total: total || fetched,
    qty,
    lowest,
    sellers: sellers.size,
    pages: Math.ceil(fetched / LISTINGS_PAGE_SIZE) || 0,
    printing: printing || null,
    partial,
    ladder: analyzeListingLadder(rows, partial),
  };
}

async function tcgSales(pid) {
  let t;
  try {
    t = await unlock(
      `https://infinite-api.tcgplayer.com/price/history/${pid}/detailed?range=quarter`,
      { headers: tcgHeaders(pid) },
    );
  } catch (e) {
    throw new Error(`sales: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return JSON.parse(t).result || [];
  } catch {
    return [];
  }
}

function aggVelocity(series, weeks = 13, variant) {
  let qty = 0,
    txns = 0;
  const seen = new Set();
  const filtered =
    variant != null && variant !== ""
      ? series.filter(
          (s) => String(s.variant || "").toLowerCase() === String(variant).toLowerCase(),
        )
      : series;
  for (const s of filtered) {
    for (const b of (s.buckets || []).slice(0, weeks)) {
      qty += n(b.quantitySold) || 0;
      txns += n(b.transactionCount) || 0;
      seen.add(b.bucketStartDate);
    }
  }
  const w = seen.size || 1;
  const days = Math.max(1, w * 7);
  return {
    qty,
    txns,
    weeks: seen.size,
    perDay: Math.round((qty / days) * 100) / 100,
  };
}

async function selectTargets() {
  // When listings are on, also re-hit rows missing exact total_quantity.
  return sql`
    select w.product_id, w.sub_type, w.market, p.name,
           l.as_of as liq_as_of, l.total_quantity,
           null::text as tier, null::numeric as queue_score
    from price_windows w
    join products p on p.product_id = w.product_id
    left join liquidity l
      on l.product_id = w.product_id
     and l.sub_type = w.sub_type
     and l.source = 'tcgplayer'
    where not p.is_sealed
      and w.market is not null
      and w.market < ${MAX_MARKET}
      and (
        l.as_of is null
        or l.as_of < now() - (${STALE_HOURS}::text || ' hours')::interval
        or (
          ${INCLUDE_LISTINGS}
          and (
            l.total_quantity is null
            or l.raw->>'printing' is distinct from w.sub_type
          )
        )
      )
    order by
      (l.total_quantity is null) desc,
      (l.raw->>'printing' is distinct from w.sub_type) desc,
      l.as_of nulls first,
      w.market desc
    limit ${LIMIT}
  `;
}

/** Load today's ranked queue; dedupe so spotlight wins over trend for the same series. */
async function selectFromQueue() {
  const day = QUEUE_DATE || new Date().toISOString().slice(0, 10);
  const rows = await sql`
    select distinct on (q.product_id, q.sub_type)
      q.product_id, q.sub_type, q.tier, q.score as queue_score,
      q.group_id, q.queued_for,
      w.market, p.name,
      l.as_of as liq_as_of, l.total_quantity
    from liquidity_scrape_queue q
    join products p on p.product_id = q.product_id
    left join price_windows w
      on w.product_id = q.product_id and w.sub_type = q.sub_type
    left join liquidity l
      on l.product_id = q.product_id
     and l.sub_type = q.sub_type
     and l.source = 'tcgplayer'
    where q.queued_for = ${day}::date
      and q.status = 'pending'
    order by
      q.product_id, q.sub_type,
      (q.tier = 'spotlight') desc,
      q.score desc
  `;
  return rows;
}

async function markQueueStatus(productId, subType, tier, status) {
  const day = QUEUE_DATE || new Date().toISOString().slice(0, 10);
  if (tier) {
    await sql`
      update liquidity_scrape_queue
      set status = ${status}
      where product_id = ${productId}
        and sub_type = ${subType}
        and tier = ${tier}
        and queued_for = ${day}::date
    `;
    return;
  }
  // Dedupe path: mark both tiers for the series.
  await sql`
    update liquidity_scrape_queue
    set status = ${status}
    where product_id = ${productId}
      and sub_type = ${subType}
      and queued_for = ${day}::date
      and status in ('pending', 'running')
  `;
}

async function priorSnapshot(productId, subType) {
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
    activeListings: n(r.active_listings),
    totalQuantity: n(r.total_quantity),
    soldVelocity: n(r.sold_velocity),
  };
}

function rowScrapePlan(row) {
  const tier = row.tier ? String(row.tier) : null;
  if (tier === "spotlight") {
    return {
      tier,
      includeListings: true,
      listingsMaxPages: SPOTLIGHT_LISTINGS_MAX_PAGES,
      endpoints: ["details", "sales", "listings"],
    };
  }
  if (tier === "trend") {
    return {
      tier,
      includeListings: false,
      listingsMaxPages: 0,
      endpoints: ["details", "sales"],
    };
  }
  // Legacy / CLI endpoint flags.
  return {
    tier: null,
    includeListings: INCLUDE_LISTINGS,
    listingsMaxPages: LISTINGS_MAX_PAGES,
    endpoints: ENDPOINTS,
  };
}

async function enrichOne(row) {
  const pid = Number(row.product_id);
  const subType = String(row.sub_type);
  const plan = rowScrapePlan(row);
  const prior = await priorSnapshot(pid, subType);

  const jobs = [tcgDetails(pid), tcgSales(pid)];
  if (plan.includeListings) jobs.push(tcgListings(pid, subType, plan.listingsMaxPages));
  const results = await Promise.all(jobs);
  const details = results[0];
  const series = results[1];
  const listings = plan.includeListings ? results[2] : null;

  const vel = aggVelocity(series, 13, subType);
  // Listing stats are printing-scoped; details API is product-wide — prefer listings.
  const activeListings = listings?.total ?? details?.totalListings ?? 0;
  const totalQuantity = listings?.qty ?? null;
  const sellers = listings?.sellers ?? details?.totalSellers ?? 0;
  const market = n(row.market) ?? details?.marketPrice;
  const lowestAsk = listings?.lowest ?? details?.lowestPrice ?? null;
  const bidAskSpreadPct =
    lowestAsk !== null && market
      ? Math.round(((lowestAsk - market) / market) * 1000) / 10
      : null;

  const baseScore = liquidityScore({
    weeklyQtySold: vel.weeks ? vel.qty / vel.weeks : 0,
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
  const score = Math.round(
    Math.min(100, Math.max(0, baseScore + absorption.scoreDelta)),
  );

  await sql`
    insert into liquidity
      (product_id, sub_type, source, as_of, active_listings, total_quantity,
       total_qty_sold_90d, total_txn_90d, sold_velocity, bid_ask_spread_pct,
       liquidity_score, sellers, consumption_rate, replenishment_rate,
       absorption_ratio, raw)
    values
      (${pid}, ${subType}, 'tcgplayer', ${now},
       ${activeListings}, ${totalQuantity},
       ${vel.qty}, ${vel.txns}, ${vel.perDay}, ${bidAskSpreadPct},
       ${score}, ${sellers}, ${absorption.consumptionRate},
       ${absorption.replenishmentRate}, ${absorption.absorptionRatio},
       ${sql.json({
         marketPrice: market,
         lowestAsk,
         sellers,
         velocityWeeks: vel.weeks,
         name: row.name,
         mode: MODE,
         tier: plan.tier,
         endpoints: plan.endpoints,
         printing: subType,
         listingsPages: listings?.pages ?? null,
         listingRowsFetched: listings?.total ?? null,
         totalQuantity: totalQuantity,
         baseScore,
         absorptionScoreDelta: absorption.scoreDelta,
         listingLadder: listings?.ladder ?? null,
       })})
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
      (${pid}, ${subType}, 'tcgplayer', ${now},
       ${activeListings}, ${totalQuantity}, ${sellers}, ${vel.perDay},
       ${vel.qty}, ${bidAskSpreadPct}, ${score},
       ${absorption.listingsDelta}, ${absorption.qtyDelta},
       ${absorption.consumptionRate}, ${absorption.replenishmentRate},
       ${absorption.absorptionRatio})
  `;

  return { pid, subType, score, soldPerDay: vel.perDay, activeListings };
}

async function mapPool(items, concurrency, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length && !fatalUnlockError) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function main() {
  console.log(
    `[bulk-liquidity] from_queue=${FROM_QUEUE} max_market=${MAX_MARKET} stale_hours=${STALE_HOURS} limit=${LIMIT} concurrency=${CONCURRENCY} mode=${MODE} endpoints=${ENDPOINTS.join(",")} spotlight_listings_pages=${SPOTLIGHT_LISTINGS_MAX_PAGES}`,
  );

  console.log(`[bulk-liquidity] preflight product=${PREFLIGHT_PRODUCT_ID}`);
  await tcgDetails(PREFLIGHT_PRODUCT_ID);
  if (fatalUnlockError) throw new Error(`preflight failed: ${fatalUnlockError}`);

  const runRows = await sql`
    insert into ingest_runs (kind, status, detail)
    values ('liquidity', 'running', ${sql.json({
      fromQueue: FROM_QUEUE,
      queueDate: QUEUE_DATE,
      maxMarket: MAX_MARKET,
      staleHours: STALE_HOURS,
      limit: LIMIT,
      concurrency: CONCURRENCY,
      mode: MODE,
      endpoints: ENDPOINTS,
      spotlightListingsPages: SPOTLIGHT_LISTINGS_MAX_PAGES,
    })})
    returning id
  `;
  const runId = runRows[0].id;

  const targets = FROM_QUEUE ? await selectFromQueue() : await selectTargets();
  const trendN = targets.filter((t) => t.tier === "trend").length;
  const spotN = targets.filter((t) => t.tier === "spotlight").length;
  console.log(
    `[bulk-liquidity] selected ${targets.length} series` +
      (FROM_QUEUE ? ` (trend=${trendN} spotlight=${spotN} after dedupe)` : ""),
  );

  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  await mapPool(targets, CONCURRENCY, async (row, idx) => {
    const pid = Number(row.product_id);
    const subType = String(row.sub_type);
    try {
      if (FROM_QUEUE) await markQueueStatus(pid, subType, null, "running");
      const r = await enrichOne(row);
      ok++;
      if (FROM_QUEUE) await markQueueStatus(pid, subType, null, "done");
      if ((idx + 1) % 10 === 0 || idx === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = ok / Math.max(1, (Date.now() - t0) / 1000);
        console.log(
          `[bulk-liquidity] ${idx + 1}/${targets.length} ok=${ok} fail=${fail} ${elapsed}s ~${rate.toFixed(2)}/s last=${r.pid} score=${r.score} tier=${row.tier || "legacy"}`,
        );
      }
    } catch (e) {
      fail++;
      if (FROM_QUEUE) {
        try {
          await markQueueStatus(pid, subType, null, "error");
        } catch {
          /* ignore status update failure */
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (isFatalUnlockError(msg)) fatalUnlockError = msg;
      console.error(
        `[bulk-liquidity] FAIL ${row.product_id}/${row.sub_type}: ${msg}`,
      );
    }
  });

  const elapsedMs = Date.now() - t0;
  const attempted = ok + fail;
  const failRate = attempted ? fail / attempted : 0;
  const hardFail = fail > 0 && (ok === 0 || failRate > MAX_FAIL_RATE);
  await sql`
    update ingest_runs
    set finished_at = now(),
        status = ${hardFail ? "error" : "ok"},
        rows = ${ok},
        detail = ${sql.json({
          fromQueue: FROM_QUEUE,
          queueDate: QUEUE_DATE,
          maxMarket: MAX_MARKET,
          staleHours: STALE_HOURS,
          limit: LIMIT,
          concurrency: CONCURRENCY,
          mode: MODE,
          endpoints: ENDPOINTS,
          spotlightListingsPages: SPOTLIGHT_LISTINGS_MAX_PAGES,
          selected: targets.length,
          trendSelected: trendN,
          spotlightSelected: spotN,
          ok,
          fail,
          fatalUnlockError,
          failRate,
          unlockRetries: UNLOCK_RETRIES,
          elapsedMs,
          cardsPerSec: ok / Math.max(1, elapsedMs / 1000),
        })}
    where id = ${runId}
  `;

  console.log(
    `[bulk-liquidity] done ok=${ok} fail=${fail} failRate=${(failRate * 100).toFixed(1)}% ${(elapsedMs / 1000).toFixed(1)}s run_id=${runId}`,
  );
  await sql.end({ timeout: 5 });
  // Non-zero exit so GHA is red unless the pass is clean enough to continue.
  process.exit(hardFail || fatalUnlockError ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sql.end({ timeout: 2 });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
