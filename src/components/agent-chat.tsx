"use client";

import { Bot, Loader2, Send, Sparkles, User, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { MarkdownMessage } from "@/components/markdown-message";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  { role: "Grading ops", text: "Should I submit Umbreon ex 161 to PSA 10? Show the multiple and liquidity." },
  { role: "Dealer", text: "What are the top 30-day gainers I should be repricing right now?" },
  { role: "Analyst", text: "What's happening in the Pokémon card market overall?" },
  { role: "Marketplace seller", text: "How liquid is Mega Charizard X ex and who's posting about it?" },
];

const TOOL_LABEL: Record<string, string> = {
  search_catalog: "Searched catalog",
  get_price_analytics: "Pulled price analytics",
  get_top_movers: "Scanned top movers",
  get_grade_arbitrage: "Checked raw→PSA arbitrage",
  get_liquidity: "Measured liquidity",
  get_creator_sentiment: "Read creator sentiment",
  recall_market_memory: "Recalled market memory",
  refresh_live_intel: "Live Bright Data scan",
};

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolsUsed?: string[];
}

export function AgentChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  function scrollDown() {
    setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }), 50);
  }

  async function submit(text: string) {
    if (!text.trim() || busy) return;
    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setBusy(true);
    scrollDown();

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({
            id: m.id,
            role: m.role,
            parts: [{ type: "text", text: m.text }],
          })),
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: data.error ? `Error: ${data.error}` : data.text || "(no response)",
          toolsUsed: data.toolsUsed,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", text: `Error: ${e instanceof Error ? e.message : "request failed"}` },
      ]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  return (
    <div className="card-surface flex h-[calc(100vh-9rem)] flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-accent">
          <Sparkles className="size-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">TCB Market Analyst</p>
          <p className="text-[11px] text-subtle">Price · grades · liquidity · creators · market memory</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Ask about cards, sets, liquidity, grading spreads, creator sentiment, or market memory.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  onClick={() => submit(s.text)}
                  className="rounded-md border border-border bg-panel px-3 py-2.5 text-left transition hover:border-accent/30 hover:bg-panel-strong"
                >
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-accent">
                    {s.role}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={cn("flex gap-3", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "assistant" && (
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                <Bot className="size-4" />
              </div>
            )}
            <div
              className={cn(
                "flex max-w-[85%] flex-col gap-2 rounded-lg px-4 py-2.5 text-sm leading-relaxed",
                m.role === "user" ? "bg-accent text-accent-foreground" : "bg-panel text-foreground",
              )}
            >
              {m.toolsUsed && m.toolsUsed.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {m.toolsUsed.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent"
                    >
                      <Wrench className="size-3" />
                      {TOOL_LABEL[t] ?? t}
                    </span>
                  ))}
                </div>
              )}
              {m.role === "assistant" ? (
                <MarkdownMessage content={m.text} />
              ) : (
                <p className="whitespace-pre-wrap">{m.text}</p>
              )}
            </div>
            {m.role === "user" && (
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-panel-strong text-muted">
                <User className="size-4" />
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-sm text-subtle">
            <Loader2 className="size-4 animate-spin" /> Querying live data layers…
          </div>
        )}
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about a card, set, or the market…"
            className="flex-1 rounded-md border border-border bg-panel px-4 py-2.5 text-sm text-foreground placeholder:text-subtle focus:border-accent/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground transition hover:bg-accent/90 disabled:opacity-50"
          >
            <Send className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
