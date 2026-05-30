// Seed creator posts + sentiment via live Bright Data SERP + Featherless.
// Mirrors src/lib/bright-data/social.ts. Run: node scripts/seed-social.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
const FKEY = env.FEATHERLESS_API_KEY;
const FMODEL = "Qwen/Qwen2.5-7B-Instruct";
const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

const PLATS = [["youtube", "youtube.com"], ["tiktok", "tiktok.com"], ["instagram", "instagram.com"], ["x", "x.com"], ["x", "twitter.com"], ["reddit", "reddit.com"]];
const classify = (u) => { if (!u) return null; for (const [p, h] of PLATS) if (u.includes(h)) return p; return null; };
function handleFrom(url, platform) {
  try {
    const u = new URL(url);
    if (platform === "youtube") { const m = u.pathname.match(/\/(@[^/]+)/); return m ? m[1] : "youtube"; }
    if (platform === "tiktok") { const m = u.pathname.match(/@([^/]+)/); return m ? `@${m[1]}` : "tiktok"; }
    if (platform === "instagram") { const m = u.pathname.split("/").filter(Boolean)[0]; return m ? `@${m}` : "instagram"; }
    if (platform === "x") { const m = u.pathname.split("/").filter(Boolean)[0]; return m ? `@${m}` : "x"; }
    if (platform === "reddit") { const m = u.pathname.match(/\/r\/([^/]+)/); return m ? `r/${m[1]}` : "reddit"; }
  } catch {}
  return platform;
}

async function serp(q) {
  const u = new URLSearchParams({ q, brd_json: "1", num: "20" }).toString();
  const res = await fetch(API, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ zone: SERP, url: `https://www.google.com/search?${u}`, format: "raw" }), signal: AbortSignal.timeout(60000) });
  try { return JSON.parse(await res.text()).organic || []; } catch { return []; }
}
async function extract(title, snippet) {
  const body = { model: FMODEL, messages: [
    { role: "system", content: "You are a Pokemon TCG market-sentiment analyst. Output ONLY one JSON object." },
    { role: "user", content: `Post title: "${title}"\nSnippet: "${snippet}"\n\nReturn JSON exactly: {"sentiment":"bullish|bearish|neutral","signal":"buy|sell|hold|hype","mentioned_cards":["card or set names"],"confidence":0.0,"summary":"one sentence market take"}` }],
    max_tokens: 250, temperature: 0.1, response_format: { type: "json_object" }, stop: ["\n\nuser", "```"] };
  const r = await fetch("https://api.featherless.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${FKEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!r.ok) return null;
  const c = (await r.json()).choices?.[0]?.message?.content;
  try { return JSON.parse(c.trim()); } catch { const m = c?.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } }
}
async function matchProducts(names) {
  const ids = new Set();
  for (const raw of (names || []).slice(0, 5)) {
    const name = (raw || "").trim(); if (name.length < 3) continue;
    const rows = await sql`select p.product_id from products p join price_windows w on w.product_id=p.product_id where p.name ilike ${"%" + name + "%"} and not p.is_sealed order by w.market desc nulls last limit 1`;
    if (rows[0]) ids.add(Number(rows[0].product_id));
  }
  return [...ids];
}

const TOPICS = [
  "Prismatic Evolutions Umbreon", "Pokemon 151 Charizard", "Evolving Skies alt art",
  "Pokemon card investment 2026 chase", "Mega Evolution Charizard ex",
];

let total = 0;
for (const topic of TOPICS) {
  console.log(`\n=== ${topic} ===`);
  const q = `${topic} pokemon cards investment OR price OR sold (site:youtube.com OR site:tiktok.com OR site:instagram.com OR site:reddit.com OR site:x.com)`;
  const organic = await serp(q);
  const candidates = organic.filter((o) => classify(o.link)).slice(0, 6);
  for (const c of candidates) {
    const platform = classify(c.link); const url = c.link; const title = c.title || ""; const snippet = c.description || "";
    const sig = await extract(title, snippet);
    if (!sig) { console.log("  (extract failed)", title.slice(0, 50)); continue; }
    const pids = await matchProducts(sig.mentioned_cards);
    const handle = handleFrom(url, platform);
    const cr = await sql`insert into creators (handle, platform, display_name, url) values (${handle}, ${platform}, ${handle}, ${url}) on conflict (platform, handle) do update set url=excluded.url returning id`;
    const creatorId = cr[0]?.id ?? null;
    await sql`insert into posts (creator_id, platform, post_url, caption, sentiment, signal, mentioned_products, summary, raw) values (${creatorId}, ${platform}, ${url}, ${title}, ${sig.sentiment}, ${sig.signal}, ${pids}, ${sig.summary || null}, ${sql.json({ snippet, confidence: sig.confidence, mentioned: sig.mentioned_cards })}) on conflict (post_url) do update set sentiment=excluded.sentiment, signal=excluded.signal, mentioned_products=excluded.mentioned_products, summary=excluded.summary`;
    total++;
    console.log(`  [${platform}] ${handle} | ${sig.sentiment}/${sig.signal} | cards=${JSON.stringify(sig.mentioned_cards)} -> pids=${JSON.stringify(pids)}`);
    console.log(`     "${title.slice(0, 64)}"`);
  }
}

// Correlate impact
console.log("\n=== correlating creator impact ===");
await sql`
  with post_moves as (
    select po.id, avg(w.chg_7d_pct) as move
    from posts po join unnest(po.mentioned_products) as mp(product_id) on true
    join price_windows w on w.product_id = mp.product_id
    where po.mentioned_products is not null and array_length(po.mentioned_products,1) > 0
    group by po.id)
  update posts p set impact_pct = pm.move from post_moves pm where p.id = pm.id`;
await sql`
  with ci as (select creator_id, avg(abs(impact_pct)) avg_abs_move, count(*) n from posts where creator_id is not null and impact_pct is not null group by creator_id)
  update creators c set impact_score = least(100, round(coalesce(ci.avg_abs_move,0)::numeric,2)), flagged = coalesce(ci.avg_abs_move,0) >= 15 and ci.n >= 1 from ci where c.id = ci.creator_id`;

const flagged = await sql`select handle, platform, impact_score, flagged from creators order by impact_score desc nulls last limit 10`;
console.log("\nTop creators by impact:");
for (const r of flagged) console.log(`  ${r.flagged ? "🚩" : "  "} ${r.platform}/${r.handle} impact=${r.impact_score}`);
console.log(`\nSeeded ${total} posts.`);
await sql.end();
