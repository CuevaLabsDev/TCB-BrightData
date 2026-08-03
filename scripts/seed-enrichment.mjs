// Seed liquidity + graded comps for demo hero cards via live Bright Data.
// Mirrors src/lib/bright-data/{tcgplayer,ebay,enrich}.ts so we can populate the
// warehouse without a running Next server. Run: node scripts/seed-enrichment.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import * as cheerio from "cheerio";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const API = "https://api.brightdata.com/request";
const KEY = env.BRIGHT_DATA_API_KEY;
const UNLOCK = env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";
const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

const n = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const tcgHeaders = (pid) => ({ "Content-Type": "application/json", Accept: "application/json", Origin: "https://www.tcgplayer.com", Referer: `https://www.tcgplayer.com/product/${pid}/` });

async function bd(url, { method = "GET", body, headers } = {}) {
  const payload = { zone: UNLOCK, url, format: "raw" };
  if (method !== "GET") payload.method = method;
  if (body) payload.body = body;
  if (headers) payload.headers = headers;
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  return res.text();
}

async function tcgDetails(pid) {
  const t = await bd(`https://mp-search-api.tcgplayer.com/v2/product/${pid}/details`, { headers: tcgHeaders(pid) });
  try { const j = JSON.parse(t); return { marketPrice: n(j.marketPrice), lowestPrice: n(j.lowestPrice), totalListings: n(j.listings), totalSellers: n(j.sellers), setName: j.setName }; }
  catch { return null; }
}
async function tcgListings(pid) {
  const size = 50;
  let total = 0, qty = 0, listings = [];
  for (let page = 0; page < 50; page++) {
    const body = JSON.stringify({ filters: { term: { sellerStatus: "Live" }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } }, from: page * size, size, sort: { field: "price+shipping", order: "asc" }, context: { shippingCountry: "US", cart: {} }, aggregations: ["listingType"] });
    const t = await bd(`https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`, { method: "POST", body, headers: tcgHeaders(pid) });
    let batch = [];
    try {
      const inner = (JSON.parse(t).results || [{}])[0] || {};
      total = n(inner.totalResults) || total;
      batch = inner.results || [];
    } catch { break; }
    listings = listings.concat(batch);
    for (const l of batch) qty += n(l.quantity) || 0;
    if (batch.length < size) break;
    if (total > 0 && listings.length >= total) break;
  }
  return { total: total || listings.length, listings, qty };
}
async function tcgSales(pid) {
  const t = await bd(`https://infinite-api.tcgplayer.com/price/history/${pid}/detailed?range=quarter`, { headers: tcgHeaders(pid) });
  try { return JSON.parse(t).result || []; } catch { return []; }
}
function aggVelocity(series, weeks = 13) {
  let qty = 0, txns = 0; const seen = new Set();
  for (const s of series) for (const b of (s.buckets || []).slice(0, weeks)) { qty += n(b.quantitySold) || 0; txns += n(b.transactionCount) || 0; seen.add(b.bucketStartDate); }
  const w = seen.size || 1; const days = Math.max(1, w * 7);
  return { qty, txns, weeks: seen.size, perDay: Math.round((qty / days) * 100) / 100 };
}
function liquidityScore({ weeklyQtySold, activeListings, sellers, bidAskSpreadPct }) {
  const v = Math.min(55, weeklyQtySold * 4);
  const s = Math.min(25, sellers * 1.5);
  const d = activeListings === 0 ? 0 : Math.min(10, 4 + activeListings * 0.2);
  const sp = bidAskSpreadPct === null ? 5 : Math.max(0, 10 - Math.abs(bidAskSpreadPct) * 0.25);
  return Math.round(Math.min(100, v + s + d + sp));
}

