// Improve product matching over already-stored posts (no new API spend).
// Reads posts.raw->mentioned, applies slang aliases + trigram similarity, and
// rewrites mentioned_products, then re-correlates creator impact.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

// Community slang -> canonical search hints (name + optional set abbreviation)
const ALIASES = [
  [/moonbreon|umbreon\s*(vmax)?\s*alt/i, { name: "Umbreon VMAX (Alternate Art Secret)", set: "SWSH07" }],
  [/prismatic.*umbreon|umbreon.*prismatic|umbreon\s*(ex|sir)/i, { name: "Umbreon ex - 161/131", set: "PRE" }],
  [/glaceon.*alt|alt.*glaceon/i, { name: "Glaceon VMAX (Alternate Art Secret)", set: "SWSH07" }],
  [/rayquaza\s*vmax.*alt|rayquaza.*alt.*art/i, { name: "Rayquaza VMAX (Alternate Art Secret)", set: "SWSH07" }],
  [/mega charizard x/i, { name: "Mega Charizard X ex - 125/094", set: "ME02" }],
  [/151 charizard|charizard.*151/i, { name: "Charizard ex - 199/165", set: "MEW" }],
  [/zapdos.*base|base.*zapdos/i, { name: "Zapdos", set: "BS" }],
  [/dragonite v.*alt/i, { name: "Dragonite V (Alternate Full Art)", set: "SWSH07" }],
];

// Strip generic noise words the LLM tends to add
function cleanName(raw) {
  return raw
    .replace(/\b(psa\s*\d+|cgc|bgs|sir|alt art|alternate art|secret|sealed|booster|box|etb|elite trainer box|pack|blister|upc|from|the|pokemon|pok[eé]mon|tcg|card|cards|singles|starters)\b/gi, " ")
    .replace(/\d{2,3}\/\d{2,3}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function matchOne(raw) {
  // 1) alias hit -> direct lookup by name + set
  for (const [re, hint] of ALIASES) {
    if (re.test(raw)) {
      const rows = await sql`
        select p.product_id, p.name from products p
        join price_windows w on w.product_id=p.product_id
        left join groups g on g.group_id=p.group_id
        where p.name ilike ${"%" + hint.name.split(" - ")[0] + "%"}
          ${hint.set ? sql`and g.abbreviation = ${hint.set}` : sql``}
          and not p.is_sealed
        order by similarity(p.name, ${hint.name}) desc, w.market desc nulls last limit 1`;
      if (rows[0]) return { id: Number(rows[0].product_id), via: "alias", name: rows[0].name };
    }
  }
  // 2) trigram similarity on cleaned name, prefer higher-value (chase) cards
  const cleaned = cleanName(raw);
  if (cleaned.length < 3) return null;
  const rows = await sql`
    select p.product_id, p.name, similarity(p.name, ${cleaned}) sim, w.market
    from products p join price_windows w on w.product_id=p.product_id
    where not p.is_sealed and similarity(p.name, ${cleaned}) >= 0.3
    order by sim desc, w.market desc nulls last limit 1`;
  if (rows[0] && Number(rows[0].sim) >= 0.3) return { id: Number(rows[0].product_id), via: `trig(${Number(rows[0].sim).toFixed(2)})`, name: rows[0].name };
  return null;
}

const posts = await sql`select id, raw from posts`;
let improved = 0;
for (const post of posts) {
  const mentioned = post.raw?.mentioned || [];
  const ids = new Set();
  const trace = [];
  for (const m of mentioned.slice(0, 5)) {
    const hit = await matchOne(String(m));
    if (hit) { ids.add(hit.id); trace.push(`${m} ->[${hit.via}] ${hit.name}`); }
  }
  const arr = [...ids];
  await sql`update posts set mentioned_products = ${arr} where id = ${post.id}`;
  if (arr.length) { improved++; console.log(`  post ${post.id}: ${trace.join(" | ")}`); }
}

console.log(`\n${improved}/${posts.length} posts now have product matches`);

// Re-correlate
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

const stats = await sql`select count(*) n, count(*) filter (where array_length(mentioned_products,1)>0) matched from posts`;
console.log(`posts matched: ${stats[0].matched}/${stats[0].n}`);
await sql.end();
