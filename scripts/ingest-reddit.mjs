// Reddit market-signal backfill — r/PokeInvesting threads + inline comments via
// the Bright Data Reddit DATASET API (gd_lvz8ah06191smkebj4), with per-card
// mention extraction and eBay realized-sold daily history for mentioned cards.
//
// Why the dataset API: reddit.com is hard-blocked on the Web Unlocker for this
// account ("not available for immediate access mode in accordance with
// robots.txt"). The dataset API returns posts WITH inline comments + nested
// replies in a single async snapshot. The Web Unlocker is still used for the
// eBay sold scrape (that target works).
//
// Self-contained (mirrors scripts/seed-social.mjs): Bright Data APIs + postgres
// + Featherless, no @/lib imports. The day-grain rollup + lead/lag price
// correlation runs separately in `python -m pipeline.reddit_corr`.
//
// Usage:
//   # proof backfill — high-engagement posts across the year (overlap the
//   # price-covered window; daily_prices ends 2026-05-05):
//   node scripts/ingest-reddit.mjs --top-year --num-posts 300 --max-ebay-cards 20
//   # recent live chatter (New, ~2 days):
//   node scripts/ingest-reddit.mjs --days 2
import { readFileSync } from "node:fs";
import postgres from "postgres";
import * as cheerio from "cheerio";

// ---- env -------------------------------------------------------------------
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const API = "https://api.brightdata.com/request";
const DATASET_API = "https://api.brightdata.com/datasets/v3";
const KEY = env.BRIGHT_DATA_API_KEY;
const ZONE = env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";
const DS_REDDIT_POSTS = env.BRIGHT_DATA_DATASET_REDDIT_POSTS || "gd_lvz8ah06191smkebj4";
const FKEY = env.FEATHERLESS_API_KEY;
// Configured model can be unavailable on the plan ("not currently available");
// preflight picks the first model that actually answers. See pickModel().
const MODEL_CANDIDATES = [
  env.FEATHERLESS_MODEL,
  "Qwen/Qwen3-8B",
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
  "Qwen/Qwen2.5-14B-Instruct",
].filter(Boolean);
let FMODEL = MODEL_CANDIDATES[0];
if (!KEY) throw new Error("BRIGHT_DATA_API_KEY missing");
const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

// ---- args ------------------------------------------------------------------
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SUB = arg("subreddit", "PokeInvesting");
const DAYS = Number(arg("days", "60"));
const MAX_EBAY_CARDS = Number(arg("max-ebay-cards", "40"));
const MAX_LLM_THREADS = Number(arg("max-llm-threads", "1000"));
// --top-year pulls high-engagement posts dated across the whole year (Top/This
// year) so they overlap the price-covered window; otherwise New (~2 days back).
const TOP_YEAR = process.argv.includes("--top-year");
const NUM_POSTS = Number(arg("num-posts", "300"));
const POLL_CAP_MS = Number(arg("poll-cap-ms", "420000")); // 7 min snapshot cap
const CUTOFF = TOP_YEAR ? 0 : Date.now() / 1000 - DAYS * 86400;

