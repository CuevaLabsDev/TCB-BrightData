import Link from "next/link";
import { TrendingDown, TrendingUp } from "lucide-react";
import { getTopMovers } from "@/lib/queries";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { MoverRow } from "@/components/mover-row";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS = ["7d", "30d", "90d", "180d"] as const;
type Period = (typeof PERIODS)[number];

export default async function MoversPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; type?: string }>;
}) {
  const sp = await searchParams;
  const period = (PERIODS.includes(sp.period as Period) ? sp.period : "30d") as Period;
  const sealedOnly = sp.type === "sealed";

  const [gainers, losers] = await Promise.all([
    getTopMovers({ period, direction: "up", minMarket: 15, limit: 25, sealedOnly, singlesOnly: !sealedOnly }),
    getTopMovers({ period, direction: "down", minMarket: 15, limit: 25, sealedOnly, singlesOnly: !sealedOnly }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Market movers</h1>
        <p className="mt-1 text-sm text-muted">
          Biggest price changes across the Pokémon catalog — computed from TCB&apos;s 2-year daily price history.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-1 rounded-md border border-border bg-panel p-1">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/movers?period=${p}${sealedOnly ? "&type=sealed" : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition",
                p === period ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground",
              )}
            >
              {p}
            </Link>
          ))}
        </div>
        <div className="flex gap-1 rounded-md border border-border bg-panel p-1">
          {[
            { key: "singles", label: "Singles" },
            { key: "sealed", label: "Sealed" },
          ].map((t) => (
            <Link
              key={t.key}
              href={`/movers?period=${period}${t.key === "sealed" ? "&type=sealed" : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition",
                (t.key === "sealed") === sealedOnly
                  ? "bg-panel-strong text-foreground"
                  : "text-muted hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle
            title={`Top gainers · ${period}`}
            right={<TrendingUp className="size-4 text-success" />}
          />
          <div className="flex flex-col gap-0.5">
            {gainers.map((c, i) => (
              <MoverRow key={`${c.productId}-${c.subType}`} card={c} period={period} rank={i + 1} />
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle
            title={`Top decliners · ${period}`}
            right={<TrendingDown className="size-4 text-danger" />}
          />
          <div className="flex flex-col gap-0.5">
            {losers.map((c, i) => (
              <MoverRow key={`${c.productId}-${c.subType}`} card={c} period={period} rank={i + 1} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
