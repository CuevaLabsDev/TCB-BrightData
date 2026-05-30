import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hasBrightData } from "@/lib/bright-data/client";
import { scanWatchlist, correlateCreatorImpact } from "@/lib/bright-data/social";
import { appendMarketMemoryBatch } from "@/lib/memory/incremental";
import { runWatcher } from "@/lib/watcher";
import { tier1Watchlist } from "@/lib/social/watchlist";
import { hasTriggerware, pollTrigger, triggerName } from "@/lib/triggerware/client";

export const maxDuration = 300;

/**
 * Tier1 pulse — every 15m (see vercel.json). Polls one Triggerware trigger per
 * tier1 creator; any creator with a fresh delta gets a targeted Bright Data
 * scrape (NOT the whole watchlist), keeping the pulse cheap. New posts feed
 * incremental memory + the signal pass. The 4h /api/cron/social is the backstop.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasTriggerware()) {
    return NextResponse.json({ ok: false, error: "Triggerware not configured" }, { status: 503 });
  }

  const entries = tier1Watchlist();
  const deltaHandles = new Set<string>();
  let polled = 0;
  let deltas = 0;

  for (const entry of entries) {
    try {
      const res = await pollTrigger(triggerName(entry));
      polled++;
      if (res.added.length > 0) {
        deltas += res.added.length;
        deltaHandles.add(entry.handle);
      }
    } catch {
      // Trigger may not exist yet (run scripts/setup-triggerware.mjs) — skip.
    }
  }

  let newPosts = 0;
  let memoriesWritten = 0;
  let signalsCreated = 0;

  if (deltaHandles.size > 0 && hasBrightData()) {
    const scan = await scanWatchlist({
      handles: [...deltaHandles],
      maxPostsPerCreator: 5,
    });
    newPosts = scan.newPosts;
    memoriesWritten = await appendMarketMemoryBatch(scan.records);
    await correlateCreatorImpact();
    const watch = await runWatcher({ discover: false });
    signalsCreated = watch.signalsCreated;
  }

  try {
    await sql`
      insert into ingest_runs (kind, finished_at, status, rows, detail)
      values ('triggerware', now(), 'ok', ${newPosts},
              ${sql.json({
                polled,
                deltas,
                deltaHandles: [...deltaHandles],
                newPosts,
                memoriesWritten,
                signalsCreated,
              } as never)})
    `;
  } catch {
    /* bookkeeping only */
  }

  return NextResponse.json({
    ok: true,
    polled,
    deltas,
    deltaHandles: [...deltaHandles],
    newPosts,
    memoriesWritten,
    signalsCreated,
  });
}

export async function POST(req: Request) {
  return GET(req);
}
