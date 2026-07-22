import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { sql } from "@/lib/db";
import {
  getBullishCreatorImpact,
  getCard,
  getCardVariants,
  getGradedComps,
  getLiquidity,
  getPriceHistory,
  getSetupCandidates,
  getStoredMovement,
  getTopMovers,
  searchCards,
} from "@/lib/queries";
import { hasBrightData } from "@/lib/bright-data/client";
import { enrichGraded, enrichLiquidity } from "@/lib/bright-data/enrich";
import { detectMovementSignals } from "@/lib/price-intelligence/movement";
import type { Liquidity } from "@/lib/types";

function pickLiquidity(rows: Liquidity[]): Liquidity | null {
  return rows.find((l) => l.source === "tcgplayer") ?? rows[0] ?? null;
}

function allowsLiveRefresh(context: unknown) {
  return Boolean((context as { allowLiveRefresh?: boolean } | null)?.allowLiveRefresh);
}

/**
 * Agent tools spanning all five intelligence layers. The agent (Featherless)
 * composes these to answer enterprise operator questions with cited, structured
 * data — never invented numbers.
 */

async function resolveCard(query: string, productId?: number) {
  // Prefer name search — models often hallucinate productIds. Only trust an
  // explicit id if it actually resolves to a real card.
  const matches = await searchCards(query, 1);
  if (matches[0]) return matches[0];
  if (productId && Number.isFinite(productId)) {
    const c = await getCard(productId);
    if (c) return c;
  }
  return null;
}

