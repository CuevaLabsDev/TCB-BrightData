import { NextResponse } from "next/server";
import { runWatcher } from "@/lib/watcher";

export const maxDuration = 300;

/**
 * Vercel Cron entrypoint for the live trigger engine.
 * Configured in vercel.ts to run on a schedule. Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; we verify it when set.
 *
 * Query: ?discover=1 to also run a fresh Bright Data creator scan (costs credits).
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
  const discover = new URL(req.url).searchParams.get("discover") === "1";
  try {
    const result = await runWatcher({ discover });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "watcher failed" },
      { status: 500 },
    );
  }
}

// Allow manual POST trigger from the UI (same logic).
export async function POST(req: Request) {
  return GET(req);
}
