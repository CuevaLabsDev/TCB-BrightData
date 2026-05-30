import "server-only";
import { sql } from "@/lib/db";
import { extractJson, FEATHERLESS_MODELS } from "@/lib/agent/featherless";
import { serpSearch, type SerpOrganic } from "./client";
import { fetchCreatorPosts, type RawSocialPost } from "./platforms";
import {
  activeWatchlist,
  normalizeHandle,
  type SocialPlatform,
  type WatchlistEntry,
} from "@/lib/social/watchlist";

/**
 * Creator / social-sentiment intelligence.
 *
 * Two ingest paths share one write path (`persistPost` + `upsertCreator`):
 *   1. scanWatchlist()      — PRIMARY. Account-scoped Bright Data Web Data pulls
 *                             for verified handles, incl. YouTube transcripts.
 *   2. discoverCreatorPosts() — SECONDARY. Broad SERP topic discovery to surface
 *                             new voices (title/snippet only).
 *
 * Featherless extracts {sentiment, signal, mentioned_cards}; mentioned cards are
 * matched to catalog products; correlation to price moves runs separately.
 */

const PLATFORM_PATTERNS: { platform: string; host: string }[] = [
  { platform: "youtube", host: "youtube.com" },
  { platform: "tiktok", host: "tiktok.com" },
  { platform: "instagram", host: "instagram.com" },
  { platform: "x", host: "twitter.com" },
  { platform: "x", host: "x.com" },
  { platform: "reddit", host: "reddit.com" },
];

function classifyPlatform(url: string | undefined): string | null {
  if (!url) return null;
  for (const p of PLATFORM_PATTERNS) if (url.includes(p.host)) return p.platform;
  return null;
}

function extractHandle(url: string, platform: string): string {
  try {
    const u = new URL(url);
    if (platform === "youtube") {
      const m = u.pathname.match(/\/(@[^/]+)/) || u.pathname.match(/\/(channel|c|user)\/([^/]+)/);
      return m ? (m[1].startsWith("@") ? m[1] : m[2]) : "youtube";
    }
    if (platform === "tiktok") {
      const m = u.pathname.match(/@([^/]+)/);
      return m ? `@${m[1]}` : "tiktok";
    }
    if (platform === "instagram") {
      const m = u.pathname.split("/").filter(Boolean)[0];
      return m ? `@${m}` : "instagram";
    }
    if (platform === "x") {
      const m = u.pathname.split("/").filter(Boolean)[0];
      return m ? `@${m}` : "x";
    }
    if (platform === "reddit") {
      const m = u.pathname.match(/\/r\/([^/]+)/);
      return m ? `r/${m[1]}` : "reddit";
    }
  } catch {
    /* fall through */
  }
  return platform;
}

export interface ExtractedSignal {
  sentiment: "bullish" | "bearish" | "neutral";
  signal: "buy" | "sell" | "hold" | "hype";
  mentioned_cards: string[];
  confidence: number;
  summary: string;
}

const EXTRACT_SYSTEM =
  "You are a Pokemon TCG market-sentiment analyst. Output ONLY one JSON object. " +
  "Judge a social post's market signal for trading-card investors. The text may " +
  "be a title, a caption, and/or a spoken-word video transcript.";

const MAX_CONTENT_CHARS = 4000;

/** Featherless sentiment/signal extraction over full post content. */
export async function extractSignalFromPost(input: {
  title?: string;
  caption?: string;
  transcript?: string | null;
}): Promise<ExtractedSignal | null> {
  const parts: string[] = [];
  if (input.title) parts.push(`Title: ${input.title}`);
  if (input.caption && input.caption !== input.title) parts.push(`Caption: ${input.caption}`);
  if (input.transcript) parts.push(`Transcript: ${input.transcript}`);
  const content = parts.join("\n").slice(0, MAX_CONTENT_CHARS);
  if (content.trim().length < 3) return null;

  const prompt =
    `${content}\n\n` +
    `Return JSON exactly: {"sentiment":"bullish|bearish|neutral",` +
    `"signal":"buy|sell|hold|hype","mentioned_cards":["card or set names"],` +
    `"confidence":0.0,"summary":"one sentence on the market take"}`;
  return extractJson<ExtractedSignal>(EXTRACT_SYSTEM, prompt, {
    model: FEATHERLESS_MODELS.default,
    maxTokens: 280,
  });
}

/** Match free-text card names to catalog product_ids via ilike search. */
async function matchProducts(names: string[]): Promise<number[]> {
  const ids = new Set<number>();
  for (const raw of names.slice(0, 5)) {
    const name = raw.trim();
    if (name.length < 3) continue;
    const rows = await sql<{ product_id: number }[]>`
      select p.product_id
      from products p
      join price_windows w on w.product_id = p.product_id
      where p.name ilike ${"%" + name + "%"} and not p.is_sealed
      order by w.market desc nulls last
      limit 1
    `;
    if (rows[0]) ids.add(Number(rows[0].product_id));
  }
  return [...ids];
}

