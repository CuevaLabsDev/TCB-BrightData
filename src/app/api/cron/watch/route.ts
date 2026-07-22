import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { runWatcher } from "@/lib/watcher";

export const maxDuration = 300;

/**
 * Vercel Cron entrypoint for the live trigger engine.
 * Configured in vercel.json to run on a schedule. Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; fail-closed in production if unset.
 *
 * Query: ?discover=1 to also run a fresh Bright Data creator scan (costs credits).
 */
export async function GET(req: Request) {
  if (!authorizeCron(req)) {
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
