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
 * Instagram ingest — discover recent post/reel URLs for the handle via SERP,
 * then pull structured detail (caption, engagement, date) from the matching
 * Bright Data dataset (reels vs feed posts).
 */
export async function fetchInstagram(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  const maxPosts = opts.maxPosts ?? 5;
  const found = await serpDiscover("instagram.com", entry.handle, { num: 20 });

  const reelUrls: string[] = [];
  const postUrls: string[] = [];
  for (const o of found) {
    const u = o.link!;
    if (/\/reel(s)?\//.test(u)) reelUrls.push(u);
    else if (/\/p\//.test(u)) postUrls.push(u);
    if (reelUrls.length + postUrls.length >= maxPosts * 2) break;
  }

  const [reels, posts] = await Promise.all([
    reelUrls.length ? scrapeSync("instagramReel", reelUrls.map((url) => ({ url }))) : [],
    postUrls.length ? scrapeSync("instagramPost", postUrls.map((url) => ({ url }))) : [],
  ]);

  const out: RawSocialPost[] = [];
  for (const row of [...reels, ...posts]) {
    const url = pickString(row, "url", "post_url");
    if (!url) continue;
    out.push({
      platform: "instagram",
      handle: entry.handle,
      postUrl: url,
      postedAt: parseDate(row["date_posted"] ?? row["timestamp"]),
      caption: pickString(row, "caption", "description", "title"),
      transcript: null,
      likes: pickNumber(row, "likes", "num_likes", "like_count"),
      views: pickNumber(row, "views", "video_view_count", "play_count"),
      comments: pickNumber(row, "num_comments", "comments", "comment_count"),
      raw: {},
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}
