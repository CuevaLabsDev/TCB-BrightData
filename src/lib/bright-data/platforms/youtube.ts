import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";
import { scrapeSync } from "../web-data";
import { serpDiscover, handleMatches } from "./discover";
import {
  parseDate,
  pickNumber,
  pickString,
  type FetchOpts,
  type RawSocialPost,
} from "./types";

/**
 * YouTube ingest — discover recent videos for the channel via SERP, then pull
 * each video's structured data (including the full spoken `transcript`) from
 * the Bright Data YouTube video dataset. Videos whose channel does not match
 * the watched handle are dropped so only this creator's content is kept.
 */
export async function fetchYouTube(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  const maxPosts = opts.maxPosts ?? 5;
  const found = await serpDiscover("youtube.com", entry.handle, {
    extra: "pokemon cards",
    num: 20,
  });

  const watchUrls = found
    .map((o) => o.link!)
    .filter((u) => /youtube\.com\/watch\?v=|youtu\.be\//.test(u))
    .slice(0, maxPosts * 2);
  if (watchUrls.length === 0) return [];

  const rows = await scrapeSync(
    "youtubeVideo",
    watchUrls.map((url) => ({ url })),
  );

  const out: RawSocialPost[] = [];
  for (const row of rows) {
    const channelHandle =
      pickString(row, "handle_name", "youtuber") ||
      pickString(row, "channel_url").match(/@([^/?]+)/)?.[1] ||
      "";
    if (channelHandle && !handleMatches(entry.handle, channelHandle)) continue;

    const transcript = pickString(row, "transcript") || null;
    const caption =
      pickString(row, "title") +
      (pickString(row, "description") ? `\n${pickString(row, "description")}` : "");
    const url = pickString(row, "url", "video_url");
    if (!url) continue;

    out.push({
      platform: "youtube",
      handle: entry.handle,
      postUrl: url,
      postedAt: parseDate(row["date_posted"] ?? row["datePublished"]),
      caption,
      transcript,
      likes: pickNumber(row, "likes"),
      views: pickNumber(row, "views"),
      comments: pickNumber(row, "num_comments", "comments"),
      raw: { videoId: pickString(row, "video_id"), channelHandle },
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}
