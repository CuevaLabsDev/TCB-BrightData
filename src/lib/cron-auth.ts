import "server-only";

/**
 * Authorize Vercel Cron (and manual cron triggers).
 * - Secret set → require Authorization: Bearer $CRON_SECRET
 * - Secret unset in production → deny (fail closed)
 * - Secret unset in local/dev → allow (DX)
 */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    return req.headers.get("authorization") === `Bearer ${secret}`;
  }
  return process.env.VERCEL_ENV !== "production";
}