function parsePrice(t) { const m = (t || "").replace(/,/g, "").match(/\$\s?(\d+(?:\.\d{1,2})?)/); return m ? Number(m[1]) : null; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
async function ebayGraded(query, grade) {
  const p = new URLSearchParams({ _nkw: `${query} PSA ${grade}`, _ipg: "60", LH_Sold: "1", LH_Complete: "1" });
  const html = await bd(`https://www.ebay.com/sch/i.html?${p.toString()}`);
  const $ = cheerio.load(html);
  const prices = [];
  $("li.s-item, .s-card").each((_, el) => {
    const node = $(el);
    const title = node.find(".s-item__title, .s-card__title").first().text().trim();
    if (!title || /shop on ebay/i.test(title)) return;
    const pr = parsePrice(node.find(".s-item__price, .s-card__price").first().text());
    if (pr !== null) prices.push(pr);
  });
  let clean = prices.filter((x) => x > 0);
  const med = median(clean);
  if (med !== null) clean = clean.filter((x) => x >= med * 0.1 && x <= med * 10);
  return { count: clean.length, median: med !== null ? Math.round(med * 100) / 100 : null, avg: clean.length ? Math.round(clean.reduce((a, b) => a + b, 0) / clean.length * 100) / 100 : null, low: clean.length ? Math.min(...clean) : null, high: clean.length ? Math.max(...clean) : null };
}

const HERO = [
  { pid: 610516, sub: "Holofoil", q: "Umbreon ex 161/131 Prismatic Evolutions", graded: true },
  { pid: 676088, sub: "Holofoil", q: "Pikachu ex 276/217 Ascended Heroes", graded: true },
  { pid: 246733, sub: "Holofoil", q: "Rayquaza VMAX Alternate Art 218 Evolving Skies", graded: true },
  { pid: 662184, sub: "Holofoil", q: "Mega Charizard X ex 125/094 Phantasmal Flames", graded: true },
  { pid: 90139, sub: "Holofoil", q: "Umbreon H29 Aquapolis", graded: true },
  { pid: 86912, sub: "Holofoil", q: "Lugia ex Unseen Forces", graded: true },
];

for (const card of HERO) {
  process.stdout.write(`\n[${card.pid}] ${card.q}\n`);
  try {
    const [details, listingsData, series] = await Promise.all([tcgDetails(card.pid), tcgListings(card.pid), tcgSales(card.pid)]);
    const vel = aggVelocity(series, 13);
    const active = details?.totalListings ?? listingsData.total;
    const sellers = details?.totalSellers ?? 0;
    const market = details?.marketPrice;
    const lowestAsk = details?.lowestPrice ?? (listingsData.listings[0] ? n(listingsData.listings[0].price) : null);
    const spread = lowestAsk !== null && market ? Math.round(((lowestAsk - market) / market) * 1000) / 10 : null;
    const score = liquidityScore({ weeklyQtySold: vel.weeks ? vel.qty / vel.weeks : 0, activeListings: active, sellers, bidAskSpreadPct: spread });
    console.log(`  TCG: market=$${market} lowAsk=$${lowestAsk} listings=${active} sellers=${sellers} | sold ${vel.qty}q/${vel.txns}txn over ${vel.weeks}w (${vel.perDay}/day) | spread=${spread}% | SCORE=${score}`);
    await sql`
      insert into liquidity (product_id, sub_type, source, as_of, active_listings, total_quantity, total_qty_sold_90d, total_txn_90d, sold_velocity, bid_ask_spread_pct, liquidity_score, raw)
      values (${card.pid}, ${card.sub}, 'tcgplayer', now(), ${active}, ${listingsData.qty}, ${vel.qty}, ${vel.txns}, ${vel.perDay}, ${spread}, ${score}, ${sql.json({ marketPrice: market, lowestAsk, sellers, velocityWeeks: vel.weeks, query: card.q })})
      on conflict (product_id, sub_type, source) do update set as_of=excluded.as_of, active_listings=excluded.active_listings, total_quantity=excluded.total_quantity, total_qty_sold_90d=excluded.total_qty_sold_90d, total_txn_90d=excluded.total_txn_90d, sold_velocity=excluded.sold_velocity, bid_ask_spread_pct=excluded.bid_ask_spread_pct, liquidity_score=excluded.liquidity_score, raw=excluded.raw`;
    if (card.graded) {
      for (const grade of [10, 9]) {
        const scan = await ebayGraded(card.q, grade);
        if (scan.count === 0) { console.log(`  PSA ${grade}: no comps`); continue; }
        const mult = market && scan.median ? Math.round((scan.median / market) * 100) / 100 : null;
        console.log(`  PSA ${grade}: median=$${scan.median} (n=${scan.count}, $${scan.low}-$${scan.high}) | raw=$${market} | ${mult}x`);
        await sql`
          insert into graded_comps (product_id, grader, grade, source, as_of, sample_size, avg_sold, last_sold, low_sold, high_sold, raw_market, grade_multiple, raw)
          values (${card.pid}, 'PSA', ${grade}, 'ebay', now(), ${scan.count}, ${scan.avg}, ${scan.median}, ${scan.low}, ${scan.high}, ${market}, ${mult}, ${sql.json({ query: `${card.q} PSA ${grade}` })})`;
      }
    }
  } catch (e) { console.log("  ERROR:", e.message); }
}

await sql.end();
console.log("\nDone seeding enrichment.");
