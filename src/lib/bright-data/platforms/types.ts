/**
 * Normalized shape every platform fetcher returns, regardless of the wildly
 * different field names Bright Data uses per network. `transcript` carries
 * spoken video audio when the source provides it (YouTube), enabling sentiment
 * over what creators actually *say*, not just captions.
 */
export interface RawSocialPost {
  platform: string;
  handle: string;
  postUrl: string;
  postedAt: Date | null;
  caption: string;
  transcript: string | null;
  likes: number | null;
  views: number | null;
  comments: number | null;
  raw: Record<string, unknown>;
}

export interface FetchOpts {
  /** Max posts to return per creator per run (credit control). */
  maxPosts?: number;
  /** Only consider posts newer than this (best-effort; sources vary). */
  since?: Date;
}

/** Read the first present, non-empty field from a row by candidate keys. */
export function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  const v = pick(row, ...keys);
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

export function pickNumber(row: Record<string, unknown>, ...keys: string[]): number | null {
  const v = pick(row, ...keys);
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Parse assorted date encodings (ISO string, epoch seconds, epoch ms). */
export function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value; // seconds vs ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseDate(Number(s));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
