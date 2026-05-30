"""Market-memory builder — the agent's learned domain experience.

Reads real market events from the warehouse (movers, grade arbitrage, liquidity,
creator-driven moves), feeds them to cognee (Featherless LLM + local fastembed)
to build a knowledge graph, then writes narrative memories with embeddings into
our own `market_memory` table for the agent + UI to recall.

cognee is configured purely via env (.env.local), per the cognee-quickstart skill:
  LLM_PROVIDER/LLM_MODEL/LLM_ENDPOINT/LLM_API_KEY + EMBEDDING_PROVIDER/MODEL/DIMENSIONS
  COGNEE_SKIP_CONNECTION_TEST=true, ENABLE_BACKEND_ACCESS_CONTROL=false, CACHING=false
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json

from .db import get_conn, load_env

load_env()  # must run before importing cognee so it reads our env

# fastembed is CPU-only and deterministic; import lazily for embedding reuse.


# ---------------------------------------------------------------------------
# 1. Gather market events (the raw experience)
# ---------------------------------------------------------------------------

def gather_events() -> dict:
    """Pull the notable market facts the agent should 'remember'."""
    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute("""
            select p.name, w.sub_type, g.name, w.market,
                   w.chg_30d_pct, w.chg_90d_pct, w.chg_180d_pct
            from price_windows w
            join products p on p.product_id = w.product_id
            left join groups g on g.group_id = p.group_id
            where not p.is_sealed and w.market >= 25 and w.data_points >= 60
              and w.chg_90d_pct is not null
            order by w.chg_90d_pct desc limit 12
        """)
        gainers = cur.fetchall()

        cur.execute("""
            select p.name, w.sub_type, g.name, w.market, w.chg_90d_pct
            from price_windows w
            join products p on p.product_id = w.product_id
            left join groups g on g.group_id = p.group_id
            where not p.is_sealed and w.market >= 25 and w.data_points >= 60
              and w.chg_90d_pct is not null
            order by w.chg_90d_pct asc limit 8
        """)
        losers = cur.fetchall()

        cur.execute("""
            select p.name, gc.raw_market, gc.avg_sold, gc.grade_multiple,
                   gc.sample_size, l.liquidity_score
            from graded_comps gc
            join products p on p.product_id = gc.product_id
            left join liquidity l on l.product_id = gc.product_id
            where gc.grade = 10 and gc.grade_multiple is not null
            order by gc.grade_multiple desc
        """)
        grade_arb = cur.fetchall()

        cur.execute("""
            select p.name, l.source, l.liquidity_score, l.sold_velocity,
                   l.active_listings, l.bid_ask_spread_pct
            from liquidity l join products p on p.product_id = l.product_id
            order by l.liquidity_score desc
        """)
        liquidity = cur.fetchall()

        cur.execute("""
            select c.platform, c.handle, c.impact_score, po.sentiment, po.signal,
                   po.summary, p.name
            from posts po
            join creators c on c.id = po.creator_id
            left join unnest(po.mentioned_products) as mp(pid) on true
            left join products p on p.product_id = mp.pid
            where po.summary is not null
            order by c.impact_score desc nulls last limit 15
        """)
        social = cur.fetchall()

    return {
        "gainers": gainers, "losers": losers, "grade_arb": grade_arb,
        "liquidity": liquidity, "social": social,
    }


def events_to_documents(ev: dict) -> list[tuple[str, str, str]]:
    """Turn events into (scope, title, narrative_text) documents for cognee."""
    docs: list[tuple[str, str, str]] = []
    today = dt.date.today().isoformat()

    if ev["gainers"]:
        lines = [
            f"{name} ({sub}) from {set_name or 'Unknown set'} is at ${float(mkt):.2f}, "
            f"up {chg90:.1f}% over 90 days ({chg30:.1f}% in 30d, {chg180 or 0:.1f}% in 180d)."
            for (name, sub, set_name, mkt, chg30, chg90, chg180) in ev["gainers"]
        ]
        docs.append((
            "market", "90-day market gainers",
            "Pokemon TCG raw-card market momentum as of " + today + ". Strongest 90-day "
            "appreciating singles:\n- " + "\n- ".join(lines),
        ))

    if ev["losers"]:
        lines = [
            f"{name} ({sub}) from {set_name or 'Unknown set'} fell {chg90:.1f}% over 90 days to ${float(mkt):.2f}."
            for (name, sub, set_name, mkt, chg90) in ev["losers"]
        ]
        docs.append((
            "market", "90-day market decliners",
            "Pokemon TCG cards losing value (90-day) as of " + today + ":\n- " + "\n- ".join(lines),
        ))

    if ev["grade_arb"]:
        lines = [
            f"{name}: raw ${float(raw or 0):.0f} vs PSA 10 ${float(avg or 0):.0f} "
            f"= {mult}x grade multiple (n={n} sold comps, liquidity {liq or 'n/a'})."
            for (name, raw, avg, mult, n, liq) in ev["grade_arb"]
        ]
        docs.append((
            "market", "Raw vs PSA 10 grade arbitrage",
            "Grade arbitrage signals — the multiple between raw Near Mint price and PSA 10 "
            "realized sold price. High multiple + high liquidity favors grading submission:\n- "
            + "\n- ".join(lines),
        ))

    if ev["liquidity"]:
        lines = [
            f"{name}: liquidity score {float(score or 0):.0f}/100 on {src}, "
            f"selling ~{float(vel or 0):.2f}/day, {act or 0} active listings, "
            f"bid/ask spread {spread if spread is not None else 'n/a'}%."
            for (name, src, score, vel, act, spread) in ev["liquidity"]
        ]
        docs.append((
            "market", "Liquidity landscape",
            "Marketplace liquidity for high-value cards (velocity, depth, spread):\n- "
            + "\n- ".join(lines),
        ))

    if ev["social"]:
        lines = [
            f"{platform}/{handle} (impact {float(impact or 0):.1f}) posted {sentiment}/{signal}"
            + (f" about {pname}" if pname else "") + (f": {summary}" if summary else "")
            for (platform, handle, impact, sentiment, signal, summary, pname) in ev["social"]
        ]
        docs.append((
            "market", "Creator sentiment & market influence",
            "Content-creator activity that moves the Pokemon card market. Creators with "
            "higher impact scores have mentions that precede larger price moves:\n- "
            + "\n- ".join(lines),
        ))

    return docs


# ---------------------------------------------------------------------------
# 2. cognee: build the knowledge graph + generate the market narrative
# ---------------------------------------------------------------------------

async def build_with_cognee(docs: list[tuple[str, str, str]]) -> str:
    import cognee
    from cognee import SearchType

    # Fresh graph each run (and handles embedding-dim changes per skill guidance).
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(metadata=True)

    for _scope, title, text in docs:
        await cognee.add(f"# {title}\n{text}", dataset_name="tcb_market")
    await cognee.cognify(datasets=["tcb_market"])

    narrative = await cognee.search(
        query_text=(
            "Summarize the current state of the Pokemon trading card market: which cards "
            "have momentum, where the best raw-to-PSA10 grade arbitrage is, what is liquid "
            "vs illiquid, and how creator sentiment is influencing prices. Be specific with "
            "card names and numbers."
        ),
        query_type=SearchType.GRAPH_COMPLETION,
    )
    if isinstance(narrative, list):
        return "\n".join(str(x) for x in narrative)
    return str(narrative)


# ---------------------------------------------------------------------------
# 3. Persist memories (with fastembed embeddings) to our market_memory table
# ---------------------------------------------------------------------------

_embedder = None


def embed(text: str) -> list[float]:
    global _embedder
    if _embedder is None:
        from fastembed import TextEmbedding
        _embedder = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    vec = next(iter(_embedder.embed([text])))
    return [float(x) for x in vec]


def persist_memories(
    docs: list[tuple[str, str, str]], cognee_narrative: str
) -> int:
    today = dt.date.today()
    p90 = today - dt.timedelta(days=90)
    rows = []

    # The cognee-generated synthesis is the headline "domain experience" memory.
    rows.append((
        "market", p90, today, "Market synthesis (cognee knowledge graph)",
        cognee_narrative, ["synthesis", "cognee"],
    ))
    # Plus each source document as a retrievable memory.
    for scope, title, text in docs:
        rows.append((scope, p90, today, title, text, [title.split()[0].lower()]))

    with get_conn() as conn:
        cur = conn.cursor()
        # Refresh only the cognee-synthesized rows; leave the incrementally
        # appended `social` memories (written by src/lib/memory/incremental.ts)
        # in place so live creator context survives a synthesis run.
        cur.execute(
            "delete from market_memory "
            "where scope = 'market' and (tags is null or not (tags @> array['social']))"
        )
        for (scope, ps, pe, title, narrative, tags) in rows:
            vec = embed(f"{title}\n{narrative}")
            cur.execute(
                """insert into market_memory
                     (scope, period_start, period_end, title, narrative, tags, embedding, metrics)
                   values (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (scope, ps, pe, title, narrative, tags,
                 "[" + ",".join(str(x) for x in vec) + "]",
                 json.dumps({"generated": today.isoformat()})),
            )
        conn.commit()
    return len(rows)


async def main_async() -> None:
    print("[memory] gathering market events...", flush=True)
    ev = gather_events()
    docs = events_to_documents(ev)
    print(f"[memory] {len(docs)} source documents; building cognee graph...", flush=True)
    narrative = await build_with_cognee(docs)
    print("[memory] cognee narrative:\n", narrative[:500], flush=True)
    n = persist_memories(docs, narrative)
    print(f"[memory] persisted {n} memories to market_memory.", flush=True)


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
