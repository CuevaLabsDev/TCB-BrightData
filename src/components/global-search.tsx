"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { formatCurrency, formatPercent, changeColor } from "@/lib/utils";

interface Result {
  productId: number;
  subType: string;
  name: string;
  setName: string | null;
  market: number | null;
  chg30d: number | null;
}

export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const query = q.trim();

  useEffect(() => {
    if (query.length < 2) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data.results ?? []);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function go(r: Result) {
    setOpen(false);
    setQ("");
    router.push(`/card/${r.productId}?sub=${encodeURIComponent(r.subType)}`);
  }

  function updateQuery(value: string) {
    setQ(value);
    if (value.trim().length < 2) {
      setResults([]);
      setOpen(false);
      setLoading(false);
    }
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-xs">
      <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3">
        {loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-subtle" />
        ) : (
          <Search className="size-4 shrink-0 text-subtle" />
        )}
        <input
          value={q}
          onChange={(e) => updateQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          placeholder="Search 32k cards…"
          className="w-full bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
        />
      </div>

      {open && results.length > 0 && (
        <div className="absolute right-0 z-50 mt-2 max-h-96 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border bg-panel shadow-2xl">
          {results.map((r) => (
            <button
              key={`${r.productId}-${r.subType}`}
              onClick={() => go(r)}
              className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2.5 text-left transition last:border-0 hover:bg-panel-strong"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{r.name}</p>
                <p className="truncate text-xs text-subtle">
                  {r.setName ?? "—"} · {r.subType}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm tabular-nums text-foreground">{formatCurrency(r.market)}</p>
                <p className={`text-xs tabular-nums ${changeColor(r.chg30d)}`}>
                  {formatPercent(r.chg30d)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
