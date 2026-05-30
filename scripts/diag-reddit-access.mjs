// Diagnose Reddit access paths for Bright Data on this account.
// 1) reddit.com via Web Unlocker (immediate-mode robots wall?)
// 2) a non-reddit URL via the same zone (isolate: is it reddit-specific?)
// 3) the dedicated Reddit Dataset API (gd_lvz8ah06191smkebj4) sync scrape
import { readFileSync, writeFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const KEY = env.BRIGHT_DATA_API_KEY;
const ZONE = env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";
const out = [];

async function unlock(url) {
  const r = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: ZONE, url, format: "raw", country: "us" }),
    signal: AbortSignal.timeout(70000),
  });
  return { s: r.status, t: await r.text() };
}

// 1) reddit.com .json — 3 attempts
out.push("=== (1) reddit.com /new.json via Web Unlocker (zone " + ZONE + ") ===");
for (let i = 0; i < 3; i++) {
  try {
    const { s, t } = await unlock("https://www.reddit.com/r/PokeInvesting/new.json?limit=10");
    let posts = -1;
    try { posts = JSON.parse(t)?.data?.children?.length ?? -1; } catch {}
    out.push(`  try${i}: http=${s} posts=${posts} :: ${t.slice(0, 110).replace(/\n/g, " ")}`);
  } catch (e) { out.push(`  try${i}: ERR ${e.message}`); }
  await new Promise((r) => setTimeout(r, 2000));
}

// 1b) old.reddit.com + plain HTML (different robots posture)
out.push("=== (1b) old.reddit.com .json + www.reddit.com HTML ===");
for (const u of [
  "https://old.reddit.com/r/PokeInvesting/new.json?limit=10",
  "https://www.reddit.com/r/PokeInvesting/new/",
]) {
  try { const { s, t } = await unlock(u); out.push(`  ${u} -> http=${s} :: ${t.slice(0, 100).replace(/\n/g, " ")}`); }
  catch (e) { out.push(`  ${u} -> ERR ${e.message}`); }
}

// 2) non-reddit control (eBay) via the same zone
out.push("=== (2) control: eBay via same zone (should NOT be walled) ===");
try {
  const { s, t } = await unlock("https://www.ebay.com/sch/i.html?_nkw=charizard&_ipg=60");
  out.push(`  ebay http=${s} len=${t.length} wall=${/bad_endpoint|robots\.txt/.test(t)}`);
} catch (e) { out.push(`  ebay ERR ${e.message}`); }

// 3) Reddit Dataset API — synchronous scrape of one post URL
out.push("=== (3) Reddit Dataset API (gd_lvz8ah06191smkebj4) sync scrape ===");
const DS = env.BRIGHT_DATA_DATASET_REDDIT_POSTS || "gd_lvz8ah06191smkebj4";
try {
  const r = await fetch(`https://api.brightdata.com/datasets/v3/scrape?dataset_id=${DS}&format=json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ url: "https://www.reddit.com/r/PokeInvesting/" }]),
    signal: AbortSignal.timeout(90000),
  });
  const t = await r.text();
  out.push(`  dataset sync http=${r.status} :: ${t.slice(0, 200).replace(/\n/g, " ")}`);
} catch (e) { out.push(`  dataset sync ERR ${e.message}`); }

writeFileSync("/tmp/diag_reddit.txt", out.join("\n") + "\n");
console.log(out.join("\n"));
