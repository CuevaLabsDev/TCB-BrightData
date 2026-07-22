import { getCard, getGradedComps, getLiquidity } from "@/lib/queries";
import { hasBrightData } from "@/lib/bright-data/client";
import { enrichGraded, enrichLiquidity } from "@/lib/bright-data/enrich";
import { rateLimit } from "@/lib/rate-limit";
import type { GradedComp, Liquidity } from "@/lib/types";

export const maxDuration = 120;

const ENRICH_LIMIT = 8;
const ENRICH_WINDOW_MS = 10 * 60 * 1000;
/** Liquidity moves fast — short TTL when force is false. */
const LIQUIDITY_FRESH_MS = 60 * 60 * 1000;
/**
 * Graded multiples move slowly. Even on a forced live refresh we reuse warehouse
 * PSA comps inside this window so the button isn't blocked on eBay HTML.
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
 *   { type: "graded", cached?, graded }
 *   { type: "done" }
 *   { type: "error", error }
 *
 * Live refresh sends force:true + forceGraded:false so liquidity is always
 * fresh while graded uses the 6h warehouse cache (or a single PSA-10 Unlocker
 * call when stale). Dual parallel eBay Unlocker calls contend on the zone.
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

      try {
        const [storedLiq, storedGraded] = await Promise.all([
          getLiquidity(productId),
          wantGraded ? getGradedComps(productId) : Promise.resolve([] as GradedComp[]),
        ]);

        const liqRow =
          storedLiq.find((l) => l.subType === card.subType && l.source === "tcgplayer") ??
          storedLiq.find((l) => l.subType === card.subType) ??
          storedLiq[0];
        const liqFresh = !force && isFresh(liqRow?.asOf, LIQUIDITY_FRESH_MS);

        // Prefer warehouse graded unless forceGraded. Require a fresh PSA-10
        // (or whatever the highest requested grade is) inside GRADED_FRESH_MS.
        const primaryGrade = Math.max(...grades);
        const primaryStored = storedGraded.find((g) => g.grade === primaryGrade);
        const gradedFresh =
          !forceGraded &&
          wantGraded &&
          isFresh(primaryStored?.asOf, GRADED_FRESH_MS);

        const tasks: Promise<void>[] = [];

        if (liqFresh && liqRow) {
          send({
            type: "liquidity",
            cached: true,
            card: cardPayload,
            liquidity: mapStoredLiquidity(liqRow),
          });
        } else {
          tasks.push(
            enrichLiquidity(card).then((liquidity) => {
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
                },
              });
            }),
          );
        }

        if (!wantGraded) {
          // Sealed: clear any prior bogus PSA rows, then return empty.
          if (card.isSealed) {
            await enrichGraded(card, []);
          }
          send({ type: "graded", cached: true, graded: [] });
        } else if (gradedFresh) {
          // Return all stored grades we have (9+10) so the UI stays rich even
          // when live only refreshes PSA-10 on a miss.
          send({
            type: "graded",
            cached: true,
            graded: storedGraded.map(mapStoredGraded),
          });
        } else {
          tasks.push(
            enrichGraded(card, grades).then((graded) => {
              // Merge live rows with any still-fresh warehouse grades we didn't
              // re-scrape (e.g. live PSA-10 + cached PSA-9).
              const liveGrades = new Set(graded.map((g) => g.grade));
              const merged = [
                ...graded.map((g) => ({
                  grade: g.grade,
                  median: g.scan.median,
                  sampleSize: g.scan.count,
                  gradeMultiple: g.gradeMultiple,
                })),
                ...storedGraded
                  .filter((g) => !liveGrades.has(g.grade))
                  .map(mapStoredGraded),
              ].sort((a, b) => b.grade - a.grade);
              send({
                type: "graded",
                cached: false,
                graded: merged,
              });
            }),
          );
        }

        await Promise.all(tasks);
        send({ type: "done" });
      } catch (e) {
        send({
          type: "error",
          error: e instanceof Error ? e.message : "enrichment failed",
        });
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
    sellers: null as number | null,
    weeklyQtySold: liq.totalQtySold90d,
    soldPerDay: liq.soldVelocity,
    bidAskSpreadPct: liq.bidAskSpreadPct,
  };
}

function mapStoredGraded(g: GradedComp) {
  return {
    grade: g.grade,
    median: g.lastSold,
    sampleSize: g.sampleSize,
    gradeMultiple: g.gradeMultiple,
  };
}
