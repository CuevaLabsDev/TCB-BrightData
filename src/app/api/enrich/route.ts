import { getCard, getGradedComps, getLiquidity } from "@/lib/queries";
import { hasBrightData } from "@/lib/bright-data/client";
import { enrichGraded, enrichLiquidity } from "@/lib/bright-data/enrich";
import { rateLimit } from "@/lib/rate-limit";
import type { GradedComp, Liquidity } from "@/lib/types";

/** Multi-page eBay sold scrapes after TCG need headroom. */
export const maxDuration = 300;

const ENRICH_LIMIT = 8;
const ENRICH_WINDOW_MS = 10 * 60 * 1000;
/** Liquidity moves fast — short TTL when force is false. */
const LIQUIDITY_FRESH_MS = 60 * 60 * 1000;
/**
 * Graded multiples move slowly. Reuse warehouse PSA comps inside this window
 * unless forceGraded is set.
 */
const GRADED_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * POST /api/enrich
 * body: {
 *   productId: number,
 *   subType?: string,
 *   graded?: boolean,          // false skips graded entirely
 *   force?: boolean,           // force live TCGplayer liquidity
 *   forceGraded?: boolean,     // force live eBay (default false)
 *   grades?: number[],         // default [10] for live; [10,9] for full
 * }
 *
 * Streams NDJSON:
 *   { type: "liquidity", cached?, card, liquidity }
 *   { type: "graded", cached?, graded, error? }
 *   { type: "done" }
 *   { type: "error", error }
 *
 * Liquidity then graded run sequentially so Unlocker zone contention does not
 * abort the whole refresh. Graded failures are isolated when liquidity succeeded.
 */