interface UpsertCreatorInput {
  handle: string;
  platform: string;
  url: string;
  displayName?: string | null;
  watchlisted?: boolean;
  tier?: string | null;
  markScanned?: boolean;
}

async function upsertCreator(input: UpsertCreatorInput): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`
    insert into creators (handle, platform, display_name, url, watchlisted, tier, last_scanned_at)
    values (
      ${input.handle}, ${input.platform}, ${input.displayName ?? input.handle},
      ${input.url}, ${input.watchlisted ?? false}, ${input.tier ?? null},
      ${input.markScanned ? sql`now()` : null}
    )
    on conflict (platform, handle) do update set
      url = excluded.url,
      display_name = coalesce(creators.display_name, excluded.display_name),
      watchlisted = creators.watchlisted or excluded.watchlisted,
      tier = coalesce(excluded.tier, creators.tier),
      last_scanned_at = coalesce(excluded.last_scanned_at, creators.last_scanned_at)
    returning id
  `;
  return rows[0]?.id ?? null;
}

interface PersistPostInput {
  creatorId: number | null;
  platform: string;
  postUrl: string;
  postedAt: Date | null;
  caption: string;
  transcript: string | null;
  likes: number | null;
  views: number | null;
  comments: number | null;
  sentiment: string;
  signal: string;
  mentionedProductIds: number[];
  summary: string;
  contentSource: string;
  raw: Record<string, unknown>;
}

/** Upsert a post; `inserted` is true only on first insert (drives memory/signals). */
async function persistPost(p: PersistPostInput): Promise<{ id: number; inserted: boolean }> {
  // fetch_types:false on the pooler — pass the int4[] OID (1007) explicitly.
  const mentionedProducts =
    p.mentionedProductIds.length > 0 ? sql.array(p.mentionedProductIds, 1007) : null;
  const rows = await sql<{ id: number; inserted: boolean }[]>`
    insert into posts
      (creator_id, platform, post_url, posted_at, caption, likes, views, comments,
       sentiment, signal, mentioned_products, summary, transcript, content_source, raw)
    values
      (${p.creatorId}, ${p.platform}, ${p.postUrl}, ${p.postedAt}, ${p.caption},
       ${p.likes}, ${p.views}, ${p.comments}, ${p.sentiment}, ${p.signal},
       ${mentionedProducts}, ${p.summary}, ${p.transcript}, ${p.contentSource},
       ${sql.json(p.raw as never)})
    on conflict (post_url) do update set
      sentiment = excluded.sentiment, signal = excluded.signal,
      mentioned_products = excluded.mentioned_products, summary = excluded.summary,
      transcript = coalesce(excluded.transcript, posts.transcript),
      content_source = excluded.content_source,
      posted_at = coalesce(excluded.posted_at, posts.posted_at),
      likes = coalesce(excluded.likes, posts.likes),
      views = coalesce(excluded.views, posts.views),
      comments = coalesce(excluded.comments, posts.comments)
    returning id, (xmax = 0) as inserted
  `;
  return { id: Number(rows[0].id), inserted: Boolean(rows[0].inserted) };
}

function contentSourceOf(post: RawSocialPost): string {
  const hasCaption = post.caption.trim().length > 0;
  const hasTranscript = (post.transcript ?? "").trim().length > 0;
  if (hasTranscript && hasCaption) return "both";
  if (hasTranscript) return "transcript";
  return "caption";
}

export interface PersistedPost {
  id: number;
  platform: string;
  handle: string;
  postUrl: string;
  signal: ExtractedSignal;
  mentionedProductIds: number[];
  contentSource: string;
}

export interface ScanWatchlistResult {
  scanned: number;
  fetched: number;
  newPosts: number;
  records: PersistedPost[];
}

/**
 * PRIMARY ingest. Pull recent posts for watchlisted creators via Bright Data
 * Web Data scrapers, analyze with Featherless, and persist. Pass `handles`
 * and/or `platforms` to scan a subset (e.g. a Triggerware tier1 delta).
 */
