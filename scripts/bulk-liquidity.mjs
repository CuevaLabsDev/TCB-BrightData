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
 *
 * Env: SUPABASE_DB_URL | PIPELINE_DB_URL, BRIGHT_DATA_API_KEY,
 *      BRIGHT_DATA_UNLOCKER_ZONE [, BRIGHT_DATA_UNLOCKER_ASYNC_ZONE]
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
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "8")));
const MODE = String(arg("mode", "sync")); // sync | async
const ENDPOINTS = String(arg("endpoints", "details,sales"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_LISTINGS = ENDPOINTS.includes("listings");

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
const SYNC_ZONE = cleanSecret(env.BRIGHT_DATA_UNLOCKER_ZONE) || "tcb_1";
const ASYNC_ZONE = cleanSecret(env.BRIGHT_DATA_UNLOCKER_ASYNC_ZONE);
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
  console.error("BRIGHT_DATA_UNLOCKER_ASYNC_ZONE required for --mode async");
  process.exit(1);
}

console.log(
  `[bulk-liquidity] auth key_len=${KEY.length} zone=${JSON.stringify(SYNC_ZONE)}`,
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

async function syncUnlock(url, { method = "GET", body, headers } = {}) {
  const payload = { zone: SYNC_ZONE, url, format: "raw" };
  if (method !== "GET") payload.method = method;
  if (body) payload.body = body;
  if (headers) payload.headers = headers;
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Unlocker ${res.status}: ${text.slice(0, 200)}`);
  if (!text.trim()) throw new Error("empty Unlocker body");
  return text;
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
    try {
      const j = JSON.parse(text);
      if (typeof j.body === "string") return j.body;
    } catch {
      /* raw */
    }
    return text;
  }
  throw new Error(`async timeout ${responseId}`);
}

const unlock = MODE === "async" ? asyncUnlock : syncUnlock;

async function tcgDetails(pid) {
  const t = await unlock(
    `https://mp-search-api.tcgplayer.com/v2/product/${pid}/details`,
    { headers: tcgHeaders(pid) },
  );
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

async function tcgListings(pid) {
  const body = JSON.stringify({
    filters: {
      term: { sellerStatus: "Live" },
      range: { quantity: { gte: 1 } },
      exclude: { channelExclusion: 0 },
    },
    from: 0,
    size: 50,
    sort: { field: "price+shipping", order: "asc" },
    context: { shippingCountry: "US", cart: {} },
    aggregations: ["listingType"],
  });
  const t = await unlock(
    `https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`,
    { method: "POST", body, headers: tcgHeaders(pid) },
  );
  try {
    const inner = (JSON.parse(t).results || [{}])[0];
    const ls = inner.results || [];
    return {
      total: n(inner.totalResults) || ls.length,
      qty: ls.reduce((s, l) => s + (n(l.quantity) || 0), 0),
      lowest: ls.length ? n(ls[0].price) : null,
    };
  } catch {
    return { total: 0, qty: 0, lowest: null };
  }
}

async function tcgSales(pid) {
  const t = await unlock(
    `https://infinite-api.tcgplayer.com/price/history/${pid}/detailed?range=quarter`,
    { headers: tcgHeaders(pid) },
  );
  try {
    return JSON.parse(t).result || [];
  } catch {
    return [];
  }
}

function aggVelocity(series, weeks = 13) {
  let qty = 0,
    txns = 0;
  const seen = new Set();
  for (const s of series) {
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
  return sql`
    select w.product_id, w.sub_type, w.market, p.name,
           l.as_of as liq_as_of
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
      )
    order by l.as_of nulls first, w.market desc
    limit ${LIMIT}
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

async function enrichOne(row) {
  const pid = Number(row.product_id);
  const subType = String(row.sub_type);
  const prior = await priorSnapshot(pid, subType);

  const jobs = [tcgDetails(pid), tcgSales(pid)];
  if (INCLUDE_LISTINGS) jobs.push(tcgListings(pid));
  const results = await Promise.all(jobs);
  const details = results[0];
  const series = results[1];
  const listings = INCLUDE_LISTINGS ? results[2] : null;

  const vel = aggVelocity(series, 13);
  const activeListings = details?.totalListings ?? listings?.total ?? 0;
  const totalQuantity = listings?.qty ?? null;
  const sellers = details?.totalSellers ?? 0;
  const market = details?.marketPrice ?? n(row.market);
  const lowestAsk = details?.lowestPrice ?? listings?.lowest ?? null;
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
         endpoints: ENDPOINTS,
         baseScore,
         absorptionScoreDelta: absorption.scoreDelta,
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
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function main() {
  console.log(
    `[bulk-liquidity] max_market=${MAX_MARKET} stale_hours=${STALE_HOURS} limit=${LIMIT} concurrency=${CONCURRENCY} mode=${MODE} endpoints=${ENDPOINTS.join(",")}`,
  );

  const runRows = await sql`
    insert into ingest_runs (kind, status, detail)
    values ('liquidity', 'running', ${sql.json({
      maxMarket: MAX_MARKET,
      staleHours: STALE_HOURS,
      limit: LIMIT,
      concurrency: CONCURRENCY,
      mode: MODE,
      endpoints: ENDPOINTS,
    })})
    returning id
  `;
  const runId = runRows[0].id;

  const targets = await selectTargets();
  console.log(`[bulk-liquidity] selected ${targets.length} series`);

  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  await mapPool(targets, CONCURRENCY, async (row, idx) => {
    try {
      const r = await enrichOne(row);
      ok++;
      if ((idx + 1) % 10 === 0 || idx === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = ok / Math.max(1, (Date.now() - t0) / 1000);
        console.log(
          `[bulk-liquidity] ${idx + 1}/${targets.length} ok=${ok} fail=${fail} ${elapsed}s ~${rate.toFixed(2)}/s last=${r.pid} score=${r.score}`,
        );
      }
    } catch (e) {
      fail++;
      console.error(
        `[bulk-liquidity] FAIL ${row.product_id}/${row.sub_type}: ${e instanceof Error ? e.message : e}`,
      );
    }
  });

  const elapsedMs = Date.now() - t0;
  await sql`
    update ingest_runs
    set finished_at = now(),
        status = ${fail && !ok ? "error" : "ok"},
        rows = ${ok},
        detail = ${sql.json({
          maxMarket: MAX_MARKET,
          staleHours: STALE_HOURS,
          limit: LIMIT,
          concurrency: CONCURRENCY,
          mode: MODE,
          endpoints: ENDPOINTS,
          selected: targets.length,
          ok,
          fail,
          elapsedMs,
          cardsPerSec: ok / Math.max(1, elapsedMs / 1000),
        })}
    where id = ${runId}
  `;

  console.log(
    `[bulk-liquidity] done ok=${ok} fail=${fail} ${(elapsedMs / 1000).toFixed(1)}s run_id=${runId}`,
  );
  await sql.end({ timeout: 5 });
  process.exit(fail && !ok ? 1 : 0);
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
