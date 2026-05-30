// Seed watchlisted creator posts via Bright Data Web Data (YouTube transcripts).
// Faster + more reliable than the full /api/cron/social route for first populate.
//   node scripts/seed-watchlist.mjs
//   node scripts/seed-watchlist.mjs @PokeRev youtube
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const BD_KEY = env.BRIGHT_DATA_API_KEY;
const SERP = env.BRIGHT_DATA_SERP_ZONE || "serp_api1";
const FKEY = env.FEATHERLESS_API_KEY;
const FMODEL = env.FEATHERLESS_MODEL || "Qwen/Qwen2.5-7B-Instruct";
const YT_DATASET = env.BRIGHT_DATA_DATASET_YOUTUBE_VIDEO || "gd_lk56epmy2i5g7lzu0k";
const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

const WATCHLIST = [
  { handle: "@PokeRev", platform: "youtube", profileUrl: "https://www.youtube.com/@PokeRev", tier: "tier1" },
  { handle: "@ThePokeRev", platform: "x", profileUrl: "https://x.com/ThePokeRev", tier: "tier1" },
  { handle: "@pokerev", platform: "instagram", profileUrl: "https://www.instagram.com/pokerev/", tier: "tier2" },
];

const filterHandle = process.argv[2];
const filterPlatform = process.argv[3];
const entries = WATCHLIST.filter(
  (e) =>
    (!filterHandle || e.handle.toLowerCase() === filterHandle.toLowerCase()) &&
    (!filterPlatform || e.platform === filterPlatform),
);

async function serp(q) {
  const u = new URLSearchParams({ q, brd_json: "1", num: "15" }).toString();
  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${BD_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: SERP, url: `https://www.google.com/search?${u}`, format: "raw" }),
    signal: AbortSignal.timeout(60_000),
  });
  try {
    return JSON.parse(await res.text()).organic || [];
  } catch {
    return [];
  }
}

async function scrapeYouTube(url) {
  const res = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${YT_DATASET}&format=json`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${BD_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ url }]),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return null;
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.title && !row?.transcript) return null;
  return row;
}

function channelFromRow(row) {
  return (
    row?.handle_name ||
    row?.youtuber ||
    (row?.channel_url?.match(/@([^/?]+)/)?.[1] ?? "") ||
    ""
  );
}

async function extractSignal({ title, caption, transcript }) {
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (caption && caption !== title) parts.push(`Caption: ${caption}`);
  if (transcript) parts.push(`Transcript: ${transcript.slice(0, 3500)}`);
  const content = parts.join("\n").slice(0, 4500);
  const body = {
    model: FMODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a Pokemon TCG market-sentiment analyst. Output ONLY one JSON object. Judge market signal for trading-card investors.",
      },
      {
        role: "user",
        content:
          `${content}\n\nReturn JSON exactly: {"sentiment":"bullish|bearish|neutral","signal":"buy|sell|hold|hype","mentioned_cards":["card or set names"],"confidence":0.0,"summary":"one sentence market take"}`,
      },
    ],
    max_tokens: 280,
    temperature: 0.1,
    response_format: { type: "json_object" },
    stop: ["\n\nuser", "```"],
  };
  const r = await fetch("https://api.featherless.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${FKEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) {
    console.error("  featherless", r.status, (await r.text()).slice(0, 120));
    return null;
  }
  const c = (await r.json()).choices?.[0]?.message?.content;
  try {
    return JSON.parse(c.trim());
  } catch {
    const m = c?.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}

async function matchProducts(names) {
  const ids = new Set();
  for (const raw of (names || []).slice(0, 5)) {
    const name = (raw || "").trim();
    if (name.length < 3) continue;
    const rows = await sql`
      select p.product_id from products p
      join price_windows w on w.product_id = p.product_id
      where p.name ilike ${"%" + name + "%"} and not p.is_sealed
      order by w.market desc nulls last limit 1`;
    if (rows[0]) ids.add(Number(rows[0].product_id));
  }
  return [...ids];
}

function norm(h) {
  return h.replace(/^@/, "").toLowerCase();
}

function handleMatches(watched, candidate) {
  if (!candidate) return false;
  const w = norm(watched);
  const c = norm(candidate);
  return c === w || c.includes(w) || w.includes(c);
}

let total = 0;

