"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Zap } from "lucide-react";

type LiquidityPayload = {
  score?: number | null;
  activeListings?: number | null;
  sellers?: number | null;
  weeklyQtySold?: number | null;
  soldPerDay?: number | null;
  bidAskSpreadPct?: number | null;
};

type GradedPayload = {
  grade: number;
  market?: number | null;
  median?: number | null;
  sampleSize?: number | null;
  gradeMultiple?: number | null;
  soldPerDay?: number | null;
  soldPerMonth?: number | null;
};

export function RefreshLiveButton({ productId, subType }: { productId: number; subType: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setMsg(null);
    let liquidityScore: number | null | undefined;
    let gradedCount = 0;
    let gradedError: string | null = null;

    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Force live TCG liquidity + live PSA-10 sold comps (paginated).
        body: JSON.stringify({
          productId,
          subType,
          force: true,
          forceGraded: true,
          grades: [10],
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg(data?.error ?? "Refresh failed");
        return;
      }

      if (!res.body) {
        setMsg("Refresh failed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: {
            type?: string;
            error?: string;
            liquidity?: LiquidityPayload;
            graded?: GradedPayload[];
          };
          try {
            event = JSON.parse(trimmed) as typeof event;
          } catch {
            continue;
          }

          if (event.type === "error") {
            setMsg(event.error ?? "Refresh failed");
            return;
          }

          if (event.type === "liquidity" && event.liquidity) {
            liquidityScore = event.liquidity.score;
            setMsg(`Live: liquidity ${liquidityScore ?? "—"}…`);
            router.refresh();
          }

          if (event.type === "graded") {
            if (event.error) gradedError = event.error;
            const withComps = (event.graded ?? []).filter((g) => (g.sampleSize ?? 0) > 0);
            gradedCount = withComps.length;
            if (gradedError) {
              setMsg(
                `Liquidity ${liquidityScore ?? "—"} — PSA scrape failed: ${gradedError}`,
              );
            } else {
              setMsg(
                `Live: liquidity ${liquidityScore ?? "—"}, ${gradedCount} graded comps`,
              );
            }
            router.refresh();
          }

          if (event.type === "done") {
            if (gradedError) {
              setMsg(
                `Liquidity ${liquidityScore ?? "—"} ok — PSA scrape timed out or failed, retry`,
              );
            } else {
              setMsg(
                `Live: liquidity ${liquidityScore ?? "—"}, ${gradedCount} graded comps`,
              );
            }
          }
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={refresh}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/20 disabled:opacity-50"
      >
        {loading ? <RefreshCw className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
        {loading ? "Scanning live…" : "Refresh live (Bright Data)"}
      </button>
      {msg && <span className="text-xs text-subtle">{msg}</span>}
    </div>
  );
}
