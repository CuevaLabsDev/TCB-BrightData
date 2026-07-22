import "server-only";

type Entry = { timestamps: number[] };

const buckets = new Map<string, Entry>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Best-effort in-memory sliding-window rate limit (per isolate).
 * Returns true when the request is allowed.
 */
export function rateLimit(
  req: Request,
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): boolean {
  const id = `${key}:${clientIp(req)}`;
  const now = Date.now();
  const entry = buckets.get(id) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
  if (entry.timestamps.length >= limit) {
    buckets.set(id, entry);
    return false;
  }
  entry.timestamps.push(now);
  buckets.set(id, entry);
  return true;
}
