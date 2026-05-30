// Probe the Bright Data Reddit POSTS dataset: discover-by-subreddit volume,
// date range, field shape, and whether comments come inline.
import { readFileSync, writeFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const KEY = env.BRIGHT_DATA_API_KEY;
const DS_POSTS = env.BRIGHT_DATA_DATASET_REDDIT_POSTS || "gd_lvz8ah06191smkebj4";
const API = "https://api.brightdata.com/datasets/v3";
const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function triggerDiscover() {
  const params = new URLSearchParams({
    dataset_id: DS_POSTS, format: "json", include_errors: "true",
    type: "discover_new", discover_by: "subreddit_url",
  });
  const r = await fetch(`${API}/trigger?${params}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    // sort_by=New to walk recent->older for a date-bounded backfill
    body: JSON.stringify([{ url: "https://www.reddit.com/r/PokeInvesting/", sort_by: "New", num_of_posts: 150 }]),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
}

log("=== trigger discover_new / subreddit_url (sort New, num_of_posts 150) ===");
let snapshotId;
try {
  const j = await triggerDiscover();
  snapshotId = j.snapshot_id;
  log("  trigger resp:", JSON.stringify(j).slice(0, 200));
} catch (e) { log("  trigger ERR", e.message); }

if (snapshotId) {
  const deadline = Date.now() + 240000;
  let status = "";
  while (Date.now() < deadline) {
    await sleep(6000);
    try {
      const pr = await fetch(`${API}/progress/${snapshotId}`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(20000) });
      const pj = await pr.json();
      status = pj.status;
      log(`  progress: ${status} rows=${pj.records ?? "?"}`);
      if (status === "ready" || status === "failed") break;
    } catch (e) { log("  progress ERR", e.message); }
  }
  if (status === "ready") {
    const sr = await fetch(`${API}/snapshot/${snapshotId}?format=json`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60000) });
    const txt = await sr.text();
    let rows = [];
    try { rows = JSON.parse(txt); } catch { rows = txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    log(`  snapshot rows: ${rows.length}`);
    if (rows.length) {
      const dates = rows.map((r) => r.date_posted || r.created_utc || r.date).filter(Boolean).sort();
      log(`  date range: ${dates[0]} .. ${dates[dates.length - 1]}`);
      log(`  FIELD KEYS: ${Object.keys(rows[0]).join(", ")}`);
      const hasComments = rows.some((r) => Array.isArray(r.comments) && r.comments.length);
      log(`  inline comments present on any row: ${hasComments}`);
      if (hasComments) {
        const ex = rows.find((r) => Array.isArray(r.comments) && r.comments.length);
        log(`  example comment keys: ${Object.keys(ex.comments[0]).join(", ")}`);
        log(`  example comment count on that post: ${ex.comments.length}`);
      }
      writeFileSync("/tmp/reddit_ds_sample.json", JSON.stringify(rows[0], null, 2));
      log("  wrote first full record -> /tmp/reddit_ds_sample.json");
    }
  }
}
writeFileSync("/tmp/diag_ds.txt", out.join("\n") + "\n");
