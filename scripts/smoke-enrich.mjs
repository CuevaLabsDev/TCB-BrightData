// Smoke test the eBay parser quality against live Bright Data (no DB writes).
import { readFileSync } from "node:fs";
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

async function unlock(url) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: UNLOCK, url, format: "raw" }),
    signal: AbortSignal.timeout(60000),
  });
  return res.text();
}
function parsePrice(t) { const m = (t||"").replace(/,/g,"").match(/\$\s?(\d+(?:\.\d{1,2})?)/); return m?Number(m[1]):null; }
function median(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}

async function scan(query, sold) {
  const p = new URLSearchParams({ _nkw: query, _ipg: "60" });
  if (sold) { p.set("LH_Sold","1"); p.set("LH_Complete","1"); }
  const html = await unlock(`https://www.ebay.com/sch/i.html?${p.toString()}`);
  const $ = cheerio.load(html);
  const listings = [];
  $("li.s-item, .s-card").each((_, el) => {
    const n = $(el);
    const title = n.find(".s-item__title, .s-card__title").first().text().trim();
    if (!title || /shop on ebay/i.test(title)) return;
    const price = parsePrice(n.find(".s-item__price, .s-card__price").first().text());
    if (price === null) return;
    listings.push({ title, price });
  });
  let prices = listings.map(l=>l.price).filter(p=>p>0);
  const med = median(prices);
  if (med!==null) prices = prices.filter(p=>p>=med*0.1 && p<=med*10);
  return { query, sold, structuredCount: listings.length, count: prices.length,
    median: med, low: prices.length?Math.min(...prices):null, high: prices.length?Math.max(...prices):null,
    avg: prices.length?Math.round(prices.reduce((a,b)=>a+b,0)/prices.length*100)/100:null,
    sample: listings.slice(0,4) };
}

const q = "Umbreon ex 161/131 Prismatic Evolutions";
console.log("=== ACTIVE ==="); console.log(JSON.stringify(await scan(q, false), null, 1));
console.log("=== SOLD ==="); console.log(JSON.stringify(await scan(q, true), null, 1));
console.log("=== PSA 10 SOLD ==="); console.log(JSON.stringify(await scan(q + " PSA 10", true), null, 1));
