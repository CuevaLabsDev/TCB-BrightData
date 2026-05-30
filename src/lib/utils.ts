import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number | null | undefined, opts: { cents?: boolean } = {}) {
  if (value === null || value === undefined) return "—";
  const digits = opts.cents === false ? 0 : value >= 1000 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, opts: { sign?: boolean } = {}) {
  if (value === null || value === undefined) return "—";
  const sign = opts.sign === false ? "" : value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

export function changeColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "text-zinc-400";
  if (value > 0.5) return "text-emerald-400";
  if (value < -0.5) return "text-rose-400";
  return "text-zinc-400";
}

/** Movement verdict -> badge label + tone, or null when the move looks clean. */
export function movementBadge(
  verdict: string | null | undefined,
): { label: string; tone: "amber" | "rose" } | null {
  if (verdict === "likely_parking") return { label: "Likely parking", tone: "rose" };
  if (verdict === "suspicious") return { label: "Suspicious move", tone: "amber" };
  return null;
}

/** Liquidity score (0-100) -> tailwind text color + label. */
export function liquidityBand(score: number | null | undefined): { color: string; label: string } {
  if (score === null || score === undefined) return { color: "text-zinc-500", label: "Unknown" };
  if (score >= 70) return { color: "text-emerald-400", label: "Highly liquid" };
  if (score >= 45) return { color: "text-sky-400", label: "Liquid" };
  if (score >= 25) return { color: "text-amber-400", label: "Thin" };
  return { color: "text-rose-400", label: "Illiquid" };
}

/** Normalize postgres `date` / JS Date to YYYY-MM-DD (calendar date, no TZ shift). */
export function toIsoDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : null;
}

/** Parse YYYY-MM-DD as a local calendar date (avoids UTC midnight off-by-one). */
export function parseCalendarDate(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return new Date(isoDate);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toLocalDate(value: string | Date, opts: { dateOnly?: boolean } = {}): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseCalendarDate(s);
  if (opts.dateOnly) {
    const iso = toIsoDateOnly(s);
    if (iso) return parseCalendarDate(iso);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLocalDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  if (!value) return "—";
  const d = toLocalDate(value, { dateOnly: true });
  if (!d) return "—";
  return d.toLocaleDateString(undefined, options);
}

export function formatLocalDateTime(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  if (!value) return "—";
  const d = toLocalDate(value);
  if (!d) return "—";
  return d.toLocaleString(undefined, options);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
