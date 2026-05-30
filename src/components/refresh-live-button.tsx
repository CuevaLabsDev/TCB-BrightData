"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Zap } from "lucide-react";

export function RefreshLiveButton({ productId, subType }: { productId: number; subType: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, subType }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Refresh failed");
      } else {
        setMsg(
          `Live: liquidity ${data.liquidity?.score ?? "—"}, ${data.graded?.length ?? 0} graded comps`,
        );
        router.refresh();
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
