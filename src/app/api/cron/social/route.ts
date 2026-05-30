import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hasBrightData } from "@/lib/bright-data/client";
import { scanWatchlist, correlateCreatorImpact } from "@/lib/bright-data/social";
import { appendMarketMemoryBatch } from "@/lib/memory/incremental";
import { runWatcher } from "@/lib/watcher";

export const maxDuration = 300;

/**
 * Full watchlist scan — every 4h (see vercel.json). Account-scoped Bright Data
 * pulls for ALL active watchlist creators (the backstop behind the tier1
 * Triggerware pulse), then impact correlation, incremental memory, and a signal
 * pass. Vercel sends `Authorization: Bearer $CRON_SECRET`; verified when set.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unprotected if no secret configured (local/dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasBrightData()) {
    return NextResponse.json({ ok: false, error: "Bright Data not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const handles = searchParams.get("handles")?.split(",").map((h) => h.trim()).filter(Boolean);
  const platforms = searchParams
    .get("platforms")
    ?.split(",")
    .map((p) => p.trim())
    .filter(Boolean) as import("@/lib/social/watchlist").SocialPlatform[] | undefined;

  try {
    const scan = await scanWatchlist({
      handles: handles?.length ? handles : undefined,
      platforms: platforms?.length ? platforms : undefined,
      ...(handles?.length ? { maxPostsPerCreator: 3 } : {}),
    });
    const memoriesWritten = await appendMarketMemoryBatch(scan.records);
    await correlateCreatorImpact();
    const watch = await runWatcher({ discover: false });

    await sql`
      insert into ingest_runs (kind, finished_at, status, rows, detail)
      values ('social', now(), 'ok', ${scan.newPosts},
              ${sql.json({
                scanned: scan.scanned,
                fetched: scan.fetched,
                newPosts: scan.newPosts,
                memoriesWritten,
                signalsCreated: watch.signalsCreated,
              } as never)})
    `;

    return NextResponse.json({
      ok: true,
      scanned: scan.scanned,
      fetched: scan.fetched,
      newPosts: scan.newPosts,
      memoriesWritten,
      signalsCreated: watch.signalsCreated,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "social scan failed" },
      { status: 500 },
    );
  }
}

// Allow manual POST trigger from the UI (same logic).
export async function POST(req: Request) {
  return GET(req);
}
