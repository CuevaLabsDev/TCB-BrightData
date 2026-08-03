import Link from "next/link";
import { notFound } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, ExternalLink, Gem, Waves } from "lucide-react";
import {
  getCard,
  getCardVariants,
  getGradedComps,
  getLiquidity,
  getPriceHistory,
} from "@/lib/queries";
import { sql } from "@/lib/db";
import { Badge, Card, SectionTitle, Stat } from "@/components/ui/primitives";
import { PriceChart } from "@/components/price-chart";
import { RefreshLiveButton } from "@/components/refresh-live-button";
import {
  changeColor,
  formatCurrency,
  formatNumber,
  formatPercent,
  liquidityBand,
  movementBadge,
} from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sub?: string }>;
}) {
  const { id } = await params;
  const { sub } = await searchParams;
  const productId = Number(id);
  if (!Number.isFinite(productId)) notFound();

  const card = await getCard(productId, sub);
  if (!card) notFound();

  const [variants, history, liquidity, graded, posts] = await Promise.all([
    getCardVariants(productId),
    getPriceHistory(productId, card.subType, 180),
    getLiquidity(productId),
    getGradedComps(productId),
    sql`
      select po.platform, c.handle, po.sentiment, po.signal, po.summary,
             c.impact_score, c.flagged, po.post_url
      from posts po left join creators c on c.id = po.creator_id
      where ${productId} = any(po.mentioned_products)
      order by c.impact_score desc nulls last limit 8
    `,
  ]);

  const liq = liquidity[0];
  const band = liquidityBand(liq?.liquidityScore);
  const psa10 = graded.find((g) => g.grade === 10);
  const psa9 = graded.find((g) => g.grade === 9);

  return (
    <div className="space-y-6">
      <Link href="/movers" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300">
        <ArrowLeft className="h-4 w-4" /> Back to movers
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {card.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt={card.name}
            className="h-44 w-auto self-start rounded-lg border border-white/10"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-white">{card.name}</h1>
            {card.rarity && <Badge tone="violet">{card.rarity}</Badge>}
            {(() => {
              const flag = movementBadge(card.movementVerdict);
              return flag ? <Badge tone={flag.tone}>{flag.label}</Badge> : null;
            })()}
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {card.setName ?? "—"} {card.number && `· #${card.number}`} · {card.subType}
          </p>

          {/* Variant switcher */}
          {variants.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {variants.map((v) => (
                <Link
                  key={v.subType}
                  href={`/card/${productId}?sub=${encodeURIComponent(v.subType)}`}
                  className={`rounded-md border px-2 py-1 text-xs transition ${
                    v.subType === card.subType
                      ? "border-violet-500/40 bg-violet-500/15 text-violet-200"
                      : "border-white/10 text-zinc-400 hover:text-white"
                  }`}
                >
                  {v.subType} · {formatCurrency(v.market)}
                </Link>
              ))}
            </div>
          )}

          <div className="mt-4">
            <RefreshLiveButton productId={productId} subType={card.subType} />
          </div>
        </div>
      </div>

      {/* Price analytics row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Market" value={formatCurrency(card.market)} />
        <Stat label="7d" value={formatPercent(card.chg7d)} accent={changeColor(card.chg7d)} />
        <Stat label="30d" value={formatPercent(card.chg30d)} accent={changeColor(card.chg30d)} />
        <Stat label="90d" value={formatPercent(card.chg90d)} accent={changeColor(card.chg90d)} />
        <Stat label="180d" value={formatPercent(card.chg180d)} accent={changeColor(card.chg180d)} />
        <Stat
          label="180d range"
          value={
            <span className="text-base">
              {formatCurrency(card.low180d, { cents: false })}–{formatCurrency(card.high180d, { cents: false })}
            </span>
          }
        />
      </section>

      {/* Price chart */}
      <Card className="p-5">
        <SectionTitle title="Price history" subtitle="Daily TCGplayer market price · 180 days" />
        <PriceChart data={history} />
      </Card>

      {/* Grade arbitrage + liquidity */}
      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle
            title="Raw → PSA grade arbitrage"
            subtitle="eBay realized sold comps via Bright Data"
            right={<Gem className="h-4 w-4 text-violet-400" />}
          />
          {card.isSealed ? (
            <p className="py-8 text-center text-sm text-zinc-600">
              PSA grade comps apply to singles — sealed product, not graded.
            </p>
          ) : graded.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-600">
              No graded comps yet — hit “Refresh live” to scrape eBay PSA sales.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-3 text-center">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Raw NM</p>
                  <p className="mt-1 text-lg font-semibold text-white">{formatCurrency(card.market)}</p>
                </div>
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-center">
                  <p className="text-[11px] uppercase tracking-wide text-sky-400/80">PSA 9</p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {formatCurrency(psa9?.lastSold ?? psa9?.avgSold)}
                  </p>
                  {psa9?.gradeMultiple && <p className="text-xs text-zinc-500">{psa9.gradeMultiple}×</p>}
                </div>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center">
                  <p className="text-[11px] uppercase tracking-wide text-emerald-400/80">PSA 10</p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {formatCurrency(psa10?.lastSold ?? psa10?.avgSold)}
                  </p>
                  {psa10?.gradeMultiple && (
                    <p className="text-xs font-medium text-emerald-400">{psa10.gradeMultiple}×</p>
                  )}
                </div>
              </div>
              {psa10 && (
                <>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <Metric
                      label="Sold / day"
                      value={
                        psa10.soldPerDay === null || psa10.soldPerDay === undefined
                          ? "—"
                          : `${psa10.soldPerDay.toFixed(2)}`
                      }
                    />
                    <Metric
                      label="Sold / month"
                      value={
                        psa10.soldPerMonth === null || psa10.soldPerMonth === undefined
                          ? "—"
                          : `${psa10.soldPerMonth.toFixed(1)}`
                      }
                    />
                    <Metric label="Comps (n)" value={formatNumber(psa10.sampleSize)} />
                  </div>
                  <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-3 text-sm text-zinc-300">
                    <span className="font-medium text-white">Signal: </span>
                    {psa10.gradeMultiple && psa10.gradeMultiple >= 2.5 && (liq?.liquidityScore ?? 0) >= 40
                      ? `Strong submit — ${psa10.gradeMultiple}× multiple on a liquid card (n=${psa10.sampleSize} sold).`
                      : psa10.gradeMultiple && psa10.gradeMultiple >= 2.5
                        ? `Attractive ${psa10.gradeMultiple}× multiple, but watch liquidity (${band.label}).`
                        : `Modest ${psa10.gradeMultiple ?? "—"}× multiple — grading premium thin; hold raw.`}
                  </div>
                </>
              )}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Liquidity"
            subtitle="TCGplayer velocity, depth & spread via Bright Data"
            right={<Waves className="h-4 w-4 text-sky-400" />}
          />
          {!liq ? (
            <p className="py-8 text-center text-sm text-zinc-600">
              No liquidity data yet — hit “Refresh live”.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-end gap-3">
                <span className={`text-4xl font-bold tabular-nums ${band.color}`}>
                  {liq.liquidityScore?.toFixed(0)}
                </span>
                <div className="pb-1">
                  <p className={`text-sm font-medium ${band.color}`}>{band.label}</p>
                  <p className="text-xs text-zinc-500">liquidity score / 100</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Metric label="Sold velocity" value={`${liq.soldVelocity?.toFixed(2) ?? "—"}/day`} />
                <Metric label="Active listings" value={formatNumber(liq.activeListings)} />
                <Metric label="Sold (90d)" value={formatNumber(liq.totalQtySold90d)} />
                <Metric
                  label="Bid/ask spread"
                  value={liq.bidAskSpreadPct === null ? "—" : `${liq.bidAskSpreadPct}%`}
                />
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* Creator sentiment timeline */}
      {posts.length > 0 && (
        <Card className="p-5">
          <SectionTitle title="Creator chatter" subtitle="Social posts mentioning this card" />
          <div className="space-y-2">
            {posts.map((p, i) => (
              <a
                key={i}
                href={(p.post_url as string) ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-lg border border-white/5 bg-zinc-900/40 px-3 py-2.5 transition hover:border-white/10"
              >
                <SentimentDot sentiment={p.sentiment as string} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-200">{(p.summary as string) ?? "—"}</p>
                  <p className="text-xs capitalize text-zinc-500">
                    {p.flagged && "🚩 "}
                    {p.platform as string} · {(p.handle as string) ?? "—"} ·{" "}
                    <span className="uppercase">{p.signal as string}</span>
                  </p>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              </a>
            ))}
          </div>
        </Card>
      )}

      {card.url && (
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300"
        >
          View on TCGplayer <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 font-semibold text-white">{value}</p>
    </div>
  );
}

function SentimentDot({ sentiment }: { sentiment: string }) {
  const color =
    sentiment === "bullish"
      ? "bg-emerald-400"
      : sentiment === "bearish"
        ? "bg-rose-400"
        : "bg-zinc-500";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}
