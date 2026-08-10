import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Clock3,
  Database,
  Flag,
  Gem,
  Sparkles,
  TrendingUp,
  Waves,
} from "lucide-react";
import {
  getGradeArbitrageBoard,
  getLiquiditySpotlights,
  getLiquidityTrends,
  getMarketMemory,
  getMarketStats,
  getTopCreators,
  getTopMovers,
} from "@/lib/queries";
import { Badge, Card, SectionTitle, Stat } from "@/components/ui/primitives";
import { MoverRow } from "@/components/mover-row";
import { LocalTime } from "@/components/local-time";
import {
  changeColor,
  formatCurrency,
  formatNumber,
  formatPercent,
  liquidityBand,
} from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, gainers, losers, gradeArb, spotlights, trends, creators, memory] =
    await Promise.all([
      getMarketStats(),
      getTopMovers({ period: "30d", direction: "up", minMarket: 25, limit: 8 }),
      getTopMovers({ period: "30d", direction: "down", minMarket: 25, limit: 5 }),
      getGradeArbitrageBoard(6),
      getLiquiditySpotlights(6),
      getLiquidityTrends(6),
      getTopCreators(6),
      getMarketMemory("market", 1),
    ]);

  const synthesis = memory.find((m) => m.title?.includes("synthesis")) ?? memory[0];
  const heroCards = [
    ...gainers.filter((card) => card.imageUrl),
    ...gainers.filter((card) => !card.imageUrl),
  ].slice(0, 3);
  const summaryStats = [
    { label: "Products tracked", value: formatNumber(stats.products), sub: "Pokémon · Cat 3", icon: Boxes },
    { label: "Price series", value: formatNumber(stats.trackedSeries), sub: "product x variant", icon: BarChart3 },
    { label: "Daily price points", value: `${(stats.dailyRows / 1e6).toFixed(1)}M`, sub: "180d window", icon: Database },
    { label: "Sets", value: formatNumber(stats.sets), sub: "2024-2026", icon: Boxes },
    {
      label: "Catalog market value",
      value: formatCurrency(stats.totalMarketValue, { cents: false }),
      sub: "sum of singles",
      icon: TrendingUp,
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* Hero */}
      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-stretch">
        <div className="card-surface flex min-h-[360px] flex-col justify-between overflow-hidden p-6 sm:p-8">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="violet">
                <span className="pulse-dot inline-block size-1.5 rounded-full bg-accent" />
                Live market hub
              </Badge>
              <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
                <Clock3 className="size-3.5" />
                as of <LocalTime value={stats.asOf} mode="date" />
              </span>
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              Everything in the <span className="holo-text">Pokémon card market</span>, in one place
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
              Price history, grading spreads, marketplace liquidity, and creator sentiment are
              unified at Trading Card Block so you can see what is moving and act before the
              market does.
            </p>
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-2">
            <Link
              href="/movers"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90"
            >
              <TrendingUp className="size-4" />
              View movers
            </Link>
            <Link
              href="/agent"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel-strong px-3 text-sm font-medium text-foreground transition hover:border-accent/40"
            >
              <Sparkles className="size-4 text-accent" />
              Ask TCB
            </Link>
          </div>
        </div>

        <Card className="overflow-hidden p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">TCB · Sleepers</p>
              <p className="text-xs text-subtle">Under-the-radar cards starting to move</p>
            </div>
            <Badge tone="amber">Sleepers</Badge>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {heroCards.map((card, index) => (
              <Link
                key={`${card.productId}-${card.subType}`}
                href={`/card/${card.productId}?sub=${encodeURIComponent(card.subType)}`}
                className="group min-w-0"
              >
                <div className="mx-auto flex aspect-[63/88] w-full items-center justify-center overflow-hidden rounded-[4px]">
                  {card.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={card.imageUrl}
                      alt=""
                      loading={index === 0 ? "eager" : "lazy"}
                      className="size-full rounded-[4px] border border-border object-cover transition group-hover:border-accent/40 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center rounded-[4px] border border-border bg-panel-strong">
                      <Boxes className="size-6 text-subtle" />
                    </div>
                  )}
                </div>
                <p className="mt-2 truncate text-xs font-medium text-foreground">{card.name}</p>
                <p className={`text-xs tabular-nums ${changeColor(card.chg30d)}`}>
                  {formatPercent(card.chg30d)}
                </p>
              </Link>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border bg-panel p-3">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Signal stack</p>
              <p className="mt-1 text-sm font-semibold text-foreground">Price + liquidity + social</p>
            </div>
            <div className="rounded-md border border-border bg-panel p-3">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Agent layer</p>
              <p className="mt-1 text-sm font-semibold text-foreground">Featherless tools</p>
            </div>
          </div>
        </Card>
      </section>

      {/* Stat row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {summaryStats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </section>

      {/* cognee market memory synthesis */}
      {synthesis && (
        <section>
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-accent" />
              <h2 className="text-sm font-semibold text-foreground">Market pulse</h2>
              <Badge tone="violet" className="ml-1">TCB memory</Badge>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">{synthesis.narrative}</p>
          </Card>
        </section>
      )}

      {/* Movers */}
      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle
            title="Top 30-day gainers"
            subtitle="Singles ≥ $25, ≥5 data points"
            right={
              <Link href="/movers" className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80">
                All movers <ArrowUpRight className="size-3" />
              </Link>
            }
          />
          <div className="flex flex-col gap-0.5">
            {gainers.map((c, i) => (
              <MoverRow key={`${c.productId}-${c.subType}`} card={c} period="30d" rank={i + 1} />
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle title="Top 30-day decliners" subtitle="Where momentum is fading" />
          <div className="flex flex-col gap-0.5">
            {losers.map((c, i) => (
              <MoverRow key={`${c.productId}-${c.subType}`} card={c} period="30d" rank={i + 1} />
            ))}
          </div>
        </Card>
      </section>

      {/* Grade arbitrage + liquidity */}
      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle
            title="Raw → PSA 10 grade arbitrage"
            subtitle="Live eBay sold comps via Bright Data"
            right={<Gem className="size-4 text-accent" />}
          />
          <div className="flex flex-col gap-1">
            {gradeArb.length === 0 && (
              <p className="py-6 text-center text-sm text-subtle">No graded comps yet.</p>
            )}
            {gradeArb.map((g) => {
              const band = liquidityBand(g.liquidityScore);
              return (
                <Link
                  key={g.productId}
                  href={`/card/${g.productId}`}
                  className="flex items-center gap-3 rounded-md px-2.5 py-2 transition hover:bg-panel-strong"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{g.name}</p>
                    <p className="truncate text-xs text-subtle">
                      raw {formatCurrency(g.rawMarket)} → PSA10 {formatCurrency(g.psa10)}
                      {g.liquidityScore !== null && (
                        <span className={`ml-1.5 ${band.color}`}>· {band.label}</span>
                      )}
                    </p>
                  </div>
                  <Badge tone={g.gradeMultiple && g.gradeMultiple >= 2.5 ? "emerald" : "neutral"}>
                    {g.gradeMultiple?.toFixed(2)}×
                  </Badge>
                </Link>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Liquidity spotlights"
            subtitle="Thin book + high velocity (ranked scrape budget)"
            right={<Waves className="size-4 text-info" />}
          />
          <div className="flex flex-col gap-1">
            {spotlights.length === 0 && (
              <p className="py-6 text-center text-sm text-subtle">No liquidity spotlights yet.</p>
            )}
            {spotlights.map((l) => {
              const band = liquidityBand(l.liquidityScore);
              return (
                <Link
                  key={`${l.productId}-${l.subType}`}
                  href={`/card/${l.productId}?sub=${encodeURIComponent(l.subType)}`}
                  className="flex items-center gap-3 rounded-md px-2.5 py-2 transition hover:bg-panel-strong"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{l.name}</p>
                    <p className="truncate text-xs text-subtle">
                      {l.soldVelocity?.toFixed(2)}/day · {l.activeListings ?? "—"} listings
                      {l.totalQuantity != null ? ` · qty ${l.totalQuantity}` : ""}
                      {l.setName ? ` · ${l.setName}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 text-sm font-semibold tabular-nums ${band.color}`}>
                    {l.liquidityScore?.toFixed(0) ?? "—"}
                  </span>
                </Link>
              );
            })}
          </div>
        </Card>
      </section>

      <section>
        <Card className="p-5">
          <SectionTitle
            title="Liquidity trends"
            subtitle="Biggest recent changes in velocity and listing depth"
            right={<Activity className="size-4 text-accent" />}
          />
          <div className="grid gap-1 sm:grid-cols-2">
            {trends.length === 0 && (
              <p className="col-span-full py-6 text-center text-sm text-subtle">
                Trends appear after repeated scrapes build snapshot history.
              </p>
            )}
            {trends.map((t) => {
              const listUp = (t.listingsDelta ?? 0) > 0;
              return (
                <Link
                  key={`${t.productId}-${t.subType}`}
                  href={`/card/${t.productId}?sub=${encodeURIComponent(t.subType)}`}
                  className="flex items-center gap-3 rounded-md px-2.5 py-2 transition hover:bg-panel-strong"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{t.name}</p>
                    <p className="truncate text-xs text-subtle">
                      vel {t.prevSoldVelocity?.toFixed(2) ?? "—"}→{t.soldVelocity?.toFixed(2) ?? "—"}
                      {" · "}
                      listings {t.prevActiveListings ?? "—"}→{t.activeListings ?? "—"}
                      {t.setName ? ` · ${t.setName}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs tabular-nums">
                    <p className={changeColor(t.velocityDelta)}>
                      {t.velocityDelta == null
                        ? "—"
                        : `${t.velocityDelta > 0 ? "+" : ""}${t.velocityDelta.toFixed(2)}/d`}
                    </p>
                    <p className={listUp ? "text-muted" : "text-accent"}>
                      {t.listingsDelta == null
                        ? "—"
                        : `${t.listingsDelta > 0 ? "+" : ""}${t.listingsDelta} list`}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </Card>
      </section>

      {/* Creator pulse */}
      <section>
        <Card className="p-5">
          <SectionTitle
            title="Creator influence"
            subtitle="Ranked by measured market impact"
            right={
              <Link href="/creators" className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80">
                All creators <ArrowUpRight className="size-3" />
              </Link>
            }
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {creators.map((c) => (
              <Link
                key={c.id}
                href="/creators"
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel px-3 py-2.5 transition hover:border-accent/30"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm text-foreground">
                    {c.flagged && <Flag className="size-3 shrink-0 text-warning" />}
                    {c.handle}
                  </p>
                  <p className="text-xs capitalize text-subtle">
                    {c.platform} · {c.posts} post{c.posts === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums text-accent">
                    {c.impactScore.toFixed(1)}
                  </p>
                  <p className="text-[10px] uppercase tracking-wide text-subtle">impact</p>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </section>

      {/* Data provenance footer */}
      <section className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        {[
          { icon: Database, label: "Price history", val: "tcgcsv · 2yr daily" },
          { icon: TrendingUp, label: "Liquidity + graded", val: "Bright Data live" },
          { icon: Boxes, label: "Catalog", val: "32k products" },
          { icon: Activity, label: "Memory", val: "cognee + Featherless" },
        ].map((s) => (
          <div key={s.label} className="card-surface flex items-center gap-2.5 p-3">
            <s.icon className="size-4 shrink-0 text-subtle" />
            <div className="min-w-0">
              <p className="truncate text-muted">{s.label}</p>
              <p className="truncate text-subtle">{s.val}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
