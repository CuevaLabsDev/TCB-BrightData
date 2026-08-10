"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ListingLadder } from "@/lib/types";
import { qtyToReachAsk } from "@/lib/listing-ladder";
import { formatCurrency, formatNumber } from "@/lib/utils";

export function ListingLadderPanel({
  ladder,
  market,
}: {
  ladder: ListingLadder;
  market: number | null;
}) {
  const defaultTarget = useMemo(() => {
    if (market && market > 0) return Math.round(market * 2 * 100) / 100;
    if (ladder.lowestLanded) return Math.round(ladder.lowestLanded * 2 * 100) / 100;
    return 8;
  }, [market, ladder.lowestLanded]);

  const [target, setTarget] = useState(String(defaultTarget));
  const targetNum = Number(target);

  const reach = useMemo(() => {
    if (!Number.isFinite(targetNum) || targetNum <= 0) {
      return { qty: 0, costUsd: 0, nextAsk: null as number | null };
    }
    return qtyToReachAsk(ladder.levels, targetNum);
  }, [ladder.levels, targetNum]);

  const chartData = useMemo(
    () =>
      ladder.levels.map((l) => ({
        landed: l.landed,
        cumQty: l.cumQty,
        cumCost: l.cumCost,
        qty: l.qty,
      })),
    [ladder.levels],
  );

  return (
    <div className="space-y-4 border-t border-white/5 pt-4">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-zinc-500">Ask book</p>
        <p className="mt-1 text-xs text-zinc-500">
          Landed ask = price + shipping (US). Buyout sums every fetched listing.
          {ladder.partial ? " Partial book — page-capped scrape." : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-white/5 bg-zinc-900/50 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Buyout</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">
            {formatCurrency(ladder.buyoutUsd)}
          </p>
          <p className="text-xs text-zinc-500">
            {formatNumber(ladder.buyoutQty)} units
            {ladder.partial ? " · approx" : ""}
          </p>
        </div>
        <div className="rounded-md border border-white/5 bg-zinc-900/50 p-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Ask range</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">
            {formatCurrency(ladder.lowestLanded)}–{formatCurrency(ladder.highestLanded)}
          </p>
          <p className="text-xs text-zinc-500">{ladder.listingRows} listing rows</p>
        </div>
      </div>

      {chartData.length > 1 && (
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis
                dataKey="landed"
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                dataKey="cumQty"
                tick={{ fill: "#71717a", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <Tooltip
                contentStyle={{
                  background: "#18181b",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value, name) => {
                  const v = Number(value);
                  if (name === "cumQty") return [formatNumber(v), "Units ≤ ask"];
                  if (name === "cumCost") return [formatCurrency(v), "Cost to clear"];
                  return [String(value), String(name)];
                }}
                labelFormatter={(label) => `Ask ${formatCurrency(Number(label))}`}
              />
              <Area
                type="stepAfter"
                dataKey="cumQty"
                stroke="#a78bfa"
                fill="rgba(167, 139, 250, 0.18)"
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="rounded-md border border-white/5 bg-zinc-900/40 p-3">
        <label className="flex flex-wrap items-end gap-3">
          <span className="min-w-0 flex-1">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              Qty to push ask to
            </span>
            <span className="mt-1 flex items-center gap-2">
              <span className="text-zinc-500">$</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-28 rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-sm tabular-nums text-zinc-100 outline-none focus:border-violet-500/50"
              />
            </span>
          </span>
          <span className="text-right text-sm">
            <span className="block font-semibold tabular-nums text-zinc-100">
              {formatNumber(reach.qty)} cards
            </span>
            <span className="block text-xs text-zinc-500">
              {formatCurrency(reach.costUsd)}
              {reach.nextAsk != null ? ` · next ask ${formatCurrency(reach.nextAsk)}` : " · clears book"}
            </span>
          </span>
        </label>
      </div>

      {ladder.gaps.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Price jumps</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {ladder.gaps.slice(0, 6).map((g) => (
              <div
                key={`${g.fromLanded}-${g.toLanded}`}
                className="flex items-center justify-between gap-3 rounded-md px-1 py-1 text-sm"
              >
                <div className="min-w-0">
                  <p className="tabular-nums text-zinc-200">
                    {formatCurrency(g.fromLanded)} → {formatCurrency(g.toLanded)}
                    <span className="ml-1.5 text-xs text-amber-300/90">
                      +{formatCurrency(g.gapUsd)} ({g.gapPct}%)
                    </span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    Buy {formatNumber(g.qtyToClear)} units ({formatCurrency(g.costToClear)}) to clear
                    into the jump
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
