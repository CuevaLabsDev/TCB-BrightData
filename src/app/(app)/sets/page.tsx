import Link from "next/link";
import { getSets } from "@/lib/queries";
import { Card } from "@/components/ui/primitives";
import { changeColor, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SetsPage() {
  const sets = await getSets(80);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Sets</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {sets.length} Pokémon sets ranked by total tracked market value, with 30-day momentum.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-white/10 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          <span>Set</span>
          <span className="text-right">Cards</span>
          <span className="text-right">Avg price</span>
          <span className="text-right">30d</span>
        </div>
        <div className="divide-y divide-white/5">
          {sets.map((s) => (
            <Link
              key={s.groupId}
              href={`/sets/${s.groupId}`}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-3 transition hover:bg-white/5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{s.name}</p>
                <p className="truncate text-xs text-zinc-500">
                  {s.abbreviation ?? "—"} · total {formatCurrency(s.totalMarket, { cents: false })}
                </p>
              </div>
              <span className="text-right text-sm tabular-nums text-zinc-400">{formatNumber(s.cardCount)}</span>
              <span className="text-right text-sm tabular-nums text-white">{formatCurrency(s.avgMarket)}</span>
              <span className={`text-right text-sm tabular-nums ${changeColor(s.avgChg30d)}`}>
                {formatPercent(s.avgChg30d)}
              </span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
