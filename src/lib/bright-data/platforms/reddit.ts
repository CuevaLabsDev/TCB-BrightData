import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";
import { unlockJson } from "../client";
import { parseDate, type FetchOpts, type RawSocialPost } from "./types";

interface RedditListing {
  data?: {
    children?: { data?: Record<string, unknown> }[];
  };
}

/**
 * Reddit ingest — there is no dedicated subreddit dataset, so we read the
 * public `/new.json` feed through the Web Unlocker (bypasses Reddit's bot
 * wall). Each post becomes a RawSocialPost attributed to the subreddit handle.
 */
export async function fetchReddit(
  entry: WatchlistEntry,
  opts: FetchOpts = {},
): Promise<RawSocialPost[]> {
  const maxPosts = opts.maxPosts ?? 8;
  const base = entry.profileUrl.replace(/\/$/, "");
  const listing = await unlockJson<RedditListing>(`${base}/new.json?limit=25`);
  const children = listing?.data?.children ?? [];

  const out: RawSocialPost[] = [];
  for (const child of children) {
    const d = child.data;
    if (!d) continue;
    const permalink = typeof d.permalink === "string" ? d.permalink : null;
    if (!permalink) continue;
    const title = typeof d.title === "string" ? d.title : "";
    const selftext = typeof d.selftext === "string" ? d.selftext : "";
    out.push({
      platform: "reddit",
      handle: entry.handle,
      postUrl: `https://www.reddit.com${permalink}`,
      postedAt: parseDate(d.created_utc),
      caption: selftext ? `${title}\n${selftext}` : title,
      transcript: null,
      likes: typeof d.ups === "number" ? d.ups : null,
      views: null,
      comments: typeof d.num_comments === "number" ? d.num_comments : null,
      raw: { author: typeof d.author === "string" ? d.author : null },
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}
