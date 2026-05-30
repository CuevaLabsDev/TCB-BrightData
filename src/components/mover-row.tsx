import Link from "next/link";
import { ImageIcon } from "lucide-react";
import type { CardSummary } from "@/lib/types";
import { Badge } from "@/components/ui/primitives";
import { changeColor, formatCurrency, formatPercent, movementBadge } from "@/lib/utils";

export function MoverRow({
  card,
  period = "30d",
  rank,
}: {
  card: CardSummary;
  period?: "7d" | "30d" | "90d" | "180d";
  rank?: number;
}) {
  const change =
    period === "7d" ? card.chg7d : period === "30d" ? card.chg30d : period === "90d" ? card.chg90d : card.chg180d;
  const flag = movementBadge(card.movementVerdict);
  return (
    <Link
      href={`/card/${card.productId}?sub=${encodeURIComponent(card.subType)}`}
      className="flex items-center gap-3 rounded-md px-2.5 py-2 transition hover:bg-panel-strong"
    >
      {rank !== undefined && (
        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-subtle">{rank}</span>
      )}
      <div className="flex aspect-[63/88] h-12 shrink-0 items-center justify-center overflow-hidden rounded-[3px]">
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt=""
            loading="lazy"
            className="size-full rounded-[3px] object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center rounded-[3px] border border-border bg-panel">
            <ImageIcon className="size-4 text-subtle" aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm text-foreground">{card.name}</p>
          {flag && <Badge tone={flag.tone}>{flag.label}</Badge>}
        </div>
        <p className="truncate text-xs text-subtle">
          {card.setName ?? "—"} · {card.subType}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm tabular-nums text-foreground">{formatCurrency(card.market)}</p>
        <p className={`text-xs tabular-nums ${changeColor(change)}`}>{formatPercent(change)}</p>
      </div>
    </Link>
  );
}
