import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";
import { fetchYouTube } from "./youtube";
import { fetchX } from "./x";
import { fetchInstagram } from "./instagram";
import { fetchTikTok } from "./tiktok";
import { fetchReddit } from "./reddit";
import type { FetchOpts, RawSocialPost } from "./types";

export type { RawSocialPost, FetchOpts } from "./types";

/** Dispatch a watchlist entry to its platform fetcher. Always degrades to []. */
export async function fetchCreatorPosts(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  try {
    switch (entry.platform) {
      case "youtube":
        return await fetchYouTube(entry, opts);
      case "x":
        return await fetchX(entry, opts);
      case "instagram":
        return await fetchInstagram(entry, opts);
      case "tiktok":
        return await fetchTikTok(entry, opts);
      case "reddit":
        return await fetchReddit(entry, opts);
      default:
        return [];
    }
  } catch (err) {
    console.error(`[platforms] ${entry.platform}/${entry.handle} fetch failed:`, err);
    return [];
  }
}
