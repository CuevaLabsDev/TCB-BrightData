// Validate: can Bright Data Web Unlocker reach TCGplayer's internal JSON APIs?
// Endpoints learned from tcb-collector/providers/tcgplayer.py
import { readFileSync } from "node:fs";

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
const PID = 610516; // Umbreon ex 161/131 Prismatic Evolutions

async function bd(url, { method = "GET", body } = {}) {
  const payload = { zone: UNLOCK, url, format: "raw" };
  if (method !== "GET") payload.method = method;
  if (body) payload.data = body;
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

console.log("[A] GET v2/product/{id}/details");
try {
  const r = await bd(`https://mp-search-api.tcgplayer.com/v2/product/${PID}/details`);
  console.log("  status:", r.status);
  try {
    const j = JSON.parse(r.text);
    console.log("  productName:", j.productName, "| setName:", j.setName);
    console.log("  marketPrice:", j.marketPrice, "medianPrice:", j.medianPrice, "lowestPrice:", j.lowestPrice);
    console.log("  totalListings:", j.listings, "totalSellers:", j.sellers);
  } catch { console.log("  non-JSON first 250:", r.text.slice(0, 250)); }
} catch (e) { console.log("  ERROR:", e.message); }

console.log("\n[B] GET infinite-api price/history detailed (sales velocity)");
try {
  const r = await bd(`https://infinite-api.tcgplayer.com/price/history/${PID}/detailed?range=quarter`);
  console.log("  status:", r.status);
  try {
    const j = JSON.parse(r.text);
    const result = j.result || [];
    console.log("  sku series:", result.length);
    if (result[0]) {
      console.log("  first sku:", result[0].variant, result[0].condition, "| buckets:", (result[0].buckets || []).length);
      const b = (result[0].buckets || [])[0];
      if (b) console.log("  latest bucket:", JSON.stringify(b));
    }
  } catch { console.log("  non-JSON first 250:", r.text.slice(0, 250)); }
} catch (e) { console.log("  ERROR:", e.message); }

console.log("\n[C] POST v1/product/{id}/listings (depth, page 1)");
try {
  const listingBody = JSON.stringify({
    filters: { term: { sellerStatus: "Live" }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
    from: 0, size: 50, sort: { field: "price+shipping", order: "asc" },
    context: { shippingCountry: "US", cart: {} }, aggregations: ["listingType"],
  });
  const r = await bd(`https://mp-search-api.tcgplayer.com/v1/product/${PID}/listings`, { method: "POST", body: listingBody });
  console.log("  status:", r.status);
  try {
    const j = JSON.parse(r.text);
    const inner = (j.results || [{}])[0];
    console.log("  totalResults:", inner.totalResults, "| listings in page:", (inner.results || []).length);
    const l = (inner.results || [])[0];
    if (l) console.log("  cheapest:", l.price, "+", l.shippingPrice, "ship |", l.condition, l.printing, "| seller:", l.sellerName, l.sellerRating);
  } catch { console.log("  non-JSON first 250:", r.text.slice(0, 250)); }
} catch (e) { console.log("  ERROR:", e.message); }