// Reddit slang -> catalog search phrase. Comments/threads use nicknames the
// catalog never spells out; this is the highest-signal alias set for PokeInvesting.
const ALIASES = {
  moonbreon: "umbreon vmax alternate",
  "moon breon": "umbreon vmax alternate",
  zard: "charizard",
  gengar: "gengar vmax",
  "giratina v alt": "giratina v alternate",
  lugia: "lugia v alternate",
  "lugia alt": "lugia v alternate",
  "rayquaza alt": "rayquaza vmax alternate",
  rayquaza: "rayquaza vmax",
  "umbreon ex": "umbreon ex",
  sylveon: "sylveon",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- bright data web unlocker (eBay only) ---------------------------------
async function unlock(url, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: ZONE, url, format: "raw", country: "us" }),
        signal: AbortSignal.timeout(70000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 120)}`);
      if (/Request Failed \(bad_endpoint\)/.test(text)) throw new Error("bad_endpoint");
      return text;
    } catch (e) {
      if (a === tries - 1) throw e;
      await sleep(Math.min(15000, 2000 * 2 ** a));
    }
  }
}

// ---- bright data reddit DATASET API ---------------------------------------
const parseUtc = (iso) => {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
};
// reddit ids come prefixed (t3_xx, t1_xx) or embedded in comment urls; normalize.
const stripId = (s) => String(s || "").replace(/^t\d_/, "");
const commentIdFromUrl = (u) => {
  const m = String(u || "").match(/\/comment\/([a-z0-9]+)/i);
  return m ? m[1] : null;
};

/** Trigger a dataset collection, poll to ready, return parsed rows. */
async function triggerAndCollect(inputs, { discoverBy } = {}) {
  const params = new URLSearchParams({
    dataset_id: DS_REDDIT_POSTS,
    format: "json",
    include_errors: "true",
  });
  if (discoverBy) {
    params.set("type", "discover_new");
    params.set("discover_by", discoverBy);
  }
  const trig = await fetch(`${DATASET_API}/trigger?${params}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(30000),
  });
  if (!trig.ok) throw new Error(`trigger ${trig.status}: ${(await trig.text()).slice(0, 160)}`);
  const snapshotId = (await trig.json()).snapshot_id;
  if (!snapshotId) throw new Error("no snapshot_id from trigger");
  console.log(`  dataset snapshot ${snapshotId} — polling...`);

  const deadline = Date.now() + POLL_CAP_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(6000);
    const pr = await fetch(`${DATASET_API}/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!pr.ok) continue;
    const { status, records } = await pr.json();
    if (++polls % 5 === 0) console.log(`  ...${status} (${records ?? "?"} rows, ${Math.round((Date.now() - (deadline - POLL_CAP_MS)) / 1000)}s)`);
    if (status === "ready") break;
    if (status === "failed") throw new Error("snapshot failed");
  }
  const snap = await fetch(`${DATASET_API}/snapshot/${snapshotId}?format=json`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(90000),
  });
  if (!snap.ok) throw new Error(`snapshot ${snap.status}`);
  const txt = await snap.text();
  try {
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [j];
  } catch {
    return txt.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }
}

/** Map dataset post rows -> our thread shape, carrying inline comments. */
function mapDatasetRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.url || !r.post_id) continue;
    const created = parseUtc(r.date_posted);
    if (created && created < CUTOFF) continue;
    // Flatten inline comments + one reply level into a uniform list.
    const comments = [];
    for (const c of r.comments || []) {
      const cid = commentIdFromUrl(c.url);
      if (cid && c.comment) {
        comments.push({
          id: cid,
          author: c.user_commenting || null,
          body: c.comment,
          ups: typeof c.num_upvotes === "number" ? c.num_upvotes : null,
          created_utc: parseUtc(c.date_of_comment) || created,
        });
      }
      for (const rp of c.replies || []) {
        const rid = commentIdFromUrl(rp.url) || (cid ? `${cid}_r${comments.length}` : null);
        if (rid && rp.reply) {
          comments.push({
            id: rid,
            author: rp.user_replying || null,
            body: rp.reply,
            ups: typeof rp.num_upvotes === "number" ? rp.num_upvotes : null,
            created_utc: parseUtc(rp.date_of_reply) || created,
          });
        }
      }
    }
    out.push({
      id: stripId(r.post_id),
      url: r.url,
      permalink: r.url.replace(/^https?:\/\/[^/]+/, ""),
      title: r.title || "",
      selftext: typeof r.description === "string" ? r.description : "",
      ups: typeof r.num_upvotes === "number" ? r.num_upvotes : null,
      num_comments: typeof r.num_comments === "number" ? r.num_comments : (comments.length || 0),
      created_utc: created,
      author: r.user_posted || null,
      comments,
    });
  }
  return out;
}

async function fetchThreadsViaDataset() {
  const input = TOP_YEAR
    ? { url: `https://www.reddit.com/r/${SUB}/`, sort_by: "Top", sort_by_time: "This year", num_of_posts: NUM_POSTS }
    : { url: `https://www.reddit.com/r/${SUB}/`, sort_by: "New", num_of_posts: NUM_POSTS };
  console.log(`  trigger discover subreddit_url ${JSON.stringify(input)}`);
  const rows = await triggerAndCollect([input], { discoverBy: "subreddit_url" });
  console.log(`  dataset returned ${rows.length} raw rows`);
  return mapDatasetRows(rows);
}