export async function scanWatchlist(
  opts: {
    handles?: string[];
    platforms?: SocialPlatform[];
    maxPostsPerCreator?: number;
    since?: Date;
  } = {},
): Promise<ScanWatchlistResult> {
  const wantHandles = opts.handles?.map(normalizeHandle);
  let entries = activeWatchlist();
  if (wantHandles?.length) {
    entries = entries.filter((e) => wantHandles.includes(normalizeHandle(e.handle)));
  }
  if (opts.platforms?.length) {
    entries = entries.filter((e) => opts.platforms!.includes(e.platform));
  }

  const records: PersistedPost[] = [];
  let fetched = 0;
  let newPosts = 0;

  for (const entry of entries) {
    const creatorId = await upsertCreator({
      handle: entry.handle,
      platform: entry.platform,
      url: entry.profileUrl,
      watchlisted: true,
      tier: entry.tier,
      markScanned: true,
    });

    const posts = await fetchCreatorPosts(entry, {
      maxPosts: opts.maxPostsPerCreator ?? 5,
      since: opts.since,
    });
    fetched += posts.length;

    for (const post of posts) {
      const signal = await extractSignalFromPost({
        caption: post.caption,
        transcript: post.transcript,
      });
      if (!signal) continue;
      const mentionedProductIds = await matchProducts(signal.mentioned_cards ?? []);
      const contentSource = contentSourceOf(post);

      const { id, inserted } = await persistPost({
        creatorId,
        platform: post.platform,
        postUrl: post.postUrl,
        postedAt: post.postedAt,
        caption: post.caption,
        transcript: post.transcript,
        likes: post.likes,
        views: post.views,
        comments: post.comments,
        sentiment: signal.sentiment,
        signal: signal.signal,
        mentionedProductIds,
        summary: signal.summary,
        contentSource,
        raw: {
          ...post.raw,
          confidence: signal.confidence,
          mentioned: signal.mentioned_cards,
        },
      });

      if (inserted) {
        newPosts++;
        records.push({
          id,
          platform: post.platform,
          handle: entry.handle,
          postUrl: post.postUrl,
          signal,
          mentionedProductIds,
          contentSource,
        });
      }
    }
  }

  return { scanned: entries.length, fetched, newPosts, records };
}

export interface DiscoveredPost {
  platform: string;
  handle: string;
  url: string;
  title: string;
  signal: ExtractedSignal;
  mentionedProductIds: number[];
}

/**
 * SECONDARY ingest. Broad SERP topic discovery — surfaces new creators talking
 * about a card/set. Title + snippet only (no transcript). Use scanWatchlist for
 * monitored accounts.
 */
export async function discoverCreatorPosts(
  topic: string,
  opts: { maxPosts?: number } = {},
): Promise<DiscoveredPost[]> {
  const maxPosts = opts.maxPosts ?? 8;
  const query = `${topic} pokemon cards investment OR price OR sold (site:youtube.com OR site:tiktok.com OR site:instagram.com OR site:reddit.com OR site:x.com)`;
  const { organic } = await serpSearch(query, { num: 20 });

  const candidates: SerpOrganic[] = organic
    .filter((o) => classifyPlatform(o.link))
    .slice(0, maxPosts);

  const out: DiscoveredPost[] = [];

  for (const c of candidates) {
    const platform = classifyPlatform(c.link)!;
    const url = c.link!;
    const title = c.title ?? "";
    const snippet = c.description ?? "";
    const signal = await extractSignalFromPost({ title, caption: snippet });
    if (!signal) continue;

    const mentionedProductIds = await matchProducts(signal.mentioned_cards ?? []);
    const handle = extractHandle(url, platform);
    const creatorId = await upsertCreator({ handle, platform, url });

    await persistPost({
      creatorId,
      platform,
      postUrl: url,
      postedAt: null,
      caption: title,
      transcript: null,
      likes: null,
      views: null,
      comments: null,
      sentiment: signal.sentiment,
      signal: signal.signal,
      mentionedProductIds,
      summary: signal.summary,
      contentSource: "caption",
      raw: { snippet, confidence: signal.confidence, mentioned: signal.mentioned_cards },
    });

    out.push({ platform, handle, url, title, signal, mentionedProductIds });
  }

  return out;
}

/**
 * Correlate creator posts to subsequent price moves: for each post mentioning a
 * product, measure the product's % change in the window after the post and
 * write it back as the post's impact, then roll up per-creator impact_score.
 */
export async function correlateCreatorImpact(): Promise<{ updated: number }> {
  // Post impact = product's 7d change at scan time (proxy when post lacks a date)
  const updated = await sql`
    with post_moves as (
      select po.id,
             avg(w.chg_7d_pct) as move
      from posts po
      join unnest(po.mentioned_products) as mp(product_id) on true
      join price_windows w on w.product_id = mp.product_id
      where po.mentioned_products is not null
        and array_length(po.mentioned_products, 1) > 0
      group by po.id
    )
    update posts p
    set impact_pct = pm.move
    from post_moves pm
    where p.id = pm.id
    returning p.id
  `;

  // Creator impact score: avg absolute impact of their bullish/buy posts,
  // scaled; flag creators whose mentions reliably precede big moves.
  await sql`
    with creator_impact as (
      select creator_id,
             avg(abs(impact_pct)) as avg_abs_move,
             count(*) as n
      from posts
      where creator_id is not null and impact_pct is not null
      group by creator_id
    )
    update creators c
    set impact_score = least(100, round(coalesce(ci.avg_abs_move, 0)::numeric, 2)),
        flagged = coalesce(ci.avg_abs_move, 0) >= 15 and ci.n >= 1
    from creator_impact ci
    where c.id = ci.creator_id
  `;

  return { updated: updated.length };
}
