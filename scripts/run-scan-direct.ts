// Run scanWatchlist directly (no Next.js route timeout). Usage:
//   npx tsx scripts/run-scan-direct.ts
//   npx tsx scripts/run-scan-direct.ts @PokeRev youtube
import { readFileSync } from "node:fs";
import { scanWatchlist, correlateCreatorImpact } from "../src/lib/bright-data/social";
import { appendMarketMemoryBatch } from "../src/lib/memory/incremental";
import type { SocialPlatform } from "../src/lib/social/watchlist";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim();
}

async function main() {
  const handleArg = process.argv[2];
  const platformArg = process.argv[3] as SocialPlatform | undefined;

  const scan = await scanWatchlist({
    handles: handleArg ? [handleArg] : undefined,
    platforms: platformArg ? [platformArg] : undefined,
    maxPostsPerCreator: handleArg ? 3 : 5,
  });

  console.log("[direct]", {
    scanned: scan.scanned,
    fetched: scan.fetched,
    newPosts: scan.newPosts,
    records: scan.records.map((r) => ({
      handle: r.handle,
      platform: r.platform,
      contentSource: r.contentSource,
      summary: r.signal.summary,
    })),
  });

  const memories = await appendMarketMemoryBatch(scan.records);
  await correlateCreatorImpact();
  console.log("[direct] memoriesWritten:", memories, "done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
