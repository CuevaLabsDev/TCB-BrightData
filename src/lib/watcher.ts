import "server-only";
import { sql } from "@/lib/db";
import { discoverCreatorPosts, correlateCreatorImpact } from "@/lib/bright-data/social";
import { hasBrightData } from "@/lib/bright-data/client";

/**
 * The live trigger engine. Runs on a schedule (Vercel Cron) or on demand.
 *
 *  1. Re-discover creator posts for watched topics (Bright Data SERP + Featherless).
 *  2. Re-correlate creator impact.
 *  3. Detect notable events and write `signals` rows (the alert feed) with
 *     actionable listing links — "creator posted → act now".
 *
 * Signal kinds: creator_move | price_breakout | liquidity_spike | grade_arbitrage
 */

const WATCH_TOPICS = [
  "Prismatic Evolutions Umbreon",
  "Mega Evolution Charizard ex",
  "Pokemon 151 chase card",
];

function tcgSearchLink(name: string) {
  return {
    label: "TCGplayer listings",
    url: `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(name)}`,
  };
}
function ebaySoldLink(name: string) {
  return {
    label: "eBay sold comps",
    url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(name)}&LH_Sold=1&LH_Complete=1`,
  };
}

async function emitSignal(s: {
  kind: string;
  severity: "info" | "watch" | "act";
  productId?: number | null;
  title: string;
  body?: string;
  metrics?: Record<string, unknown>;
  links?: { label: string; url: string }[];
}) {
  // de-dupe: skip if an identical title fired in the last 12h
  const existing = await sql`
    select 1 from signals where title = ${s.title} and created_at > now() - interval '12 hours' limit 1
  `;
  if (existing.length) return false;
  await sql`
    insert into signals (kind, severity, product_id, title, body, metrics, links)
    values (${s.kind}, ${s.severity}, ${s.productId ?? null}, ${s.title}, ${s.body ?? null},
            ${sql.json((s.metrics ?? {}) as never)}, ${sql.json((s.links ?? []) as never)})
  `;
  return true;
}

/** A given source post should drive at most one signal (within a week). */
async function postAlreadySignaled(postUrl: string): Promise<boolean> {
  const rows = await sql`
    select 1 from signals
    where metrics->>'postUrl' = ${postUrl} and created_at > now() - interval '7 days'
    limit 1
  `;
  return rows.length > 0;
}

export interface WatcherResult {
  discoveredPosts: number;
  signalsCreated: number;
  steps: string[];
}

export async function runWatcher(opts: { discover?: boolean } = {}): Promise<WatcherResult> {
  const steps: string[] = [];
  let discoveredPosts = 0;
  let signalsCreated = 0;

  // 1. Optionally discover fresh creator posts (costs SERP+LLM credits).
  if (opts.discover && hasBrightData()) {
    for (const topic of WATCH_TOPICS) {
      try {
        const posts = await discoverCreatorPosts(topic, { maxPosts: 4 });
        discoveredPosts += posts.length;
      } catch {
        /* continue */
      }
    }
    await correlateCreatorImpact();
    steps.push(`discovered ${discoveredPosts} posts across ${WATCH_TOPICS.length} topics`);
  }

  // 2a. Pre-market signals: a WATCHLISTED creator just posted bullish buy/hype on
  //     a card that HASN'T broken out yet — the lead indicator we actually want.
  const preMarket = await sql<
    {
      product_id: number;
      name: string;
      handle: string;
      platform: string;
      impact_score: number;
      flagged: boolean;
      tier: string | null;
      signal: string;
      summary: string;
      post_url: string;
      content_source: string | null;
      chg7d: number | null;
    }[]
  >`
    select p.product_id, p.name, c.handle, c.platform, c.impact_score, c.flagged,
           c.tier, po.signal, po.summary, po.post_url, po.content_source,
           w.chg_7d_pct as chg7d
    from posts po
    join creators c on c.id = po.creator_id
    join unnest(po.mentioned_products) as mp(pid) on true
    join products p on p.product_id = mp.pid
    left join price_windows w on w.product_id = p.product_id
    where c.watchlisted = true
      and po.posted_at > now() - interval '48 hours'
      and po.sentiment = 'bullish' and po.signal in ('buy','hype')
      and coalesce(w.chg_7d_pct, 0) < 10
    order by c.impact_score desc nulls last, po.posted_at desc
    limit 8
  `;
  for (const m of preMarket) {
    if (await postAlreadySignaled(m.post_url)) continue;
    const impact = Number(m.impact_score);
    const fromVideo = m.content_source === "transcript" || m.content_source === "both";
    const created = await emitSignal({
      kind: "creator_move",
      severity: m.tier === "tier1" && m.flagged ? "act" : "watch",
      productId: m.product_id,
      title: `${m.platform}/${m.handle} just posted about ${m.name} — price hasn't moved yet`,
      body: `${m.signal === "buy" ? "Buy" : "Hype"} call${fromVideo ? " (from video)" : ""}: ${m.summary}`,
      metrics: {
        preMarket: true,
        postUrl: m.post_url,
        creatorImpact: impact,
        recent7d: m.chg7d === null ? null : Number(m.chg7d),
        contentSource: m.content_source,
      },
      links: [tcgSearchLink(m.name), ebaySoldLink(m.name), { label: "Source post", url: m.post_url }],
    });
    if (created) signalsCreated++;
  }
  steps.push(`pre-market: ${preMarket.length} candidates`);

  // 2. Creator-move signals: high-impact creator + bullish/buy on a tracked card.
  const creatorMoves = await sql<
    {
      product_id: number;
      name: string;
      handle: string;
      platform: string;
      impact_score: number;
      signal: string;
      summary: string;
      post_url: string;
      chg7d: number | null;
    }[]
  >`
    select p.product_id, p.name, c.handle, c.platform, c.impact_score,
           po.signal, po.summary, po.post_url, w.chg_7d_pct as chg7d
    from posts po
    join creators c on c.id = po.creator_id
    join unnest(po.mentioned_products) as mp(pid) on true
    join products p on p.product_id = mp.pid
    join price_windows w on w.product_id = p.product_id
    where c.impact_score >= 2 and po.signal in ('buy','hype')
      and po.sentiment = 'bullish'
    order by c.impact_score desc
    limit 6
  `;
  for (const m of creatorMoves) {
    const impact = Number(m.impact_score);
    const created = await emitSignal({
      kind: "creator_move",
      severity: impact >= 4 ? "act" : "watch",
      productId: m.product_id,
      title: `${m.platform}/${m.handle} is ${m.signal === "buy" ? "buying" : "hyping"} ${m.name}`,
      body: m.summary,
      metrics: { postUrl: m.post_url, creatorImpact: impact, recent7d: Number(m.chg7d) },
      links: [tcgSearchLink(m.name), ebaySoldLink(m.name), { label: "Source post", url: m.post_url }],
    });
    if (created) signalsCreated++;
  }
  steps.push(`creator moves: ${creatorMoves.length} candidates`);

  // 3. Price-breakout signals: strong 7d move on a liquid card.
  const breakouts = await sql<
    { product_id: number; name: string; chg7d: number; market: number; score: number | null }[]
  >`
    select p.product_id, p.name, w.chg_7d_pct as chg7d, w.market, l.liquidity_score as score
    from price_windows w
    join products p on p.product_id = w.product_id
    left join liquidity l on l.product_id = w.product_id
    where not p.is_sealed and w.market >= 25 and w.data_points >= 120
      and w.chg_7d_pct between 12 and 80
      and w.volatility_30d is not null and w.volatility_30d < 0.6
      and (w.movement_verdict is null
           or w.movement_verdict not in ('suspicious', 'likely_parking'))
    order by w.chg_7d_pct desc
    limit 6
  `;
  for (const b of breakouts) {
    const chg7d = Number(b.chg7d);
    const score = b.score === null ? null : Number(b.score);
    const created = await emitSignal({
      kind: "price_breakout",
      severity: chg7d >= 30 ? "act" : "watch",
      productId: b.product_id,
      title: `${b.name} broke out +${chg7d.toFixed(1)}% (7d)`,
      body: `Market now $${Number(b.market).toFixed(2)}${score !== null ? `, liquidity ${score.toFixed(0)}/100` : ""}.`,
      metrics: { chg7d, market: Number(b.market), liquidity: score },
      links: [tcgSearchLink(b.name), ebaySoldLink(b.name)],
    });
    if (created) signalsCreated++;
  }
  steps.push(`breakouts: ${breakouts.length} candidates`);

  // 4. Grade-arbitrage signals: high PSA10 multiple + decent liquidity.
  const arbs = await sql<
    { product_id: number; name: string; mult: number; raw: number; psa10: number; score: number | null }[]
  >`
    select distinct on (gc.product_id) gc.product_id, p.name,
           gc.grade_multiple as mult, gc.raw_market as raw, gc.avg_sold as psa10,
           l.liquidity_score as score
    from graded_comps gc
    join products p on p.product_id = gc.product_id
    left join liquidity l on l.product_id = gc.product_id
    where gc.grade = 10 and gc.grade_multiple >= 2.5
    order by gc.product_id, gc.as_of desc
  `;
  for (const a of arbs) {
    const mult = Number(a.mult);
    const score = a.score === null ? null : Number(a.score);
    const created = await emitSignal({
      kind: "grade_arbitrage",
      severity: mult >= 3 && (score ?? 0) >= 45 ? "act" : "info",
      productId: a.product_id,
      title: `${a.name}: PSA 10 = ${mult.toFixed(2)}× raw`,
      body: `Raw $${Number(a.raw).toFixed(0)} → PSA 10 $${Number(a.psa10).toFixed(0)}${score !== null ? `, liquidity ${score.toFixed(0)}/100` : ""}.`,
      metrics: { gradeMultiple: mult, raw: Number(a.raw), psa10: Number(a.psa10), liquidity: score },
      links: [ebaySoldLink(`${a.name} PSA 10`), tcgSearchLink(a.name)],
    });
    if (created) signalsCreated++;
  }
  steps.push(`grade arbs: ${arbs.length} candidates`);

  await sql`
    insert into ingest_runs (kind, finished_at, status, rows, detail)
    values ('signals', now(), 'ok', ${signalsCreated},
            ${sql.json({ discoveredPosts, steps } as never)})
  `;

  return { discoveredPosts, signalsCreated, steps };
}