// Pick the first Featherless model that actually responds (plan availability
// shifts; the configured default may 400 "not currently available").
async function pickModel() {
  for (const m of MODEL_CANDIDATES) {
    try {
      const r = await fetch("https://api.featherless.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${FKEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, messages: [{ role: "user", content: 'return {"ok":true}' }], max_tokens: 8, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(40000),
      });
      if (r.ok) return m;
      console.log(`  model ${m}: ${r.status} (skipping)`);
    } catch (e) {
      console.log(`  model ${m}: ${e.message} (skipping)`);
    }
  }
  return null;
}

// ---- featherless thread sentiment + card extraction ------------------------
async function extract(title, selftext) {
  const content = (selftext ? `${title}\n${selftext}` : title).slice(0, 3500);
  const body = {
    model: FMODEL,
    messages: [
      { role: "system", content: "You are a Pokemon TCG market-sentiment analyst. Output ONLY one JSON object." },
      {
        role: "user",
        content:
          `Reddit r/${SUB} post:\n"""${content}"""\n\n` +
          `Return JSON exactly: {"sentiment":"bullish|bearish|neutral","signal":"buy|sell|hold|hype",` +
          `"mentioned_cards":["specific card names, not generic terms"],"confidence":0.0,"summary":"one sentence"}`,
      },
    ],
    max_tokens: 260,
    temperature: 0.1,
    response_format: { type: "json_object" },
    stop: ["\n\nuser", "```"],
  };
  try {
    const r = await fetch("https://api.featherless.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${FKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return null;
    const c = (await r.json()).choices?.[0]?.message?.content;
    try {
      return JSON.parse(c.trim());
    } catch {
      const m = c?.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    }
  } catch {
    return null;
  }
}

// ---- card resolution (alias -> ilike against catalog) ----------------------
const resolveCache = new Map();
async function resolveCard(rawName) {
  let name = (rawName || "").trim().toLowerCase();
  if (name.length < 3) return null;
  name = ALIASES[name] || name;
  if (resolveCache.has(name)) return resolveCache.get(name);
  const rows = await sql`
    select p.product_id, p.name
    from products p join price_windows w on w.product_id = p.product_id
    where p.name ilike ${"%" + name + "%"} and not p.is_sealed
    order by w.market desc nulls last
    limit 1`;
  const hit = rows[0] ? { productId: Number(rows[0].product_id), name: rows[0].name } : null;
  resolveCache.set(name, hit);
  return hit;
}
// first alpha token of a card name, used to attribute in-thread comment mentions
const nameToken = (n) => (n.toLowerCase().match(/[a-z]+/) || [""])[0];

// ---- eBay realized sold (per-day) -----------------------------------------
const parsePrice = (s) => {
  const m = (s || "").replace(/,/g, "").match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
};
const parseSoldDate = (s) => {
  const m = (s || "").match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function ebaySoldDaily(productId, query) {
  const u = new URLSearchParams({ _nkw: query, _ipg: "120", LH_Sold: "1", LH_Complete: "1" });
  const html = await unlock(`https://www.ebay.com/sch/i.html?${u.toString()}`);
  const $ = cheerio.load(html);
  const byDay = new Map(); // day -> prices[]
  // eBay migrated results from .s-item to .s-card; sold date lives in
  // .s-card__caption ("Sold  Apr 27, 2026"). Keep .s-item* fallbacks.
  $(".s-card, li.s-item").each((_, el) => {
    const node = $(el);
    const title = node.find(".s-card__title, .s-item__title").first().text().trim();
    if (!title || /shop on ebay/i.test(title)) return;
    const price = parsePrice(node.find(".s-card__price, .s-item__price").first().text());
    if (price === null || price < 1) return;
    const cap = node.find(".s-card__caption, .s-item__caption--signal, .s-item__caption, .POSITIVE").first().text();
    const day = parseSoldDate(cap);
    if (!day) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(price);
  });
  let days = 0;
  for (const [day, prices] of byDay) {
    const med = median(prices);
    const avg = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
    await sql`
      insert into ebay_sold_daily (product_id, sub_type, sold_date, n_sold, median_price, avg_price)
      values (${productId}, 'Normal', ${day}, ${prices.length}, ${med}, ${avg})
      on conflict (product_id, sub_type, sold_date) do update set
        n_sold = excluded.n_sold, median_price = excluded.median_price, avg_price = excluded.avg_price`;
    days++;
  }
  return days;
}

// ---- main ------------------------------------------------------------------
const sinceLabel = TOP_YEAR ? "Top / This year" : `last ${DAYS}d (since ${new Date(CUTOFF * 1000).toISOString().slice(0, 10)})`;
console.log(`=== Reddit ingest (dataset API): r/${SUB} | ${sinceLabel} ===`);
FMODEL = await pickModel();
if (!FMODEL) {
  console.error("No working Featherless model — threads stored without sentiment/card extraction.");
} else {
  console.log(`using Featherless model: ${FMODEL}`);
}

let threads = [];
try {
  threads = await fetchThreadsViaDataset();
} catch (e) {
  console.error(`reddit dataset fetch failed: ${e.message}`);
}
// sort newest-first for stable LLM-budget ordering
threads.sort((a, b) => b.created_utc - a.created_utc);
const tdates = threads.map((t) => t.created_utc).filter(Boolean).sort();
const span = tdates.length
  ? `${new Date(tdates[0] * 1000).toISOString().slice(0, 10)} .. ${new Date(tdates[tdates.length - 1] * 1000).toISOString().slice(0, 10)}`
  : "n/a";
console.log(`\nfetched ${threads.length} threads | date span ${span}`);

// Pass 1: persist threads, thread sentiment + thread-level mentions, comments
const productMentions = new Map(); // productId -> count (for eBay ranking)
let llmRun = 0;
let commentRows = 0;
let commentMentions = 0;
for (const t of threads) {
  let sentiment = null;
  let signal = null;
  const cards = [];
  if (FMODEL && llmRun < MAX_LLM_THREADS) {
    const sig = await extract(t.title, t.selftext);
    llmRun++;
    if (sig) {
      sentiment = sig.sentiment ?? null;
      signal = sig.signal ?? null;
      for (const nm of (sig.mentioned_cards || []).slice(0, 6)) {
        const hit = await resolveCard(nm);
        if (hit) cards.push(hit);
      }
    }
  }
  await sql`
    insert into reddit_threads
      (thread_id, subreddit, url, author, title, selftext, score, num_comments, sentiment, signal, created_at, raw)
    values
      (${t.id}, ${SUB}, ${t.url}, ${t.author}, ${t.title}, ${t.selftext}, ${t.ups},
       ${t.num_comments}, ${sentiment}, ${signal},
       ${t.created_utc ? sql`to_timestamp(${t.created_utc})` : null}, ${sql.json({ permalink: t.permalink })})
    on conflict (thread_id) do update set
      score = excluded.score, num_comments = excluded.num_comments,
      sentiment = coalesce(excluded.sentiment, reddit_threads.sentiment),
      signal = coalesce(excluded.signal, reddit_threads.signal)`;

  const day = t.created_utc ? new Date(t.created_utc * 1000).toISOString().slice(0, 10) : null;
  const seen = new Set();
  const tokenMap = [];
  for (const c of cards) {
    if (seen.has(c.productId)) continue;
    seen.add(c.productId);
    tokenMap.push({ token: nameToken(c.name), productId: c.productId });
    if (day) {
      await sql`
        insert into reddit_mentions (source_type, source_id, product_id, subreddit, score, sentiment, mentioned_on)
        values ('thread', ${t.id}, ${c.productId}, ${SUB}, ${t.ups}, ${sentiment}, ${day})
        on conflict (source_type, source_id, product_id) do nothing`;
    }
    productMentions.set(c.productId, (productMentions.get(c.productId) || 0) + 1);
  }

  // Inline comments: store + deterministic mention match (thread tokens + aliases)
  const phrases = [
    ...tokenMap.map((m) => ({ phrase: m.token, productId: m.productId })),
    ...Object.entries(ALIASES).map(([k]) => ({ phrase: k, productId: null })),
  ].filter((p) => p.phrase && p.phrase.length >= 3);

  for (const c of t.comments) {
    await sql`
      insert into reddit_comments (comment_id, thread_id, author, body, score, created_at)
      values (${c.id}, ${t.id}, ${c.author}, ${c.body}, ${c.ups},
              ${c.created_utc ? sql`to_timestamp(${c.created_utc})` : null})
      on conflict (comment_id) do update set score = excluded.score`;
    commentRows++;
    const bodyLc = c.body.toLowerCase();
    const cday = c.created_utc ? new Date(c.created_utc * 1000).toISOString().slice(0, 10) : day;
    if (!cday) continue;
    const hitPids = new Set();
    for (const p of phrases) {
      if (!bodyLc.includes(p.phrase)) continue;
      let pid = p.productId;
      if (pid === null) {
        const hit = await resolveCard(p.phrase);
        if (!hit) continue;
        pid = hit.productId;
      }
      if (hitPids.has(pid)) continue;
      hitPids.add(pid);
      await sql`
        insert into reddit_mentions (source_type, source_id, product_id, subreddit, score, sentiment, mentioned_on)
        values ('comment', ${c.id}, ${pid}, ${SUB}, ${c.ups}, ${sentiment}, ${cday})
        on conflict (source_type, source_id, product_id) do nothing`;
      commentMentions++;
      productMentions.set(pid, (productMentions.get(pid) || 0) + 1);
    }
  }
  if (llmRun % 25 === 0 && llmRun) console.log(`  analyzed ${llmRun}/${threads.length} threads | comments=${commentRows} | cards-in-play ${productMentions.size}`);
}
console.log(`thread pass done: ${productMentions.size} distinct cards | ${commentRows} comments | ${commentMentions} comment-mentions`);

// Pass 2: eBay realized-sold daily for the most-mentioned cards
const topCards = [...productMentions.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_EBAY_CARDS);
console.log(`\neBay sold history for top ${topCards.length} mentioned cards...`);
let ebayCards = 0;
let ebayDays = 0;
for (const [pid] of topCards) {
  const prow = await sql`
    select p.name, p.number, g.name as set_name
    from products p left join groups g on g.group_id = p.group_id
    where p.product_id = ${pid} limit 1`;
  if (!prow[0]) continue;
  const q = [prow[0].name, prow[0].number, (prow[0].set_name || "").replace(/^SV:\s*/i, "")].filter(Boolean).join(" ");
  try {
    const days = await ebaySoldDaily(pid, q);
    ebayDays += days;
    ebayCards++;
    console.log(`  ${prow[0].name} -> ${days} sold-days`);
  } catch (e) {
    console.error(`  ${prow[0].name}: ${e.message}`);
  }
}

await sql`
  insert into ingest_runs (kind, finished_at, status, rows, detail)
  values ('reddit', now(), 'ok', ${threads.length},
    ${sql.json({ subreddit: SUB, source: "dataset", topYear: TOP_YEAR, threads: threads.length, commentRows, commentMentions, ebayCards, ebayDays })})`;

console.log(`\n=== DONE === threads=${threads.length} comments=${commentRows} comment-mentions=${commentMentions} ebayCards=${ebayCards} ebayDays=${ebayDays}`);
await sql.end();
