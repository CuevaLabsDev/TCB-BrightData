/**
 * Curated creator watchlist — the single source of truth for account-based
 * social monitoring. Both the Bright Data scan ([scanWatchlist]) and the
 * Triggerware setup script ([scripts/setup-triggerware.mjs]) read this list.
 *
 * Handles are verified manually before being added. A wrong handle yields the
 * wrong (or empty) account data — e.g. on X the YouTuber PokeRev is
 * `@ThePokeRev`, NOT `@PokeRev` (a different, unrelated account).
 *
 * tier1 = highest-signal movers; polled via Triggerware every 15m for an early
 *         pulse, then scraped in full by Bright Data on delta.
 * tier2 = still monitored, but only by the 4h full watchlist scan.
 */

export type SocialPlatform = "youtube" | "instagram" | "x" | "tiktok" | "reddit";

export interface WatchlistEntry {
  /** Stable slug; used for Triggerware trigger names and dedupe. */
  id: string;
  platform: SocialPlatform;
  /** Display handle: `@name` for socials, `r/sub` for Reddit. */
  handle: string;
  /** Canonical profile / subreddit URL the scrapers resolve against. */
  profileUrl: string;
  tier: "tier1" | "tier2";
  active: boolean;
}

export const WATCHLIST: WatchlistEntry[] = [
  // ── PokeRev (verified across platforms) ──
  {
    id: "youtube-pokerev",
    platform: "youtube",
    handle: "@PokeRev",
    profileUrl: "https://www.youtube.com/@PokeRev",
    tier: "tier1",
    active: true,
  },
  {
    id: "instagram-pokerev",
    platform: "instagram",
    handle: "@pokerev",
    profileUrl: "https://www.instagram.com/pokerev/",
    tier: "tier2",
    active: true,
  },
  {
    id: "x-thepokerev",
    platform: "x",
    handle: "@ThePokeRev",
    profileUrl: "https://x.com/ThePokeRev",
    tier: "tier1",
    active: true,
  },

  // ── Other high-signal market voices ──
  {
    id: "youtube-smpratte",
    platform: "youtube",
    handle: "@smpratte",
    profileUrl: "https://www.youtube.com/@smpratte",
    tier: "tier1",
    active: true,
  },
  {
    id: "youtube-unlistedleaf",
    platform: "youtube",
    handle: "@UnlistedLeaf",
    profileUrl: "https://www.youtube.com/@UnlistedLeaf",
    tier: "tier2",
    active: true,
  },
  {
    id: "youtube-deeppocketmonster",
    platform: "youtube",
    handle: "@DeepPocketMonster",
    profileUrl: "https://www.youtube.com/@DeepPocketMonster",
    tier: "tier2",
    active: true,
  },
  {
    id: "youtube-leonhart",
    platform: "youtube",
    handle: "@Leonhart",
    profileUrl: "https://www.youtube.com/@Leonhart",
    tier: "tier2",
    active: true,
  },

  // ── Reddit communities (stable, high-volume market chatter) ──
  {
    id: "reddit-pokeinvesting",
    platform: "reddit",
    handle: "r/PokeInvesting",
    profileUrl: "https://www.reddit.com/r/PokeInvesting",
    tier: "tier1",
    active: true,
  },
  {
    id: "reddit-pokemontcg",
    platform: "reddit",
    handle: "r/PokemonTCG",
    profileUrl: "https://www.reddit.com/r/PokemonTCG",
    tier: "tier2",
    active: true,
  },
];

export function activeWatchlist(): WatchlistEntry[] {
  return WATCHLIST.filter((e) => e.active);
}

export function tier1Watchlist(): WatchlistEntry[] {
  return WATCHLIST.filter((e) => e.active && e.tier === "tier1");
}

/** Normalize a handle for comparison (strip @, lowercase). */
export function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase();
}

/** Find a watchlist entry by handle (and optional platform). */
export function findByHandle(
  handle: string,
  platform?: SocialPlatform,
): WatchlistEntry | undefined {
  const norm = normalizeHandle(handle);
  return WATCHLIST.find(
    (e) =>
      normalizeHandle(e.handle) === norm &&
      (platform ? e.platform === platform : true),
  );
}
