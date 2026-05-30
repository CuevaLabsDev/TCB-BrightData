import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";
import { scrapeSync } from "../web-data";
import {
  parseDate,
  pickNumber,
  pickString,
  type FetchOpts,
  type RawSocialPost,
} from "./types";

/**
 * X ingest — the X profile-posts dataset returns recent posts for a profile
 * URL directly (with dates + engagement), optionally bounded by start_date.
 * No separate discovery step needed.
 */
export async function fetchX(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  const maxPosts = opts.maxPosts ?? 5;
  const since = opts.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const startDate = since.toISOString().slice(0, 10);

  const rows = await scrapeSync("xProfilePosts", [
    { url: entry.profileUrl, start_date: startDate, end_date: "" },
  ]);

  const out: RawSocialPost[] = [];
  for (const row of rows) {
    const url = pickString(row, "url", "post_url", "tweet_url");
    if (!url) continue;
    const caption = pickString(row, "description", "text", "tweet_text", "content");
    out.push({
      platform: "x",
      handle: entry.handle,
      postUrl: url,
      postedAt: parseDate(row["date_posted"] ?? row["created_at"] ?? row["timestamp"]),
      caption,
      transcript: null,
      likes: pickNumber(row, "likes", "favorites", "like_count"),
      views: pickNumber(row, "views", "view_count"),
      comments: pickNumber(row, "replies", "reply_count", "comments"),
      raw: { reposts: pickNumber(row, "reposts", "retweets") },
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}
