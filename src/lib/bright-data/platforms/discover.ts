import "server-only";
import { serpSearch, type SerpOrganic } from "../client";
import { normalizeHandle } from "@/lib/social/watchlist";

/**
 * Discover recent post URLs for a specific creator via Bright Data SERP scoped
 * to the platform host + handle. This keeps discovery ACCOUNT-scoped (only that
 * creator's content surfaces) while leaving full-content + transcript pulls to
 * the Web Data datasets. Each scraped item is later re-verified against the
 * watched handle so a reaction/duplicate by another account is dropped.
 */
export async function serpDiscover(
  host: string,
  handle: string,
  opts: { extra?: string; num?: number } = {},
): Promise<SerpOrganic[]> {
  const term = normalizeHandle(handle);
  const extra = opts.extra ?? "pokemon cards";
  const { organic } = await serpSearch(`site:${host} ${term} ${extra}`, {
    num: opts.num ?? 20,
  });
  return organic.filter((o) => o.link && o.link.includes(host));
}

/** True if a scraped row's channel/author handle matches the watched handle. */
export function handleMatches(watched: string, candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const w = normalizeHandle(watched);
  const c = normalizeHandle(candidate);
  return c === w || c.includes(w) || w.includes(c);
}