for (const entry of entries) {
  console.log(`\n=== ${entry.platform}/${entry.handle} (${entry.tier}) ===`);

  const cr = await sql`
    insert into creators (handle, platform, display_name, url, watchlisted, tier, last_scanned_at)
    values (${entry.handle}, ${entry.platform}, ${entry.handle}, ${entry.profileUrl}, true, ${entry.tier}, now())
    on conflict (platform, handle) do update set
      url = excluded.url, watchlisted = true, tier = excluded.tier, last_scanned_at = now()
    returning id`;
  const creatorId = cr[0].id;

  if (entry.platform !== "youtube") {
    console.log("  (skip — run full scan or extend script for", entry.platform, ")");
    continue;
  }

  const organic = await serp(`site:youtube.com ${norm(entry.handle)} pokemon cards`);
  const videoUrls = organic
    .map((o) => o.link)
    .filter((u) => u && /youtube\.com\/watch\?v=/.test(u))
    .slice(0, 2);

  console.log(`  found ${videoUrls.length} video URL(s) via SERP`);
  for (const url of videoUrls) {
    console.log(`  scraping ${url} ...`);
    const row = await scrapeYouTube(url);
    if (!row) {
      console.log("  scrape failed");
      continue;
    }
    const channel = channelFromRow(row);
    if (channel && !handleMatches(entry.handle, channel)) {
      console.log(`  skip wrong channel: ${channel}`);
      continue;
    }

    const title = row.title || "";
    const caption = [title, (row.description || "").slice(0, 1500)].filter(Boolean).join("\n");
    const transcript = row.transcript || null;
    const contentSource = transcript && caption ? "both" : transcript ? "transcript" : "caption";

    console.log(`  extracting sentiment (transcript ${(transcript || "").length} chars) ...`);
    const sig = await extractSignal({ title, caption, transcript });
    if (!sig) {
      console.log("  extract failed — check FEATHERLESS_API_KEY");
      continue;
    }

    const pids = await matchProducts(sig.mentioned_cards);
    const postedAt = row.date_posted ? new Date(row.date_posted) : null;

    await sql`
      insert into posts
        (creator_id, platform, post_url, posted_at, caption, likes, views, comments,
         sentiment, signal, mentioned_products, summary, transcript, content_source, raw)
      values
        (${creatorId}, ${entry.platform}, ${url}, ${postedAt}, ${caption},
         ${row.likes ?? null}, ${row.views ?? null}, ${row.num_comments ?? null},
         ${sig.sentiment}, ${sig.signal}, ${pids}, ${sig.summary || null},
         ${transcript}, ${contentSource},
         ${sql.json({ confidence: sig.confidence, mentioned: sig.mentioned_cards, channel })})
      on conflict (post_url) do update set
        sentiment = excluded.sentiment, signal = excluded.signal,
        mentioned_products = excluded.mentioned_products, summary = excluded.summary,
        transcript = coalesce(excluded.transcript, posts.transcript),
        content_source = excluded.content_source, posted_at = coalesce(excluded.posted_at, posts.posted_at)`;

    total++;
    console.log(`  ✓ ${sig.sentiment}/${sig.signal} | ${sig.summary?.slice(0, 80)}`);
    if (transcript) console.log(`    transcript: ${transcript.length} chars`);
  }
}

await sql`
  with post_moves as (
    select po.id, avg(w.chg_7d_pct) as move
    from posts po join unnest(po.mentioned_products) as mp(product_id) on true
    join price_windows w on w.product_id = mp.product_id
    where po.mentioned_products is not null and array_length(po.mentioned_products, 1) > 0
    group by po.id)
  update posts p set impact_pct = pm.move from post_moves pm where p.id = pm.id`;

await sql`
  with ci as (
    select creator_id, avg(abs(impact_pct)) avg_abs_move, count(*) n
    from posts where creator_id is not null and impact_pct is not null group by creator_id)
  update creators c set
    impact_score = least(100, round(coalesce(ci.avg_abs_move, 0)::numeric, 2)),
    flagged = coalesce(ci.avg_abs_move, 0) >= 15 and ci.n >= 1
  from ci where c.id = ci.creator_id and c.watchlisted = true`;

const summary = await sql`
  select c.handle, c.platform, count(po.id)::int posts,
         count(po.id) filter (where length(coalesce(po.transcript,'')) > 0)::int with_transcript
  from creators c left join posts po on po.creator_id = c.id
  where c.watchlisted group by c.id, c.handle, c.platform order by c.platform`;

console.log("\n=== watchlist summary ===");
for (const r of summary) {
  console.log(`  ${r.platform}/${r.handle}: ${r.posts} posts (${r.with_transcript} with transcript)`);
}
console.log(`\nSeeded ${total} new/updated watchlist posts.`);
await sql.end();
