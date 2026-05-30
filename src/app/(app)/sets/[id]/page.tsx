import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Layers,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { getSet, getSetCards } from "@/lib/queries";
import { Badge, Card } from "@/components/ui/primitives";
import type { CardSummary } from "@/lib/types";
import { changeColor, cn, formatCurrency, formatNumber, formatPercent, movementBadge } from "@/lib/utils";

export const dynamic = "force-dynamic";

const BINDER_PAGE_SIZE = 12;

export default async function SetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const groupId = Number(id);
  if (!Number.isFinite(groupId)) notFound();

  const [set, cards] = await Promise.all([getSet(groupId), getSetCards(groupId, 240)]);
  if (!set) notFound();

  const pricedCards = cards.filter((card) => card.market !== null);
  const movingCards = cards.filter((card) => card.chg30d !== null);
  const totalMarket = pricedCards.reduce((sum, card) => sum + (card.market ?? 0), 0);
  const avgMarket = pricedCards.length > 0 ? totalMarket / pricedCards.length : null;
  const avgChg30d =
    movingCards.length > 0
      ? movingCards.reduce((sum, card) => sum + (card.chg30d ?? 0), 0) / movingCards.length
      : null;
  const anchorCard = pricedCards[0] ?? cards[0] ?? null;
  const topGainer = movingCards.reduce<CardSummary | null>(
    (best, card) => (!best || (card.chg30d ?? -Infinity) > (best.chg30d ?? -Infinity) ? card : best),
    null,
  );
  const topDecliner = movingCards.reduce<CardSummary | null>(
    (worst, card) => (!worst || (card.chg30d ?? Infinity) < (worst.chg30d ?? Infinity) ? card : worst),
    null,
  );
  const binderPages = chunk(cards, BINDER_PAGE_SIZE);
  const pageCount = Math.max(1, binderPages.length);
  const requestedPage = Number(sp.page ?? 1);
  const currentPage = Math.min(
    pageCount,
    Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1),
  );
  const pageCards = binderPages[currentPage - 1] ?? [];
  const pageStart = (currentPage - 1) * BINDER_PAGE_SIZE + 1;
  const pageEnd = (currentPage - 1) * BINDER_PAGE_SIZE + pageCards.length;
  const pulseTone = avgChg30d === null ? "neutral" : avgChg30d > 0.5 ? "emerald" : avgChg30d < -0.5 ? "rose" : "amber";

  return (
    <div className="flex flex-col gap-6">
      <Link href="/sets" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" /> All sets
      </Link>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="card-surface p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="violet">
              <BookOpen className="size-3" />
              Binder view
            </Badge>
            <Badge tone={pulseTone}>30d {formatPercent(avgChg30d)}</Badge>
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground">{set.name}</h1>
          <p className="mt-2 text-sm text-muted">
          {set.abbreviation ?? "—"} · {cards.length} tracked cards by market value
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PulseMetric label="Set market" value={formatCurrency(totalMarket, { cents: false })} />
            <PulseMetric label="Avg card" value={formatCurrency(avgMarket)} />
            <PulseMetric label="Priced cards" value={formatNumber(pricedCards.length)} />
            <PulseMetric label="Binder pages" value={formatNumber(pageCount)} />
          </div>
        </div>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-foreground">Market pulse</h2>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {buildPulseCopy({ setName: set.name, avgChg30d, anchorCard, topGainer, topDecliner })}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {topGainer && (
              <PulseCard label="Strongest gainer" card={topGainer} icon={TrendingUp} />
            )}
            {topDecliner && (
              <PulseCard label="Biggest decliner" card={topDecliner} icon={TrendingDown} />
            )}
          </div>
        </Card>
      </section>

      <Card className="overflow-hidden p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Binder page {currentPage} of {pageCount}
              </h2>
              <p className="text-xs text-subtle">
                Cards #{pageStart}-{pageEnd}
              </p>
            </div>
          </div>
          <BinderControls groupId={groupId} currentPage={currentPage} pageCount={pageCount} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {pageCards.map((card, index) => (
            <BinderCard
              key={`${card.productId}-${card.subType}`}
              card={card}
              rank={(currentPage - 1) * BINDER_PAGE_SIZE + index + 1}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

function buildPulseCopy({
  setName,
  avgChg30d,
  anchorCard,
  topGainer,
  topDecliner,
}: {
  setName: string;
  avgChg30d: number | null;
  anchorCard: CardSummary | null;
  topGainer: CardSummary | null;
  topDecliner: CardSummary | null;
}) {
  const direction =
    avgChg30d === null
      ? "has limited 30-day movement coverage"
      : avgChg30d > 0.5
        ? `is trading up ${formatPercent(avgChg30d)} on average over 30 days`
        : avgChg30d < -0.5
          ? `is trading down ${formatPercent(avgChg30d)} on average over 30 days`
          : "is mostly flat across the 30-day window";
  const anchor = anchorCard ? `${anchorCard.name} anchors the set at ${formatCurrency(anchorCard.market)}.` : "";
  const gainer = topGainer ? ` Strongest momentum is ${topGainer.name} at ${formatPercent(topGainer.chg30d)}.` : "";
  const decliner = topDecliner ? ` Watch ${topDecliner.name}, down ${formatPercent(topDecliner.chg30d)}.` : "";
  return `${setName} ${direction}. ${anchor}${gainer}${decliner}`;
}

function PulseMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-panel p-3">
      <p className="text-[11px] uppercase tracking-wider text-subtle">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function PulseCard({
  label,
  card,
  icon: Icon,
}: {
  label: string;
  card: CardSummary;
  icon: typeof TrendingUp;
}) {
  return (
    <Link
      href={`/card/${card.productId}?sub=${encodeURIComponent(card.subType)}`}
      className="flex items-center gap-3 rounded-md border border-border bg-panel p-2.5 transition hover:border-accent/40"
    >
      <Icon className="size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wider text-subtle">{label}</p>
        <p className="truncate text-sm font-medium text-foreground">{card.name}</p>
      </div>
      <p className={cn("shrink-0 text-sm font-semibold tabular-nums", changeColor(card.chg30d))}>
        {formatPercent(card.chg30d)}
      </p>
    </Link>
  );
}

function BinderControls({
  groupId,
  currentPage,
  pageCount,
}: {
  groupId: number;
  currentPage: number;
  pageCount: number;
}) {
  const previous = currentPage - 1;
  const next = currentPage + 1;
  return (
    <div className="flex items-center gap-2">
      {previous >= 1 ? (
        <Link
          href={binderHref(groupId, previous)}
          scroll={false}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-panel px-3 text-sm font-medium text-foreground transition hover:border-accent/40"
        >
          <ChevronLeft className="size-4" />
          Previous
        </Link>
      ) : (
        <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-panel px-3 text-sm font-medium text-subtle opacity-50">
          <ChevronLeft className="size-4" />
          Previous
        </span>
      )}
      <span className="hidden text-xs text-subtle sm:inline">
        {currentPage} / {pageCount}
      </span>
      {next <= pageCount ? (
        <Link
          href={binderHref(groupId, next)}
          scroll={false}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90"
        >
          Next
          <ChevronRight className="size-4" />
        </Link>
      ) : (
        <span className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground opacity-50">
          Next
          <ChevronRight className="size-4" />
        </span>
      )}
    </div>
  );
}

function binderHref(groupId: number, page: number) {
  return page <= 1 ? `/sets/${groupId}` : `/sets/${groupId}?page=${page}`;
}

function BinderCard({ card, rank }: { card: CardSummary; rank: number }) {
  const flag = movementBadge(card.movementVerdict);
  return (
    <Link
      href={`/card/${card.productId}?sub=${encodeURIComponent(card.subType)}`}
      className="group min-w-0 rounded-md border border-border bg-panel p-2 transition hover:border-accent/40 hover:bg-panel-strong"
    >
      <div className="relative mx-auto aspect-[63/88] w-full overflow-hidden rounded-[4px]">
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt=""
            loading="lazy"
            className="size-full rounded-[4px] border border-border object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex size-full items-center justify-center rounded-[4px] border border-border bg-panel-strong">
            <ImageIcon className="size-6 text-subtle" aria-hidden="true" />
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted">
          #{rank}
        </span>
      </div>
      <div className="mt-2 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-xs font-medium text-foreground">{card.name}</p>
          {flag && <Badge tone={flag.tone}>{flag.label}</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-subtle">{card.subType}</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold tabular-nums text-foreground">
            {formatCurrency(card.market)}
          </span>
          <span className={cn("text-xs tabular-nums", changeColor(card.chg30d))}>
            {formatPercent(card.chg30d)}
          </span>
        </div>
      </div>
    </Link>
  );
}
