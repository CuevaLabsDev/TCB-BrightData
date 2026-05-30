import { NextResponse } from "next/server";
import { getCard } from "@/lib/queries";
import { hasBrightData } from "@/lib/bright-data/client";
import { enrichGraded, enrichLiquidity } from "@/lib/bright-data/enrich";

export const maxDuration = 120;

/**
 * POST /api/enrich
 * body: { productId: number, subType?: string, graded?: boolean }
 *
 * Runs a live Bright Data enrichment pass for one card (TCGplayer liquidity +
 * optional eBay PSA graded comps) and persists to Supabase. Used by the card
 * page "Refresh live" action, the seed script, and the cron watcher.
 */
export async function POST(req: Request) {
  if (!hasBrightData()) {
    return NextResponse.json(
      { error: "BRIGHT_DATA_API_KEY not configured" },
      { status: 503 },
    );
  }

  let body: { productId?: number; subType?: string; graded?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const productId = Number(body.productId);
  if (!Number.isFinite(productId)) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const card = await getCard(productId, body.subType);
  if (!card) {
    return NextResponse.json({ error: "card not found" }, { status: 404 });
  }

  try {
    const liquidity = await enrichLiquidity(card);
    const graded = body.graded === false ? [] : await enrichGraded(card);
    return NextResponse.json({
      card: { productId: card.productId, name: card.name, subType: card.subType },
      liquidity: {
        score: liquidity.score,
        activeListings: liquidity.activeListings,
        sellers: liquidity.sellers,
        weeklyQtySold: liquidity.weeklyQtySold,
        soldPerDay: liquidity.soldPerDay,
        bidAskSpreadPct: liquidity.bidAskSpreadPct,
      },
      graded: graded.map((g) => ({
        grade: g.grade,
        median: g.scan.median,
        sampleSize: g.scan.count,
        gradeMultiple: g.gradeMultiple,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "enrichment failed" },
      { status: 500 },
    );
  }
}
