import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";
import { scrapeSync } from "../web-data";
import { serpDiscover } from "./discover";
import {
  parseDate,
  pickNumber,
  pickString,
  type FetchOpts,
  type RawSocialPost,
} from "./types";

/**
 * TikTok ingest — discover recent video URLs for the handle via SERP, then pull
 * structured detail from the Bright Data TikTok post dataset. TikTok rarely
 * exposes a transcript, so caption/description drives sentiment here.
 */
export async function fetchTikTok(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  const maxPosts = opts.maxPosts ?? 5;
  const found = await serpDiscover("tiktok.com", entry.handle, { num: 20 });

  const videoUrls = found
    .map((o) => o.link!)
    .filter((u) => /\/video\/\d+/.test(u))
    .slice(0, maxPosts * 2);
  if (videoUrls.length === 0) return [];

  const rows = await scrapeSync("tiktokPost", videoUrls.map((url) => ({ url })));

  const out: RawSocialPost[] = [];
  for (const row of rows) {
    const url = pickString(row, "url", "post_url");
    if (!url) continue;
    out.push({
      platform: "tiktok",
      handle: entry.handle,
      postUrl: url,
      postedAt: parseDate(row["create_time"] ?? row["date_posted"] ?? row["timestamp"]),
      caption: pickString(row, "description", "caption", "title"),
      transcript: pickString(row, "transcript") || null,
      likes: pickNumber(row, "digg_count", "likes", "like_count"),
      views: pickNumber(row, "play_count", "views", "view_count"),
      comments: pickNumber(row, "comment_count", "comments"),
      raw: {},
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}