export async function POST(req: Request) {
  if (!rateLimit(req, "enrich", { limit: ENRICH_LIMIT, windowMs: ENRICH_WINDOW_MS })) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  if (!hasBrightData()) {
    return Response.json(
      { error: "BRIGHT_DATA_API_KEY not configured" },
      { status: 503 },
    );
  }

  let body: {
    productId?: number;
    subType?: string;
    graded?: boolean;
    force?: boolean;
    forceGraded?: boolean;
    grades?: number[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const productId = Number(body.productId);
  if (!Number.isFinite(productId)) {
    return Response.json({ error: "productId required" }, { status: 400 });
  }

  const card = await getCard(productId, body.subType);
  if (!card) {
    return Response.json({ error: "card not found" }, { status: 404 });
  }

  const force = body.force === true;
  const forceGraded = body.forceGraded === true;
  // Sealed products (ETB/case/box) have no PSA singles comps.
  const wantGraded = body.graded !== false && !card.isSealed;
  const grades =
    Array.isArray(body.grades) && body.grades.length > 0
      ? body.grades.filter((g) => Number.isFinite(g)).map(Number)
      : [10];
  const cardPayload = {
    productId: card.productId,
    name: card.name,
    subType: card.subType,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      let liquidityOk = false;

      try {
        const [storedLiq, storedGraded] = await Promise.all([
          getLiquidity(productId, card.subType),
          wantGraded ? getGradedComps(productId) : Promise.resolve([] as GradedComp[]),
        ]);

        const liqRow =
          storedLiq.find((l) => l.subType === card.subType && l.source === "tcgplayer") ??
          storedLiq.find((l) => l.subType === card.subType) ??
          storedLiq[0];
        const liqFresh = !force && isFresh(liqRow?.asOf, LIQUIDITY_FRESH_MS);

        const primaryGrade = Math.max(...grades);
        const primaryStored = storedGraded.find((g) => g.grade === primaryGrade);
        const gradedFresh =
          !forceGraded &&
          wantGraded &&
          isFresh(primaryStored?.asOf, GRADED_FRESH_MS);

        // --- Liquidity first (never parallel with eBay) ---
        try {
          if (liqFresh && liqRow) {
            send({
              type: "liquidity",
              cached: true,
              card: cardPayload,
              liquidity: mapStoredLiquidity(liqRow),
            });
            liquidityOk = true;
          } else {
            const liquidity = await enrichLiquidity(card);
            send({
              type: "liquidity",
              cached: false,
              card: cardPayload,
              liquidity: {
                score: liquidity.score,
                activeListings: liquidity.activeListings,
                sellers: liquidity.sellers,
                weeklyQtySold: liquidity.weeklyQtySold,
                soldPerDay: liquidity.soldPerDay,
                bidAskSpreadPct: liquidity.bidAskSpreadPct,
                buyoutUsd: liquidity.buyoutUsd,
                buyoutQty: liquidity.buyoutQty,
                buyoutPartial: liquidity.buyoutPartial,
                priceGaps: liquidity.priceGaps,
              },
            });
            liquidityOk = true;
          }
        } catch (e) {
          // Liquidity failure is fatal only if we also can't do graded later.
          send({
            type: "error",
            error: e instanceof Error ? e.message : "liquidity enrichment failed",
          });
          return;
        }

        // --- Graded second; failures isolated ---
        if (!wantGraded) {
          if (card.isSealed) {
            await enrichGraded(card, []);
          }
          send({ type: "graded", cached: true, graded: [] });
        } else if (gradedFresh) {
          send({
            type: "graded",
            cached: true,
            graded: storedGraded.map(mapStoredGraded),
          });
        } else {
          try {
            const graded = await enrichGraded(card, grades);
            const liveGrades = new Set(graded.map((g) => g.grade));
            // Live path ran: do not re-attach stale warehouse rows for grades we
            // requested but got 0 comps for — surface explicit empties.
            const livePayload = grades.map((grade) => {
              const hit = graded.find((g) => g.grade === grade);
              if (hit) {
                return {
                  grade: hit.grade,
                  market: hit.scan.market ?? hit.scan.median,
                  median: hit.scan.median,
                  sampleSize: hit.scan.count,
                  gradeMultiple: hit.gradeMultiple,
                  soldPerDay: hit.scan.soldPerDay,
                  soldPerMonth: hit.scan.soldPerMonth,
                };
              }
              return {
                grade,
                market: null,
                median: null,
                sampleSize: 0,
                gradeMultiple: null,
                soldPerDay: null,
                soldPerMonth: null,
              };
            });
            const merged = [
              ...livePayload,
              ...storedGraded
                .filter((g) => !liveGrades.has(g.grade) && !grades.includes(g.grade))
                .map(mapStoredGraded),
            ].sort((a, b) => b.grade - a.grade);
            send({
              type: "graded",
              cached: false,
              graded: merged,
            });
          } catch (e) {
            const error = e instanceof Error ? e.message : "PSA scrape failed";
            console.error(`enrichGraded failed for product ${productId} (${card.name}):`, error);
            send({
              type: "graded",
              cached: false,
              graded: storedGraded.map(mapStoredGraded),
              error,
            });
          }
        }

        send({ type: "done" });
      } catch (e) {
        if (!liquidityOk) {
          send({
            type: "error",
            error: e instanceof Error ? e.message : "enrichment failed",
          });
        } else {
          send({
            type: "graded",
            cached: false,
            graded: [],
            error: e instanceof Error ? e.message : "enrichment failed",
          });
          send({ type: "done" });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isFresh(asOf: string | null | undefined, windowMs: number): boolean {
  if (!asOf) return false;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < windowMs;
}

function mapStoredLiquidity(liq: Liquidity) {
  return {
    score: liq.liquidityScore,
    activeListings: liq.activeListings,
    sellers: liq.sellers,
    weeklyQtySold: liq.totalQtySold90d,
    soldPerDay: liq.soldVelocity,
    bidAskSpreadPct: liq.bidAskSpreadPct,
    buyoutUsd: liq.listingLadder?.buyoutUsd ?? null,
    buyoutQty: liq.listingLadder?.buyoutQty ?? null,
    buyoutPartial: liq.listingLadder?.partial ?? null,
    priceGaps: liq.listingLadder?.gaps ?? [],
  };
}

function mapStoredGraded(g: GradedComp) {
  return {
    grade: g.grade,
    market: g.lastSold,
    median: g.lastSold,
    sampleSize: g.sampleSize,
    gradeMultiple: g.gradeMultiple,
    soldPerDay: g.soldPerDay,
    soldPerMonth: g.soldPerMonth,
  };
}
