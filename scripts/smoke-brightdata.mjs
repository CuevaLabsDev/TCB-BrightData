// Standalone smoke test for Bright Data zones (no Next runtime).
// Usage: node scripts/smoke-brightdata.mjs
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
const SERP = env.BRIGHT_DATA_SERP_ZONE || "serp_api1";
const UNLOCK = env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";

async function req(zone, url) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

console.log("KEY present:", Boolean(KEY), "| SERP zone:", SERP, "| Unlocker zone:", UNLOCK);

console.log("\n[1] SERP API — google search 'charizard 151 tcgplayer'");
try {
  const q = new URLSearchParams({ q: "charizard ex 151 tcgplayer price", brd_json: "1" }).toString();
  const r = await req(SERP, `https://www.google.com/search?${q}`);
  console.log("  status:", r.status);
  try {
    const j = JSON.parse(r.text);
    console.log("  organic results:", (j.organic || []).length);
    for (const o of (j.organic || []).slice(0, 3)) console.log("   -", o.title, "|", o.link);
  } catch {
    console.log("  (non-JSON) first 200:", r.text.slice(0, 200));
  }
} catch (e) {
  console.log("  ERROR:", e.message);
}

console.log("\n[2] Web Unlocker — eBay sold listings for 'umbreon ex 161 psa 10'");
try {
  const url = "https://www.ebay.com/sch/i.html?_nkw=umbreon+ex+161+psa+10&LH_Sold=1&LH_Complete=1";
  const r = await req(UNLOCK, url);
  console.log("  status:", r.status, "| html length:", r.text.length);
  const m = r.text.match(/\$[\d,]+\.\d{2}/g) || [];
  console.log("  sample prices found:", m.slice(0, 8));
} catch (e) {
  console.log("  ERROR:", e.message);
}
