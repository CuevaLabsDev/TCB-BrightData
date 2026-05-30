import "server-only";
import type { WatchlistEntry } from "@/lib/social/watchlist";

/**
 * Triggerware REST client. Triggers are named scheduled queries that accumulate
 * row-level deltas; polling consumes and clears them. We use them as a cheap
 * tier1 "pulse" — when a delta appears, the 15m cron triggers a full Bright Data
 * scrape of that one creator instead of scraping the whole watchlist.
 *
 * API: https://api.triggerware.com  (header `Api-Key`)
 *   GET    /triggers
 *   POST   /triggers                (natural-language create)
 *   POST   /triggers/{name}/poll    -> { added: [[...]], deleted: [[...]] }
 *   PATCH  /triggers/{name}
 *   DELETE /triggers/{name}
 *
 * Poll rows are positional arrays (no column names), so the column order must be
 * pinned out-of-band via TRIGGERWARE_ROW_COLUMNS.
 */

function apiBase(): string {
  return (process.env.TRIGGERWARE_API_URL || "https://api.triggerware.com").replace(/\/$/, "");
}

export function triggerwareApiKey(): string | undefined {
  return process.env.TRIGGERWARE_API_KEY || process.env.triggerwareai_api_key;
}

export function hasTriggerware(): boolean {
  return Boolean(triggerwareApiKey());
}

export function triggerPrefix(): string {
  return process.env.TRIGGERWARE_TRIGGER_PREFIX || "tcb_tier1_";
}

/** Deterministic, charset-safe trigger name for a watchlist entry. */
export function triggerName(entry: WatchlistEntry): string {
  return `${triggerPrefix()}${entry.id}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Column order of poll rows; pin to the SQL the trigger was created with. */
export function rowColumns(): string[] {
  return (process.env.TRIGGERWARE_ROW_COLUMNS || "post_url,posted_at,caption")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const key = triggerwareApiKey();
  if (!key) throw new Error("Triggerware API key is not configured");
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      "Api-Key": key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Triggerware ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export interface Trigger {
  name: string;
  query: string;
  schedule: number;
  status: string;
  delivery: unknown;
  created_at?: string;
}

export interface PollResult {
  added: string[][];
  deleted: string[][];
}

export function listTriggers(): Promise<Trigger[]> {
  return request<Trigger[]>("GET", "/triggers");
}

export function createTrigger(payload: Record<string, unknown>): Promise<Trigger> {
  return request<Trigger>("POST", "/triggers", payload);
}

export function patchTrigger(name: string, payload: Record<string, unknown>): Promise<Trigger> {
  return request<Trigger>("PATCH", `/triggers/${encodeURIComponent(name)}`, payload);
}

export function deleteTrigger(name: string): Promise<unknown> {
  return request("DELETE", `/triggers/${encodeURIComponent(name)}`);
}

export async function pollTrigger(name: string): Promise<PollResult> {
  const res = await request<Partial<PollResult>>("POST", `/triggers/${encodeURIComponent(name)}/poll`);
  return { added: res.added ?? [], deleted: res.deleted ?? [] };
}

/** Map a positional poll row to a keyed object using the pinned column order. */
export function mapRow(row: string[]): Record<string, string> {
  const cols = rowColumns();
  const obj: Record<string, string> = {};
  cols.forEach((c, i) => {
    obj[c] = row[i] ?? "";
  });
  return obj;
}
