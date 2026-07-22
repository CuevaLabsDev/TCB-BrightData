import { getCard, getGradedComps, getLiquidity } from "@/lib/queries";
import { hasBrightData } from "@/lib/bright-data/client";
import { enrichGraded, enrichLiquidity } from "@/lib/bright-data/enrich";
import { rateLimit } from "@/lib/rate-limit";
import type { GradedComp, Liquidity } from "@/lib/types";

export const maxDuration = 120;

const ENRICH_LIMIT = 8;
const ENRICH_WINDOW_MS = 10 * 60 * 1000;
const FRESH_MS = 60 * 60 * 1000;

/**
 * POST /api/enrich
 * body: { productId: number, subType?: string, graded?: boolean, force?: boolean }
 *
 * Streams NDJSON events so the UI can paint liquidity before graded comps finish:
 *   { type: "liquidity", cached?, card, liquidity }
 *   { type: "graded", cached?, graded }
 *   { type: "done" }
 *   { type: "error", error }
 *
 * When force is false (default) and warehouse as_of is within 1h, that half skips
 * Unlocker and emits a cached snapshot. Refresh live always sends force: true.
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
  const wantGraded = body.graded !== false;
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
        const liqFresh = !force && isFresh(liqRow?.asOf);
        const gradedFresh =
          !force &&
          wantGraded &&
          storedGraded.length > 0 &&
          storedGraded.every((g) => isFresh(g.asOf));

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
          send({ type: "graded", cached: true, graded: [] });
        } else if (gradedFresh) {
          send({
            type: "graded",
            cached: true,
            graded: storedGraded.map(mapStoredGraded),
          });
        } else {
          tasks.push(
            enrichGraded(card).then((graded) => {
              send({
                type: "graded",
                cached: false,
                graded: graded.map((g) => ({
                  grade: g.grade,
                  median: g.scan.median,
                  sampleSize: g.scan.count,
                  gradeMultiple: g.gradeMultiple,
                })),
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

function isFresh(asOf: string | null | undefined): boolean {
  if (!asOf) return false;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < FRESH_MS;
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
