"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PricePoint } from "@/lib/types";
import { formatCurrency, parseCalendarDate } from "@/lib/utils";

export function PriceChart({ data, height = 280 }: { data: PricePoint[]; height?: number }) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-600">
        No price history available
      </div>
    );
  }

  const markets = data.map((d) => d.market ?? 0).filter((v) => v > 0);
  const min = Math.min(...markets);
  const max = Math.max(...markets);
  const pad = (max - min) * 0.08 || max * 0.05;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="mktFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fill: "#71717a", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(d: string) => {
            const dt = parseCalendarDate(d);
            return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          }}
        />
        <YAxis
          domain={[Math.max(0, min - pad), max + pad]}
          tick={{ fill: "#71717a", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) => formatCurrency(v, { cents: false })}
        />
        <Tooltip
          contentStyle={{
            background: "#18181b",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            fontSize: 12,
          }}
          labelStyle={{ color: "#a1a1aa" }}
          formatter={((value: unknown) => [formatCurrency(Number(value)), "Market"]) as never}
          labelFormatter={(d) =>
            parseCalendarDate(String(d)).toLocaleDateString(undefined, { dateStyle: "medium" })
          }
        />
        <Area
          type="monotone"
          dataKey="market"
          stroke="#a78bfa"
          strokeWidth={2}
          fill="url(#mktFill)"
          dot={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
