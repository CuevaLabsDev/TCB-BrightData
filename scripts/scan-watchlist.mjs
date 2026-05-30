// Trigger a full watchlist scan and verify the result in the warehouse.
//
// The scan logic lives in the TypeScript server modules (src/lib/bright-data/*),
// so this script drives the real code path by calling the /api/cron/social
// route on a running app, then queries Postgres to confirm watchlisted creators
// have fresh posts (and that YouTube posts carried a transcript).
//
//   1. Start the app:   npm run dev   (or point SCAN_BASE_URL at a deployment)
//   2. Run:             node scripts/scan-watchlist.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const BASE = process.env.SCAN_BASE_URL || env.SCAN_BASE_URL || "http://localhost:3000";
const secret = process.env.CRON_SECRET || env.CRON_SECRET;
const handles = process.env.SCAN_HANDLES || env.SCAN_HANDLES;
const platforms = process.env.SCAN_PLATFORMS || env.SCAN_PLATFORMS;
const qs = new URLSearchParams();
if (handles) qs.set("handles", handles);
if (platforms) qs.set("platforms", platforms);
const path = `/api/cron/social${qs.toString() ? `?${qs}` : ""}`;

console.log(`[scan] POST ${BASE}${path}`);
try {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    signal: AbortSignal.timeout(600_000),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[scan] ${res.status}`, JSON.stringify(body));
} catch (err) {
  console.error(
    `[scan] could not reach ${BASE} — start the app (npm run dev) or set SCAN_BASE_URL.\n      `,
    err.message,
  );
}

const sql = postgres(env.SUPABASE_DB_URL || env.DATABASE_URL, { prepare: false, ssl: "require" });

const posts = await sql`
  select c.platform, c.handle, po.post_url, po.posted_at, po.content_source,
         po.sentiment, po.signal,
         length(coalesce(po.transcript, '')) as transcript_len
  from posts po
  join creators c on c.id = po.creator_id
  where c.watchlisted = true
  order by po.posted_at desc nulls last, po.id desc
  limit 15
`;

console.log(`\n[scan] ${posts.length} recent watchlist posts:`);
for (const p of posts) {
  const t = Number(p.transcript_len) > 0 ? ` [transcript ${p.transcript_len} chars]` : "";
  console.log(
    `  ${p.platform}/${p.handle} ${p.sentiment}/${p.signal} ${p.content_source ?? "?"}${t}\n    ${p.post_url}`,
  );
}

const yt = posts.find((p) => p.platform === "youtube" && Number(p.transcript_len) > 0);
console.log(
  yt
    ? `\n[scan] OK — YouTube transcript captured for ${yt.handle}.`
    : `\n[scan] No YouTube transcript yet — confirm BRIGHT_DATA_API_KEY + dataset access.`,
);

await sql.end();
