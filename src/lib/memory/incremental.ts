import "server-only";
import { sql } from "@/lib/db";
import type { PersistedPost } from "@/lib/bright-data/social";

/**
 * Incremental market memory — appends one grounded narrative row per newly
 * ingested creator post, so the agent has fresh social context between the
 * heavyweight daily cognee synthesis runs ([pipeline/memory.py]).
 *
 * Narratives are composed from the already-extracted Featherless summary plus
 * REAL price facts for the mentioned cards (never invented numbers). Rows are
 * tagged `social` and pruned to the most recent N so the table stays bounded;
 * the cognee synthesis delete is scoped to NOT touch these rows.
 */

const MAX_SOCIAL_MEMORIES = 30;

export async function appendMarketMemory(rec: PersistedPost): Promise<void> {
  let cardFacts: { name: string; chg7d: number | null; market: number | null }[] = [];
  if (rec.mentionedProductIds.length) {
    const rows = await sql`
      select p.name, w.chg_7d_pct as chg7d, w.market
      from products p
      join price_windows w on w.product_id = p.product_id
      where p.product_id = any(${sql.array(rec.mentionedProductIds, 1007)})
      order by w.market desc nulls last
      limit 4
    `;
    cardFacts = rows.map((r) => ({
      name: String(r.name),
      chg7d: r.chg7d == null ? null : Number(r.chg7d),
      market: r.market == null ? null : Number(r.market),
    }));
  }

  const factStr = cardFacts
    .map((c) => {
      const price = c.market != null ? `$${c.market.toFixed(2)}` : "n/a";
      const move = c.chg7d != null ? `${c.chg7d >= 0 ? "+" : ""}${c.chg7d.toFixed(1)}% 7d` : "flat 7d";
      return `${c.name} (${price}, ${move})`;
    })
    .join("; ");

  const fromVideo = rec.contentSource === "transcript" || rec.contentSource === "both";
  const title = `Creator update: ${rec.platform}/${rec.handle}`;
  const narrative =
    `${rec.handle} on ${rec.platform} posted a ${rec.signal.sentiment}/${rec.signal.signal} take` +
    `${fromVideo ? " (from video transcript)" : ""}: ${rec.signal.summary}` +
    (factStr ? ` Mentioned cards: ${factStr}.` : "");

  await sql`
    insert into market_memory (scope, title, narrative, tags, metrics)
    values (
      'market', ${title}, ${narrative},
      ${sql.array(["social", rec.platform, rec.signal.signal], 1009)},
      ${sql.json({
        post_url: rec.postUrl,
        product_ids: rec.mentionedProductIds,
        content_source: rec.contentSource,
        sentiment: rec.signal.sentiment,
      } as never)}
    )
  `;

  // Keep only the most recent N social memories.
  await sql`
    delete from market_memory
    where scope = 'market' and tags @> array['social']::text[]
      and id not in (
        select id from market_memory
        where scope = 'market' and tags @> array['social']::text[]
        order by id desc limit ${MAX_SOCIAL_MEMORIES}
      )
  `;
}

/** Append memory for many records, best-effort (never throws to the caller). */
export async function appendMarketMemoryBatch(records: PersistedPost[]): Promise<number> {
  let written = 0;
  for (const rec of records) {
    try {
      await appendMarketMemory(rec);
      written++;
    } catch (err) {
      console.error("[memory] incremental append failed:", err);
    }
  }
  return written;
}
