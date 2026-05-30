"use client";

import { formatLocalDate, formatLocalDateTime, timeAgo, toIsoDateOnly } from "@/lib/utils";

type LocalTimeMode = "date" | "datetime" | "relative" | "short";

function format(value: string, mode: LocalTimeMode): string {
  switch (mode) {
    case "relative":
      return timeAgo(value);
    case "datetime":
      return formatLocalDateTime(value);
    case "short":
      return formatLocalDate(value, { month: "short", day: "numeric" });
    default:
      return formatLocalDate(value);
  }
}

export function LocalTime({
  value,
  mode = "date",
  className,
}: {
  value: string | null | undefined;
  mode?: LocalTimeMode;
  className?: string;
}) {
  if (!value) return <span className={className}>—</span>;

  const dateTime =
    mode === "date" || mode === "short" ? (toIsoDateOnly(value) ?? value.slice(0, 10)) : value;

  return (
    <time dateTime={dateTime} className={className} suppressHydrationWarning>
      {format(value, mode)}
    </time>
  );
}
