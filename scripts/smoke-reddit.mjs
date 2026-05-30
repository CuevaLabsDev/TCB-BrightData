// Smoke test: Reddit JSON via Bright Data Web Unlocker.
// Confirms (1) the unlocker returns Reddit's .json, (2) how far back /new.json
// pagination reaches (vs the daily_prices window), and (3) the comment shape.
// Run: node scripts/smoke-reddit.mjs [subreddit] [maxPages]
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
const ZONE = env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";
const SUB = process.argv[2] || "PokeInvesting";
const MAX_PAGES = Number(process.argv[3] || 4);

if (!KEY) {
  console.error("BRIGHT_DATA_API_KEY missing");
  process.exit(1);
}

async function unlock(url) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: ZONE, url, format: "raw", country: "us" }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`unlocker ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const iso = (utc) => (utc ? new Date(utc * 1000).toISOString().slice(0, 10) : "?");

console.log(`=== r/${SUB} /new.json pagination probe (max ${MAX_PAGES} pages) ===`);
let after = null;
let total = 0;
let oldest = Infinity;
let newest = 0;
let firstThread = null;
for (let page = 0; page < MAX_PAGES; page++) {
  const url = `https://www.reddit.com/r/${SUB}/new.json?limit=100${after ? `&after=${after}` : ""}`;
  let text;
  try {
    text = await unlock(url);
  } catch (e) {
    console.error(`  page ${page}: ${e.message}`);
    break;
  }
  const j = tryJson(text);
  if (!j) {
    console.error(`  page ${page}: non-JSON response (first 160): ${text.slice(0, 160).replace(/\n/g, " ")}`);
    break;
  }
  const children = j?.data?.children ?? [];
  if (children.length === 0) {
    console.log(`  page ${page}: 0 posts (end of listing)`);
    break;
  }
  for (const ch of children) {
    const d = ch.data || {};
    total++;
    if (typeof d.created_utc === "number") {
      oldest = Math.min(oldest, d.created_utc);
      newest = Math.max(newest, d.created_utc);
    }
    if (!firstThread && typeof d.permalink === "string") firstThread = d;
  }
  console.log(
    `  page ${page}: +${children.length} posts | oldest so far ${iso(oldest)} | after=${j.data.after}`,
  );
  after = j.data.after;
  if (!after) {
    console.log("  (no more pages)");
    break;
  }
}
console.log(
  `\nTotal posts: ${total} | window ${iso(oldest)} .. ${iso(newest)} | daily_prices ends 2026-05-05`,
);

if (firstThread) {
  console.log(`\n=== comment probe on: "${(firstThread.title || "").slice(0, 70)}" ===`);
  const cu = `https://www.reddit.com${firstThread.permalink}.json?limit=50&sort=top&depth=3`;
  const text = await unlock(cu);
  const j = tryJson(text);
  if (!Array.isArray(j) || j.length < 2) {
    console.error("  unexpected comment payload shape:", text.slice(0, 160).replace(/\n/g, " "));
  } else {
    const commentListing = j[1]?.data?.children ?? [];
    let count = 0;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.kind !== "t1" || !n.data) continue;
        count++;
        if (count <= 3) {
          console.log(
            `   • u/${n.data.author} (${n.data.ups}↑): ${String(n.data.body || "").slice(0, 90).replace(/\n/g, " ")}`,
          );
        }
        const replies = n.data.replies;
        if (replies && replies.data && Array.isArray(replies.data.children)) walk(replies.data.children);
      }
    };
    walk(commentListing);
    console.log(`  parsed ${count} comments from thread`);
  }
}
console.log("\nsmoke-reddit done.");
