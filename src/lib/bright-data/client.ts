import "server-only";

/**
 * Bright Data Web Data UNLOCKED client.
 *
 * Two products via the unified `/request` API:
 *   - SERP API      (zone BRIGHT_DATA_SERP_ZONE)    — Google/structured search
 *   - Web Unlocker  (zone BRIGHT_DATA_UNLOCKER_ZONE) — bot-protected pages (eBay,
 *                                                       TCGplayer, social)
 *
 * Every public-web call in this app routes through here, satisfying the
 * hackathon's "must use a Bright Data product" requirement.
 */

const BRIGHT_DATA_API = "https://api.brightdata.com/request";

export interface SerpOrganic {
  title?: string;
  link?: string;
  description?: string;
  display_link?: string;
  rank?: number;
}

export function hasBrightData() {
  return Boolean(process.env.BRIGHT_DATA_API_KEY);
}

function serpZone() {
  return process.env.BRIGHT_DATA_SERP_ZONE || "serp_api1";
}
function unlockerZone() {
  return process.env.BRIGHT_DATA_UNLOCKER_ZONE || "tcb_1";
}

export interface RawRequestOpts {
  format?: "raw" | "json";
  country?: string;
  method?: "GET" | "POST";
  /** Raw POST body forwarded to the target URL. */
  body?: string;
  /** Custom headers forwarded to the target URL. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Unlocker `data_format` (e.g. markdown). Omit for full HTML. */
  dataFormat?: string;
}

async function rawRequest(
  zone: string,
  url: string,
  opts: RawRequestOpts = {},
): Promise<string> {
  const apiKey = process.env.BRIGHT_DATA_API_KEY;
  if (!apiKey) throw new Error("BRIGHT_DATA_API_KEY is not configured");

  const payload: Record<string, unknown> = {
    zone,
    url,
    format: opts.format ?? "raw",
  };
  if (opts.country) payload.country = opts.country;
  if (opts.method) payload.method = opts.method;
  if (opts.body) payload.body = opts.body;
  if (opts.headers) payload.headers = opts.headers;
  if (opts.dataFormat) payload.data_format = opts.dataFormat;

  const res = await fetch(BRIGHT_DATA_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    // Bright Data unlocker can take a while on hard targets
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Bright Data ${zone} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  // format:"json" wraps the upstream response; surface Unlocker failures clearly
  // instead of returning empty/opaque bodies that parse as zero comps.
  if ((opts.format ?? "raw") === "json") {
    try {
      const wrapped = JSON.parse(text) as {
        status_code?: number;
        body?: string;
        headers?: Record<string, string>;
      };
      const brdError =
        wrapped.headers?.["x-brd-error"] ?? wrapped.headers?.["x-brd-error-code"];
      if (brdError || (wrapped.status_code && wrapped.status_code >= 400)) {
        throw new Error(
          `Bright Data ${zone} upstream ${wrapped.status_code ?? "?"}: ${brdError ?? text.slice(0, 200)}`,
        );
      }
      if (typeof wrapped.body === "string") return wrapped.body;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Bright Data")) throw e;
      // fall through — caller may want the raw JSON string
    }
  }

  if (!text.trim()) {
    throw new Error(`Bright Data ${zone} returned an empty body for ${url.slice(0, 120)}`);
  }
  return text;
}

/** Low-level access to the Web Unlocker zone for arbitrary GET/POST JSON APIs. */
export async function unlockerRequest(
  url: string,
  opts: RawRequestOpts = {},
): Promise<string> {
  return rawRequest(unlockerZone(), url, opts);
}

/** Google SERP via Bright Data SERP API, parsed JSON (brd_json=1). */
export async function serpSearch(
  query: string,
  opts: { country?: string; num?: number } = {},
): Promise<{ organic: SerpOrganic[]; raw?: string }> {
  const params = new URLSearchParams({ q: query, brd_json: "1" });
  if (opts.num) params.set("num", String(opts.num));
  const url = `https://www.google.com/search?${params.toString()}`;
  const raw = await rawRequest(serpZone(), url, {
    format: "raw",
    country: opts.country ?? "us",
  });
  try {
    const parsed = JSON.parse(raw) as { organic?: SerpOrganic[] };
    return { organic: parsed.organic ?? [] };
  } catch {
    return { organic: [], raw };
  }
}

/** Fetch a bot-protected page's HTML via Web Unlocker. */
export async function unlockPage(
  url: string,
  opts: { country?: string; timeoutMs?: number } = {},
): Promise<string> {
  // Prefer format:"json" so Unlocker wait/rate-limit failures surface as
  // x-brd-error instead of an empty raw body that looks like "no comps".
  return rawRequest(unlockerZone(), url, {
    format: "json",
    country: opts.country ?? "us",
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Fetch a page that returns JSON (e.g. a marketplace API endpoint) through the
 * Web Unlocker and parse it.
 */
export async function unlockJson<T = unknown>(
  url: string,
  country = "us",
): Promise<T | null> {
  const text = await rawRequest(unlockerZone(), url, { format: "raw", country });
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function brightDataStatus() {
  return {
    configured: hasBrightData(),
    serpZone: serpZone(),
    unlockerZone: unlockerZone(),
  };
}
