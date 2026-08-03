import "server-only";

/**
 * Bright Data Web Unlocker — asynchronous submit + poll.
 *
 * Requires a dedicated Unlocker zone with "Asynchronous requests" enabled
 * (zones are sync XOR async). Set BRIGHT_DATA_UNLOCKER_ASYNC_ZONE.
 *
 * API:
 *   POST /unblocker/req?zone=...  → { response_id }
 *   GET  /unblocker/get_result?response_id=... → 202 pending | 200 body
 */

const ASYNC_SUBMIT = "https://api.brightdata.com/unblocker/req";
const ASYNC_RESULT = "https://api.brightdata.com/unblocker/get_result";

export function asyncUnlockerZone(): string | null {
  const z = process.env.BRIGHT_DATA_UNLOCKER_ASYNC_ZONE?.trim();
  return z || null;
}

export function hasAsyncUnlocker(): boolean {
  return Boolean(process.env.BRIGHT_DATA_API_KEY && asyncUnlockerZone());
}

export interface AsyncUnlockerSubmitOpts {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  format?: "raw" | "json";
  country?: string;
  zone?: string;
}

export async function submitAsyncUnlocker(
  url: string,
  opts: AsyncUnlockerSubmitOpts = {},
): Promise<string> {
  const apiKey = process.env.BRIGHT_DATA_API_KEY;
  if (!apiKey) throw new Error("BRIGHT_DATA_API_KEY is not configured");
  const zone = opts.zone ?? asyncUnlockerZone();
  if (!zone) throw new Error("BRIGHT_DATA_UNLOCKER_ASYNC_ZONE is not configured");

  const payload: Record<string, unknown> = {
    url,
    format: opts.format ?? "raw",
  };
  if (opts.method) payload.method = opts.method;
  if (opts.body) payload.body = opts.body;
  if (opts.headers) payload.headers = opts.headers;
  if (opts.country) payload.country = opts.country;

  const res = await fetch(`${ASYNC_SUBMIT}?zone=${encodeURIComponent(zone)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Async Unlocker submit failed (${res.status}): ${text.slice(0, 300)}`);
  }

  // response_id may be in JSON body or x-response-id header
  const headerId = res.headers.get("x-response-id")?.trim();
  if (headerId) return headerId;
  try {
    const j = JSON.parse(text) as { response_id?: string };
    if (j.response_id) return j.response_id;
  } catch {
    /* fall through */
  }
  throw new Error(`Async Unlocker submit missing response_id: ${text.slice(0, 200)}`);
}

export type AsyncPollStatus =
  | { status: "pending" }
  | { status: "ready"; body: string }
  | { status: "error"; error: string };

/** Single poll — does not loop. Returns pending on HTTP 202. */
export async function pollAsyncUnlocker(responseId: string): Promise<AsyncPollStatus> {
  const apiKey = process.env.BRIGHT_DATA_API_KEY;
  if (!apiKey) throw new Error("BRIGHT_DATA_API_KEY is not configured");

  const res = await fetch(
    `${ASYNC_RESULT}?response_id=${encodeURIComponent(responseId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (res.status === 202) return { status: "pending" };

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { status: "error", error: `get_result ${res.status}: ${text.slice(0, 200)}` };
  }

  // Result may be wrapped { status_code, body, headers } or raw body string.
  try {
    const j = JSON.parse(text) as {
      status_code?: number;
      body?: string;
      headers?: Record<string, string>;
    };
    if (typeof j.body === "string") {
      const brdError = j.headers?.["x-brd-error"] ?? j.headers?.["x-brd-error-code"];
      if (brdError || (j.status_code && j.status_code >= 400)) {
        return {
          status: "error",
          error: `upstream ${j.status_code ?? "?"}: ${brdError ?? text.slice(0, 200)}`,
        };
      }
      return { status: "ready", body: j.body };
    }
  } catch {
    /* raw body */
  }

  if (!text.trim()) {
    return { status: "error", error: "empty async result body" };
  }
  return { status: "ready", body: text };
}

/**
 * Poll until ready or timeout. Backoff: 20s, 10s, then 5s (BD recommendation).
 */
export async function awaitAsyncUnlocker(
  responseId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  let attempt = 0;

  while (Date.now() - started < timeoutMs) {
    const waitMs = attempt === 0 ? 20_000 : attempt === 1 ? 10_000 : 5_000;
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;

    const result = await pollAsyncUnlocker(responseId);
    if (result.status === "ready") return result.body;
    if (result.status === "error") throw new Error(result.error);
  }

  throw new Error(`Async Unlocker timed out after ${timeoutMs}ms (${responseId})`);
}
