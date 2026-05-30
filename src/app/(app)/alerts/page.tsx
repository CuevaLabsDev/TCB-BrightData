import Link from "next/link";
import { AlertTriangle, Bell, TrendingUp, Users, Zap } from "lucide-react";
import { getRecentSignals } from "@/lib/queries";
import { Badge, Card } from "@/components/ui/primitives";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { icon: typeof Bell; tone: "violet" | "sky" | "amber" | "emerald" | "rose"; label: string }> = {
  creator_move: { icon: Users, tone: "violet", label: "Creator move" },
  price_breakout: { icon: TrendingUp, tone: "emerald", label: "Price breakout" },
  grade_arbitrage: { icon: Zap, tone: "amber", label: "Grade arbitrage" },
};

const SEV_TONE: Record<string, "rose" | "amber" | "neutral"> = {
  act: "rose",
  watch: "amber",
  info: "neutral",
};

export default async function AlertsPage() {
  const signals = await getRecentSignals(40);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Bell className="h-5 w-5 text-violet-400" /> Live alerts
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Signals from across the market — creator moves, price breakouts, liquidity spikes,
            and grade arbitrage — surfaced in one feed with actionable listing links.
          </p>
        </div>
        <Badge tone="violet">
          <span className="pulse-dot mr-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
          Watcher active
        </Badge>
      </div>

      {signals.length === 0 ? (
        <Card className="p-10 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-400">No signals yet. The cron watcher will populate this feed.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => {
            const meta = KIND_META[s.kind] ?? { icon: Bell, tone: "neutral" as const, label: s.kind };
            const Icon = meta.icon;
            const links = (s.links as { label: string; url: string }[] | null) ?? [];
            return (
              <Card key={s.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5`}>
                    <Icon className="h-4 w-4 text-violet-300" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-white">{s.title}</span>
                      <Badge tone={SEV_TONE[s.severity]}>{s.severity.toUpperCase()}</Badge>
                      <Badge tone={meta.tone as "violet"}>{meta.label}</Badge>
                      <LocalTime value={s.createdAt} mode="datetime" className="ml-auto text-xs text-zinc-600" />
                    </div>
                    {s.body && <p className="mt-1 text-sm text-zinc-400">{s.body}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      {s.productId && (
                        <Link
                          href={`/card/${s.productId}`}
                          className="text-xs font-medium text-violet-300 hover:text-violet-200"
                        >
                          View card →
                        </Link>
                      )}
                      {links.map((l, i) => (
                        <a
                          key={i}
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-sky-300 hover:text-sky-200"
                        >
                          {l.label} →
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