export const agentTools = {
  search_catalog: tool({
    description:
      "Search the Pokemon catalog (32k products, 216 sets) by card name. Returns matches with market price and 7/30/90/180d price-change analytics. Use this first to find a card.",
    inputSchema: z.object({
      query: z.string().describe("Card name, e.g. 'Umbreon ex 161' or 'Charizard'"),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    execute: async ({ query, limit }) => {
      const cards = await searchCards(query, limit);
      return {
        count: cards.length,
        cards: cards.map((c) => ({
          productId: c.productId,
          name: c.name,
          subType: c.subType,
          set: c.setName,
          market: c.market,
          chg7d: c.chg7d,
          chg30d: c.chg30d,
          chg90d: c.chg90d,
          chg180d: c.chg180d,
        })),
      };
    },
  }),

  get_price_analytics: tool({
    description:
      "Get full price analytics for one card: market price, 7/30/90/180d % changes, 180d high/low, 30d volatility, and all variants (Normal/Holofoil/etc).",
    inputSchema: z.object({
      query: z.string().describe("Card name"),
      productId: z.number().int().optional(),
    }),
    execute: async ({ query, productId }) => {
      const card = await resolveCard(query, productId);
      if (!card) return { found: false, message: "No matching card." };
      const [variants, history] = await Promise.all([
        getCardVariants(card.productId),
        getPriceHistory(card.productId, card.subType, 30),
      ]);
      return {
        found: true,
        productId: card.productId,
        name: card.name,
        set: card.setName,
        number: card.number,
        rarity: card.rarity,
        variants: variants.map((v) => ({
          subType: v.subType,
          market: v.market,
          chg7d: v.chg7d,
          chg30d: v.chg30d,
          chg90d: v.chg90d,
          chg180d: v.chg180d,
          high180d: v.high180d,
          low180d: v.low180d,
          volatility30d: v.volatility30d,
        })),
        recentDaily: history.map((p) => ({
          date: p.date,
          low: p.low,
          market: p.market,
          high: p.high,
        })),
      };
    },
  }),

  assess_price_movement: tool({
    description:
      "Judge whether a card's recent price MOVE is demand-justified or 'price parking' (a seller re-listing high with no sales behind it). TCGplayer market is listing-derived, so this combines robust outlier math on the daily series with sold velocity, the market-vs-lowest-ask spread, liquidity, and creator catalysts. Returns a verdict (justified|mixed|suspicious|likely_parking), reason codes, and cited metrics — NOT a fair value or buy/sell call. Use for 'is this move real?' questions.",
    inputSchema: z.object({
      query: z.string().describe("Card name"),
      productId: z.number().int().optional(),
      refreshLive: z
        .boolean()
        .default(false)
        .describe("Scan live TCGplayer liquidity via Bright Data only when the user explicitly asked for live/fresh data"),
    }),
    execute: async ({ query, productId, refreshLive }, { experimental_context }) => {
      const card = await resolveCard(query, productId);
      if (!card) return { found: false };

      const [history, stored, bullishImpact, comps] = await Promise.all([
        getPriceHistory(card.productId, card.subType, 90),
        getStoredMovement(card.productId, card.subType),
        getBullishCreatorImpact(card.productId),
        getGradedComps(card.productId),
      ]);

      let liquidityRows = await getLiquidity(card.productId);
      let refreshed = false;
      const liveRefreshAllowed = allowsLiveRefresh(experimental_context);
      if (refreshLive && liveRefreshAllowed && liquidityRows.length === 0 && hasBrightData()) {
        await enrichLiquidity(card);
        liquidityRows = await getLiquidity(card.productId);
        refreshed = true;
      }
      const liq = pickLiquidity(liquidityRows);

      const markets = history
        .map((p) => p.market)
        .filter((m): m is number => m !== null);
      const last = history.at(-1);
      const last30 = markets.slice(-30);
      const avg30 = last30.length
        ? last30.reduce((a, b) => a + b, 0) / last30.length
        : null;

      const assessment = detectMovementSignals({
        marketHistory: markets,
        latestMarket: last?.market ?? card.market,
        latestLow: last?.low ?? null,
        latestHigh: last?.high ?? null,
        chg7dPct: card.chg7d,
        avgMarket30d: avg30,
        soldVelocity: liq?.soldVelocity ?? null,
        liquidityScore: liq?.liquidityScore ?? null,
        bidAskSpreadPct: liq?.bidAskSpreadPct ?? null,
        bullishCreatorImpact: bullishImpact,
        soldCompMedian: null,
      });

      return {
        found: true,
        card: card.name,
        subType: card.subType,
        verdict: assessment.verdict,
        confidence: assessment.confidence,
        reasonCodes: assessment.reasonCodes,
        metrics: assessment.metrics,
        narrativeHint: assessment.narrativeHint,
        needsNarrative: assessment.needsNarrative,
        stored: stored
          ? { verdict: stored.verdict, confidence: stored.confidence, codes: stored.codes }
          : null,
        dataNote:
          markets.length < 5
            ? "Sparse daily history — verdict is low-confidence."
            : liquidityRows.length === 0
              ? liveRefreshAllowed
                ? "No stored liquidity — pass refreshLive to scan live, or treat demand signals as unknown."
                : "No stored liquidity — live Bright Data refresh was not requested, so demand signals are unknown."
              : refreshed
                ? "Liquidity freshly scanned via Bright Data."
                : undefined,
        gradedContext: comps.slice(0, 1).map((g) => ({
          grade: g.grade,
          medianSold: g.avgSold,
          gradeMultiple: g.gradeMultiple,
        })),
      };
    },
  }),

  find_setup_candidates: tool({
    description:
      "Screen the stored warehouse for under-the-radar card candidates: no recent 7/30d spike, low active listings, stored liquidity/sold velocity, creator popularity signals, and PSA 10 grade multiple. Use this for broad questions like 'worth investing', 'primed for upward movement', 'low listings', 'high popularity', or 'not spiked yet'. Returns ranked candidates with cited metrics and risk flags.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(12).default(8),
      minMarket: z.number().min(0).default(10),
      maxActiveListings: z.number().int().min(1).max(100).default(30),
      max7dChangePct: z.number().default(20),
      max30dChangePct: z.number().default(35),
      min30dChangePct: z.number().default(-20),
    }),
    execute: async ({
      limit,
      minMarket,
      maxActiveListings,
      max7dChangePct,
      max30dChangePct,
      min30dChangePct,
    }) => {
      const candidates = await getSetupCandidates({
        limit,
        minMarket,
        maxActiveListings,
        max7dChangePct,
        max30dChangePct,
        min30dChangePct,
      });

      return {
        filters: {
          minMarket,
          maxActiveListings,
          max7dChangePct,
          max30dChangePct,
          min30dChangePct,
        },
        count: candidates.length,
        note:
          "Uses stored Bright Data only. Creator/social coverage is sparse. If all candidates have no stored creator mentions, say there is no high-popularity evidence in stored data and frame the rows as watchlist candidates, not buy recommendations.",
        candidates: candidates.map((c) => ({
          productId: c.productId,
          name: c.name,
          subType: c.subType,
          set: c.setName,
          setupScore: c.setupScore,
          market: c.market,
          chg7d: c.chg7d,
          chg30d: c.chg30d,
          chg90d: c.chg90d,
          activeListings: c.activeListings,
          totalQuantity: c.totalQuantity,
          soldVelocity: c.soldVelocity,
          liquidityScore: c.liquidityScore,
          bidAskSpreadPct: c.bidAskSpreadPct,
          creatorMentions: c.creatorMentions,
          bullishMentions: c.bullishMentions,
          maxCreatorImpact: c.maxCreatorImpact,
          psa10: c.psa10,
          gradeMultiple: c.gradeMultiple,
          gradeSampleSize: c.gradeSampleSize,
          operatorVerdict:
            (c.liquidityScore !== null && c.liquidityScore < 20) ||
            c.creatorMentions === 0 ||
            c.soldVelocity === null ||
            c.soldVelocity === 0
              ? "watchlist_only_low_evidence"
              : "stronger_stored_setup",
          thesisSignals: [
            c.chg30d !== null && c.chg30d <= max30dChangePct
              ? "no_recent_30d_spike"
              : null,
            c.activeListings !== null && c.activeListings <= maxActiveListings
              ? "low_listing_depth"
              : null,
            c.soldVelocity !== null && c.soldVelocity > 0 ? "stored_sold_velocity" : null,
            c.bullishMentions > 0 ? "bullish_creator_mentions" : null,
            c.gradeMultiple !== null && c.gradeMultiple > 1 ? "psa10_spread" : null,
          ].filter(Boolean),
          riskFlags: [
            c.soldVelocity === null || c.soldVelocity === 0 ? "no_stored_velocity" : null,
            c.creatorMentions === 0 ? "no_stored_creator_mentions" : null,
            c.liquidityScore !== null && c.liquidityScore < 20 ? "thin_liquidity" : null,
          ].filter(Boolean),
        })),
      };
    },
  }),

  get_top_movers: tool({
    description:
      "Get the biggest market movers (gainers or losers) over a period. For spotting trends and momentum across the catalog.",
    inputSchema: z.object({
      period: z.enum(["7d", "30d", "90d", "180d"]).default("30d"),
      direction: z.enum(["up", "down"]).default("up"),
      minMarket: z.number().default(20).describe("Minimum market price filter"),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    execute: async ({ period, direction, minMarket, limit }) => {
      const movers = await getTopMovers({ period, direction, minMarket, limit });
      return {
        period,
        direction,
        movers: movers.map((m) => ({
          name: m.name,
          subType: m.subType,
          set: m.setName,
          market: m.market,
          change:
            period === "7d" ? m.chg7d : period === "30d" ? m.chg30d : period === "90d" ? m.chg90d : m.chg180d,
        })),
      };
    },
  }),

  get_grade_arbitrage: tool({
    description:
      "Get raw-vs-PSA-10 grade arbitrage for a card: the multiple between raw Near Mint price and PSA 10 realized sold price, with liquidity context. High multiple + liquid = grading submission opportunity. Reads stored eBay comps.",
    inputSchema: z.object({
      query: z.string(),
      productId: z.number().int().optional(),
    }),
    execute: async ({ query, productId }) => {
      const card = await resolveCard(query, productId);
      if (!card) return { found: false };
      const [comps, liq] = await Promise.all([
        getGradedComps(card.productId),
        getLiquidity(card.productId),
      ]);
      return {
        found: true,
        card: card.name,
        rawMarket: card.market,
        gradedComps: comps.map((g) => ({
          grade: g.grade,
          medianSold: g.avgSold,
          sampleSize: g.sampleSize,
          gradeMultiple: g.gradeMultiple,
        })),
        liquidity: liq[0]
          ? { score: liq[0].liquidityScore, soldVelocity: liq[0].soldVelocity }
          : null,
        note:
          comps.length === 0
            ? "No stored graded comps yet. Offer a live Bright Data refresh only if the user wants fresh comps."
            : undefined,
      };
    },
  }),

  get_liquidity: tool({
    description:
      "Get marketplace liquidity for a card: composite liquidity score (0-100), sold velocity (per day), active listing depth, seller count, and bid/ask spread. From TCGplayer + eBay via Bright Data.",
    inputSchema: z.object({
      query: z.string(),
      productId: z.number().int().optional(),
    }),
    execute: async ({ query, productId }) => {
      const card = await resolveCard(query, productId);
      if (!card) return { found: false };
      const liq = await getLiquidity(card.productId);
      return {
        found: true,
        card: card.name,
        liquidity: liq.map((l) => ({
          source: l.source,
          score: l.liquidityScore,
          soldVelocity: l.soldVelocity,
          activeListings: l.activeListings,
          bidAskSpreadPct: l.bidAskSpreadPct,
        })),
        note:
          liq.length === 0
            ? "No stored liquidity data. Offer a live Bright Data refresh only if the user wants fresh liquidity."
            : undefined,
      };
    },
  }),

  get_creator_sentiment: tool({
    description:
      "Get content-creator sentiment and market-influence signals. Either for a specific card (who's talking about it) or the top market-moving creators overall. Creators with higher impact scores have mentions that precede larger price moves.",
    inputSchema: z.object({
      query: z.string().optional().describe("Card name to filter by, or omit for top creators"),
    }),
    execute: async ({ query }) => {
      if (query) {
        const card = await resolveCard(query);
        if (!card) return { found: false };
        const posts = await sql`
          select po.platform, c.handle, po.sentiment, po.signal, po.summary,
                 c.impact_score, c.flagged, c.watchlisted, po.post_url,
                 po.posted_at, po.content_source
          from posts po left join creators c on c.id = po.creator_id
          where ${card.productId} = any(po.mentioned_products)
          order by c.watchlisted desc, c.impact_score desc nulls last,
                   po.posted_at desc nulls last limit 10`;
        return {
          found: true,
          card: card.name,
          posts: posts.map((p) => ({
            platform: p.platform,
            handle: p.handle,
            sentiment: p.sentiment,
            signal: p.signal,
            summary: p.summary,
            creatorImpact: p.impact_score,
            flagged: p.flagged,
            watchlisted: p.watchlisted,
            postedAt: p.posted_at,
            fromTranscript: p.content_source === "transcript" || p.content_source === "both",
            url: p.post_url,
          })),
        };
      }
      const creators = await sql`
        select c.platform, c.handle, c.impact_score, c.flagged, c.watchlisted, c.tier,
               count(po.id) as posts
        from creators c left join posts po on po.creator_id = c.id
        group by c.id, c.platform, c.handle, c.impact_score, c.flagged, c.watchlisted, c.tier
        order by c.watchlisted desc, c.impact_score desc nulls last limit 10`;
      return {
        topCreators: creators.map((c) => ({
          platform: c.platform,
          handle: c.handle,
          impactScore: c.impact_score,
          flagged: c.flagged,
          watchlisted: c.watchlisted,
          tier: c.tier,
          posts: Number(c.posts),
        })),
      };
    },
  }),

  recall_market_memory: tool({
    description:
      "Recall the agent's learned market memory: the cognee knowledge-graph synthesis (historical market shifts), the most recent live creator activity (incrementally appended as watchlist posts arrive), and any memories matching the topic. Use for high-level questions about market trends, narratives, what creators are saying right now, and domain context.",
    inputSchema: z.object({
      topic: z.string().describe("What to recall, e.g. 'grade arbitrage opportunities' or 'what creators are saying'"),
    }),
    execute: async ({ topic }) => {
      const [synthesis, social, related] = await Promise.all([
        sql`
          select title, narrative from market_memory
          where scope = 'market' and tags @> array['synthesis']::text[]
          order by id desc limit 1`,
        sql`
          select title, narrative, created_at from market_memory
          where scope = 'market' and tags @> array['social']::text[]
          order by id desc limit 6`,
        topic
          ? sql`
              select title, narrative from market_memory
              where scope = 'market'
                and (title ilike ${"%" + topic + "%"} or narrative ilike ${"%" + topic + "%"})
              order by id desc limit 4`
          : Promise.resolve([] as { title: string; narrative: string }[]),
      ]);
      return {
        synthesis: synthesis.map((m) => ({ title: m.title, narrative: m.narrative })),
        recentCreatorActivity: social.map((m) => ({
          title: m.title,
          narrative: m.narrative,
        })),
        related: related.map((m) => ({ title: m.title, narrative: m.narrative })),
      };
    },
  }),

  refresh_live_intel: tool({
    description:
      "Trigger a LIVE Bright Data scan for a card: fetches current TCGplayer liquidity (depth, velocity, spread) and eBay PSA 10/9 sold comps, persists them, and returns fresh numbers. Use only when the user explicitly asks for live, fresh, refreshed, latest, today, scan, scrape, real-time, or Bright Data data.",
    inputSchema: z.object({
      query: z.string(),
      productId: z.number().int().optional(),
      includeGraded: z.boolean().default(true),
    }),
    execute: async ({ query, productId, includeGraded }, { experimental_context }) => {
      if (!allowsLiveRefresh(experimental_context)) {
        return {
          error:
            "Live Bright Data refresh is disabled for this request. Use stored warehouse data and ask the user to request a live refresh if needed.",
        };
      }
      if (!hasBrightData()) return { error: "Bright Data not configured" };
      const card = await resolveCard(query, productId);
      if (!card) return { found: false };
      const [liquidity, graded] = await Promise.all([
        enrichLiquidity(card),
        includeGraded ? enrichGraded(card) : Promise.resolve([]),
      ]);
      return {
        found: true,
        card: card.name,
        live: {
          liquidityScore: liquidity.score,
          activeListings: liquidity.activeListings,
          sellers: liquidity.sellers,
          soldPerDay: liquidity.soldPerDay,
          bidAskSpreadPct: liquidity.bidAskSpreadPct,
          gradedComps: graded.map((g) => ({
            grade: g.grade,
            medianSold: g.scan.median,
            sampleSize: g.scan.count,
            gradeMultiple: g.gradeMultiple,
          })),
        },
      };
    },
  }),
};

export type AgentTools = typeof agentTools;
