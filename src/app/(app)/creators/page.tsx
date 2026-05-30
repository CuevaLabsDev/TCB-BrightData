import { ExternalLink, Flag, Radar, Video } from "lucide-react";
import { getTopCreators } from "@/lib/queries";
import { sql } from "@/lib/db";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";

const PLATFORM_TONE: Record<string, "violet" | "sky" | "amber" | "rose" | "neutral"> = {
  youtube: "rose",
  tiktok: "neutral",
  instagram: "violet",
  reddit: "amber",
  x: "sky",
};

function CreatorRow({
  c,
  rank,
}: {
  c: Awaited<ReturnType<typeof getTopCreators>>[number];
  rank: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
      <span className="w-4 text-center text-xs tabular-nums text-zinc-600">{rank}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 truncate text-sm text-white">
          {c.flagged && <Flag className="h-3 w-3 shrink-0 text-amber-400" />}
          {c.handle}
        </p>
        <p className="truncate text-xs capitalize text-zinc-500">
          {c.platform} · {c.posts} post{c.posts === 1 ? "" : "s"}
          {c.tier === "tier1" && " · tier 1"}
        </p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-violet-300">
        {c.impactScore.toFixed(1)}
      </span>
    </div>
  );
}

export default async function CreatorsPage() {
  const [creators, posts] = await Promise.all([
    getTopCreators(40),
    sql`
      select po.id, po.platform, c.handle, c.impact_score, c.flagged, po.sentiment,
             po.signal, po.summary, po.caption, po.post_url, po.posted_at,
             po.content_source,
             coalesce(
               (
                 select json_agg(s.name)
                 from (
                   select p.name from products p
                   where p.product_id = any(po.mentioned_products)
                   limit 3
                 ) s
               ),
               '[]'::json
             ) as cards
      from posts po left join creators c on c.id = po.creator_id
      order by po.posted_at desc nulls last, po.id desc
      limit 40
    `,
  ]);

  const watchlist = creators.filter((c) => c.watchlisted);
  const discovered = creators.filter((c) => !c.watchlisted);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Creator intelligence</h1>
        <p className="mt-1 text-sm text-zinc-400">
          A curated watchlist of verified creators is scanned via Bright Data — videos transcribed,
          posts scored for sentiment by Featherless, and ranked by measured market impact. 🚩 = flagged
          market mover.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Leaderboards */}
        <div className="space-y-6">
          <Card className="h-fit p-4">
            <SectionTitle
              title="Watchlist"
              subtitle="Verified, monitored accounts"
              right={<Radar className="h-4 w-4 text-violet-300" />}
            />
            <div className="space-y-1">
              {watchlist.length === 0 ? (
                <p className="px-2 py-2 text-xs text-zinc-500">
                  No watchlist creators yet. Run the watchlist scan to populate.
                </p>
              ) : (
                watchlist.map((c, i) => <CreatorRow key={c.id} c={c} rank={i + 1} />)
              )}
            </div>
          </Card>

          {discovered.length > 0 && (
            <Card className="h-fit p-4">
              <SectionTitle title="Discovered" subtitle="Surfaced via topic search" />
              <div className="space-y-1">
                {discovered.map((c, i) => (
                  <CreatorRow key={c.id} c={c} rank={i + 1} />
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Post feed */}
        <Card className="p-4">
          <SectionTitle title="Recent creator activity" subtitle="Newest first · sentiment-scored" />
          <div className="space-y-2">
            {posts.map((p) => {
              const cards = Array.isArray(p.cards) ? (p.cards as string[]) : [];
              const sentiment = p.sentiment as string;
              const contentSource = p.content_source as string | null;
              const fromVideo = contentSource === "transcript" || contentSource === "both";
              return (
                <a
                  key={p.id as number}
                  href={(p.post_url as string) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg border border-white/5 bg-zinc-900/40 p-3 transition hover:border-white/10"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <Badge tone={PLATFORM_TONE[p.platform as string] ?? "neutral"}>
                      {p.platform as string}
                    </Badge>
                    <span className="text-zinc-400">{(p.handle as string) ?? "—"}</span>
                    <span
                      className={
                        sentiment === "bullish"
                          ? "text-emerald-400"
                          : sentiment === "bearish"
                            ? "text-rose-400"
                            : "text-zinc-500"
                      }
                    >
                      ● {sentiment}
                    </span>
                    <span className="uppercase text-zinc-500">{p.signal as string}</span>
                    {fromVideo && (
                      <Badge tone="sky">
                        <Video className="h-3 w-3" /> transcript
                      </Badge>
                    )}
                    {p.flagged && <span>🚩</span>}
                    {p.posted_at != null && (
                      <LocalTime
                        value={new Date(p.posted_at as string).toISOString()}
                        mode="relative"
                        className="ml-auto text-zinc-600"
                      />
                    )}
                    <ExternalLink className={`h-3 w-3 text-zinc-600 ${p.posted_at ? "" : "ml-auto"}`} />
                  </div>
                  <p className="mt-1.5 text-sm text-zinc-200">
                    {(p.summary as string) || (p.caption as string) || "—"}
                  </p>
                  {cards.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {cards.map((name, idx) => (
                        <span
                          key={idx}
                          className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-400"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
