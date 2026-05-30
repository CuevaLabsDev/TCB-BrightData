import "server-only";

/**
 * Bright Data Web Data scrapers — structured, cache-backed extraction of social
 * post/profile data (the same product family behind the Bright Data MCP
 * `web_data_*` tools, called here over plain HTTPS for the deployed app).
 *
 *   Sync:   POST /datasets/v3/scrape?dataset_id={id}&format=json   body: [{url}]
 *   Async:  POST /datasets/v3/trigger ... -> snapshot_id -> poll /progress -> /snapshot
 *
 * Dataset IDs are GLOBAL Bright Data product identifiers (`gd_*`), shared across
 * accounts — access is gated by the API key. Override any of them per-env if
 * Bright Data reassigns an ID (CP -> Web Scrapers -> dataset -> overview).
 *
 * The key feature this unlocks: the YouTube video dataset returns a full
 * `transcript` (spoken audio), so video content feeds sentiment with no
 * separate speech-to-text service.
 */

const DATASET_API = "https://api.brightdata.com/datasets/v3";

export const DATASETS = {
  youtubeVideo: process.env.BRIGHT_DATA_DATASET_YOUTUBE_VIDEO || "gd_lk56epmy2i5g7lzu0k",
  youtubeProfile: process.env.BRIGHT_DATA_DATASET_YOUTUBE_PROFILE || "gd_lk538t2k2p1k3oos71",
  xProfilePosts: process.env.BRIGHT_DATA_DATASET_X_PROFILE_POSTS || "gd_lwxmeb2u1cniijd7t4",
  instagramProfile: process.env.BRIGHT_DATA_DATASET_INSTAGRAM_PROFILE || "gd_l1vikfch901nx3by4",
  instagramReel: process.env.BRIGHT_DATA_DATASET_INSTAGRAM_REEL || "gd_lyclm20il4r5helnj",
  instagramPost: process.env.BRIGHT_DATA_DATASET_INSTAGRAM_POST || "gd_lk5ns7kz21pck8jpis",
  tiktokProfile: process.env.BRIGHT_DATA_DATASET_TIKTOK_PROFILE || "gd_l1villgoiiidt09ci",
  tiktokPost: process.env.BRIGHT_DATA_DATASET_TIKTOK_POST || "gd_lu702nij2f790tmv9h",
} as const;

export type DatasetKey = keyof typeof DATASETS;

function apiKey(): string {
  const key = process.env.BRIGHT_DATA_API_KEY;
  if (!key) throw new Error("BRIGHT_DATA_API_KEY is not configured");
  return key;
}

export function hasWebData(): boolean {
  return Boolean(process.env.BRIGHT_DATA_API_KEY);
}

type ScrapeInput = Record<string, unknown>;

/**
 * Synchronous scrape — blocks until Bright Data returns structured rows. Best
 * for a known set of detail URLs (1+ items). Returns the parsed array, or []
 * on any failure (callers degrade gracefully, matching the rest of the
 * Bright Data layer).
 */
export async function scrapeSync<T = Record<string, unknown>>(
  dataset: DatasetKey,
  inputs: ScrapeInput[],
  opts: { timeoutMs?: number } = {},
): Promise<T[]> {
  if (inputs.length === 0) return [];
  const url = `${DATASET_API}/scrape?dataset_id=${DATASETS[dataset]}&format=json`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      console.error(`[web-data] ${dataset} scrape ${res.status}`);
      return [];
    }
    return parseRows<T>(await res.text());
  } catch (err) {
    console.error(`[web-data] ${dataset} scrape failed:`, err);
    return [];
  }
}

/**
 * Asynchronous discovery — trigger a collection (optionally by a discovery
 * method such as a profile URL), poll progress, then download the snapshot.
 * Used for "list the recent posts on this profile" where a single URL fans out
 * to many rows.
 */
export async function triggerAndCollect<T = Record<string, unknown>>(
  dataset: DatasetKey,
  inputs: ScrapeInput[],
  opts: { discoverBy?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<T[]> {
  if (inputs.length === 0) return [];
  const params = new URLSearchParams({
    dataset_id: DATASETS[dataset],
    format: "json",
    include_errors: "true",
  });
  if (opts.discoverBy) {
    params.set("type", "discover_new");
    params.set("discover_by", opts.discoverBy);
  }
  const key = apiKey();
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);

  try {
    const trigRes = await fetch(`${DATASET_API}/trigger?${params}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(30_000),
    });
    if (!trigRes.ok) {
      console.error(`[web-data] ${dataset} trigger ${trigRes.status}`);
      return [];
    }
    const snapshotId = ((await trigRes.json()) as { snapshot_id?: string }).snapshot_id;
    if (!snapshotId) return [];

    while (Date.now() < deadline) {
      await sleep(opts.pollMs ?? 5_000);
      const progRes = await fetch(`${DATASET_API}/progress/${snapshotId}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!progRes.ok) continue;
      const status = ((await progRes.json()) as { status?: string }).status;
      if (status === "ready") break;
      if (status === "failed") return [];
    }

    const snapRes = await fetch(`${DATASET_API}/snapshot/${snapshotId}?format=json`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!snapRes.ok) return [];
    return parseRows<T>(await snapRes.text());
  } catch (err) {
    console.error(`[web-data] ${dataset} discover failed:`, err);
    return [];
  }
}

function parseRows<T>(text: string): T[] {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data as T[];
    // NDJSON fallback (some delivery formats stream one object per line).
    if (typeof data === "object" && data !== null) return [data as T];
    return [];
  } catch {
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t) as T);
      } catch {
        /* skip */
      }
    }
    return rows;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
