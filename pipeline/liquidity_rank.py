"""Rank sets/cards and build a cost-capped liquidity scrape queue.

Uses free tcgcsv-backed price_windows (no Bright Data). Writes:
  * set_heat — per-set heat score 0–100
  * liquidity_scrape_queue — today's budgeted trend + spotlight targets

Run from the repo root:
  python -m pipeline.liquidity_rank
  python -m pipeline.liquidity_rank --trend-limit 500 --spotlight-limit 100 --top-sets 40
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from datetime import date, datetime, timezone

from .db import get_conn

# Catalog groups that eat budget without good spotlight UX.
JUNK_NAME_SUBSTR = (
    "world championship decks",
    "jumbo cards",
    "miscellaneous cards",
    "league & championship",
    "prize pack series",
)

MIN_MARKET = 2.0
CHG_ACTIVE_PCT = 8.0  # |7d| move counts as "active"


def _f(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _is_junk_set(name: str) -> bool:
    n = (name or "").lower()
    return any(s in n for s in JUNK_NAME_SUBSTR)


def _recency_score(published_on) -> float:
    """0–30: newer sets score higher. Unknown publish date → mid."""
    if published_on is None:
        return 12.0
    if isinstance(published_on, datetime):
        pub = published_on.date() if published_on.tzinfo is None else published_on.astimezone(timezone.utc).date()
    elif isinstance(published_on, date):
        pub = published_on
    else:
        return 12.0
    age_days = max(0, (datetime.now(timezone.utc).date() - pub).days)
    # Full score under ~180d; decays to ~0 by ~8 years.
    return max(0.0, 30.0 * math.exp(-age_days / 900.0))


def _card_activation_score(
    market: float,
    chg7: float | None,
    chg30: float | None,
    vol: float | None,
    liq_as_of,
    sold_velocity: float | None,
    active_listings: int | None,
    mention_boost: float,
) -> float:
    # Log market: $2→~0.7, $10→2.3, $50→3.9, $100→4.6 — scale into ~0–25.
    market_pts = min(25.0, max(0.0, math.log1p(market) * 5.5))
    move = 0.0
    if chg7 is not None:
        move += min(25.0, abs(chg7) * 0.9)
    if chg30 is not None:
        move += min(15.0, abs(chg30) * 0.25)
    vol_pts = min(10.0, (vol or 0.0) * 20.0)

    stale_pts = 20.0  # never scraped
    if liq_as_of is not None:
        if isinstance(liq_as_of, datetime):
            as_of = liq_as_of if liq_as_of.tzinfo else liq_as_of.replace(tzinfo=timezone.utc)
            age_h = (datetime.now(timezone.utc) - as_of.astimezone(timezone.utc)).total_seconds() / 3600.0
        else:
            age_h = 48.0
        if age_h >= 72:
            stale_pts = 18.0
        elif age_h >= 24:
            stale_pts = 12.0
        else:
            stale_pts = 2.0  # fresh — deprioritize

    # Prefer thin + moving books when we already have liquidity.
    thin_pts = 0.0
    if sold_velocity is not None and sold_velocity >= 0.3:
        thin_pts += min(8.0, sold_velocity * 4.0)
    if active_listings is not None and active_listings <= 25:
        thin_pts += min(7.0, (25 - active_listings) * 0.28)

    return round(market_pts + move + vol_pts + stale_pts + thin_pts + mention_boost, 2)


def _spotlight_score(
    activation: float,
    sold_velocity: float | None,
    active_listings: int | None,
    total_quantity: int | None,
    chg7: float | None,
) -> float:
    s = activation * 0.55
    if sold_velocity is not None:
        s += min(25.0, sold_velocity * 12.0)
    if active_listings is not None:
        s += min(20.0, max(0, 40 - active_listings) * 0.5)
    if total_quantity is None:
        s += 12.0  # need exact depth
    if chg7 is not None and abs(chg7) >= 10:
        s += min(15.0, abs(chg7) * 0.4)
    return round(s, 2)


def compute_rank(
    trend_limit: int = 500,
    spotlight_limit: int = 100,
    top_sets: int = 40,
    floor_per_set: int = 4,
    ceiling_per_set: int = 20,
) -> None:
    # UTC date — matches GHA runners and bulk-liquidity --queue-date default.
    today = datetime.now(timezone.utc).date()

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("set statement_timeout = 0;")

        # Optional social boost: reddit mentions last 7d.
        mention_boost: dict[int, float] = defaultdict(float)
        try:
            cur.execute(
                """
                select product_id, count(*)::int as n
                from reddit_mentions
                where created_at > now() - interval '7 days'
                group by product_id
                """
            )
            for pid, n in cur.fetchall():
                mention_boost[int(pid)] = min(10.0, float(n) * 1.5)
        except Exception:
            conn.rollback()
            cur.execute("set statement_timeout = 0;")

        cur.execute(
            """
            select g.group_id, g.name, g.published_on,
                   w.product_id, w.sub_type, w.market, w.chg_7d_pct, w.chg_30d_pct,
                   w.volatility_30d,
                   l.as_of as liq_as_of, l.sold_velocity, l.active_listings,
                   l.total_quantity
            from price_windows w
            join products p on p.product_id = w.product_id
            join groups g on g.group_id = p.group_id
            left join liquidity l
              on l.product_id = w.product_id
             and l.sub_type = w.sub_type
             and l.source = 'tcgplayer'
            where not p.is_sealed
              and w.market is not null
              and w.market >= %s
            """,
            (MIN_MARKET,),
        )
        rows = cur.fetchall()

    # group_id -> list of card dicts
    by_set: dict[int, list[dict]] = defaultdict(list)
    set_meta: dict[int, dict] = {}

    for (
        group_id,
        name,
        published_on,
        product_id,
        sub_type,
        market,
        chg7,
        chg30,
        vol,
        liq_as_of,
        sold_vel,
        active_listings,
        total_qty,
    ) in rows:
        gid = int(group_id)
        if gid not in set_meta:
            set_meta[gid] = {"name": name, "published_on": published_on, "junk": _is_junk_set(name)}
        mkt = float(market)
        c7 = _f(chg7)
        c30 = _f(chg30)
        v = _f(vol)
        sv = _f(sold_vel)
        al = int(active_listings) if active_listings is not None else None
        tq = int(total_qty) if total_qty is not None else None
        act = _card_activation_score(
            mkt, c7, c30, v, liq_as_of, sv, al, mention_boost.get(int(product_id), 0.0)
        )
        by_set[gid].append(
            {
                "product_id": int(product_id),
                "sub_type": str(sub_type),
                "group_id": gid,
                "market": mkt,
                "chg7": c7,
                "chg30": c30,
                "activation": act,
                "spotlight": _spotlight_score(act, sv, al, tq, c7),
                "sold_velocity": sv,
                "active_listings": al,
                "total_quantity": tq,
            }
        )

    # --- set heat ---
    heat_rows: list[tuple] = []
    for gid, cards in by_set.items():
        meta = set_meta[gid]
        n = len(cards)
        if n == 0:
            continue
        active = sum(1 for c in cards if c["chg7"] is not None and abs(c["chg7"]) >= CHG_ACTIVE_PCT)
        active_share = active / n
        value_ge5 = sum(1 for c in cards if c["market"] >= 5)
        top20 = sorted((c["market"] for c in cards), reverse=True)[:20]
        top20_sum = sum(top20)
        avg_vol = sum(c["chg7"] is not None and abs(c["chg7"]) or 0 for c in cards) / n

        recency = _recency_score(meta["published_on"])
        activity = min(35.0, active_share * 70.0 + min(10.0, avg_vol * 0.15))
        value = min(35.0, math.log1p(value_ge5) * 8.0 + math.log1p(top20_sum) * 2.5)
        heat = recency + activity + value
        if meta["junk"]:
            heat *= 0.15  # hard down-rank
        heat = round(min(100.0, heat), 2)
        metrics = {
            "series": n,
            "active_share": round(active_share, 4),
            "value_ge5": value_ge5,
            "top20_market_sum": round(top20_sum, 2),
            "recency": round(recency, 2),
            "activity": round(activity, 2),
            "value": round(value, 2),
            "junk": meta["junk"],
            "name": meta["name"],
        }
        heat_rows.append((gid, today, heat, json.dumps(metrics)))

    heat_rows.sort(key=lambda r: r[2], reverse=True)

    # --- allocate trend slots ---
    eligible_sets = [r for r in heat_rows if r[2] > 0][:top_sets]
    heat_sum = sum(r[2] for r in eligible_sets) or 1.0

    # Proportional with floor/ceiling, then renormalize leftovers.
    raw_alloc: dict[int, int] = {}
    for gid, _as_of, heat, _m in eligible_sets:
        slots = int(round(trend_limit * (heat / heat_sum)))
        slots = max(floor_per_set, min(ceiling_per_set, slots))
        raw_alloc[gid] = slots

    # Shrink/grow to hit trend_limit.
    total = sum(raw_alloc.values())
    if total > trend_limit:
        # Peel from highest allocations first.
        order = sorted(raw_alloc.keys(), key=lambda g: raw_alloc[g], reverse=True)
        i = 0
        while total > trend_limit and order:
            g = order[i % len(order)]
            if raw_alloc[g] > floor_per_set:
                raw_alloc[g] -= 1
                total -= 1
            i += 1
            if i > trend_limit * 4:
                break
    elif total < trend_limit:
        order = sorted(raw_alloc.keys(), key=lambda g: set_meta[g] and next(h for h in heat_rows if h[0] == g)[2], reverse=True)
        i = 0
        while total < trend_limit and order:
            g = order[i % len(order)]
            if raw_alloc[g] < ceiling_per_set:
                raw_alloc[g] += 1
                total += 1
            i += 1
            if i > trend_limit * 4:
                break

    trend_picked: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for gid, slots in sorted(raw_alloc.items(), key=lambda kv: -next(h[2] for h in heat_rows if h[0] == kv[0])):
        cards = sorted(by_set.get(gid, []), key=lambda c: c["activation"], reverse=True)
        for c in cards[:slots]:
            key = (c["product_id"], c["sub_type"])
            if key in seen:
                continue
            seen.add(key)
            trend_picked.append(c)

    # Fill remaining trend budget with global next-best.
    if len(trend_picked) < trend_limit:
        global_cards = []
        for cards in by_set.values():
            global_cards.extend(cards)
        global_cards.sort(key=lambda c: c["activation"], reverse=True)
        for c in global_cards:
            if len(trend_picked) >= trend_limit:
                break
            key = (c["product_id"], c["sub_type"])
            if key in seen:
                continue
            # Prefer non-junk for filler.
            if set_meta[c["group_id"]]["junk"]:
                continue
            seen.add(key)
            trend_picked.append(c)

    trend_picked = trend_picked[:trend_limit]

    # Spotlight: top N by spotlight score from trend pool + other hot movers.
    spotlight_pool = list(trend_picked)
    extra = []
    for cards in by_set.values():
        for c in cards:
            key = (c["product_id"], c["sub_type"])
            if key not in seen and not set_meta[c["group_id"]]["junk"]:
                extra.append(c)
    extra.sort(key=lambda c: c["spotlight"], reverse=True)
    spotlight_pool.extend(extra[: spotlight_limit * 2])
    spotlight_pool.sort(key=lambda c: c["spotlight"], reverse=True)

    spotlight_picked: list[dict] = []
    spot_seen: set[tuple[int, str]] = set()
    for c in spotlight_pool:
        key = (c["product_id"], c["sub_type"])
        if key in spot_seen:
            continue
        spot_seen.add(key)
        spotlight_picked.append(c)
        if len(spotlight_picked) >= spotlight_limit:
            break

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("set statement_timeout = 0;")
        cur.executemany(
            """
            insert into set_heat (group_id, as_of, heat_score, metrics)
            values (%s, %s, %s, %s::jsonb)
            on conflict (group_id) do update set
              as_of = excluded.as_of,
              heat_score = excluded.heat_score,
              metrics = excluded.metrics
            """,
            heat_rows,
        )

        # Replace today's queue (idempotent re-rank).
        cur.execute("delete from liquidity_scrape_queue where queued_for = %s", (today,))

        queue_rows = []
        for c in trend_picked:
            queue_rows.append(
                (
                    c["product_id"],
                    c["sub_type"],
                    "trend",
                    c["activation"],
                    c["group_id"],
                    today,
                    "pending",
                )
            )
        for c in spotlight_picked:
            queue_rows.append(
                (
                    c["product_id"],
                    c["sub_type"],
                    "spotlight",
                    c["spotlight"],
                    c["group_id"],
                    today,
                    "pending",
                )
            )

        cur.executemany(
            """
            insert into liquidity_scrape_queue
              (product_id, sub_type, tier, score, group_id, queued_for, status)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (product_id, sub_type, tier, queued_for) do update set
              score = excluded.score,
              group_id = excluded.group_id,
              status = 'pending'
            """,
            queue_rows,
        )

        detail = {
            "queued_for": today.isoformat(),
            "sets_ranked": len(heat_rows),
            "top_sets": len(eligible_sets),
            "trend": len(trend_picked),
            "spotlight": len(spotlight_picked),
            "trend_limit": trend_limit,
            "spotlight_limit": spotlight_limit,
            "top_heat": [
                {"group_id": r[0], "heat": r[2], "name": json.loads(r[3]).get("name")}
                for r in heat_rows[:10]
            ],
        }
        cur.execute(
            """
            insert into ingest_runs (kind, finished_at, status, rows, detail)
            values ('liquidity_rank', now(), 'ok', %s, %s::jsonb)
            """,
            (len(queue_rows), json.dumps(detail)),
        )

    print(
        f"[liquidity_rank] sets={len(heat_rows)} top_sets={len(eligible_sets)} "
        f"trend={len(trend_picked)} spotlight={len(spotlight_picked)} day={today}",
        flush=True,
    )
    for r in heat_rows[:8]:
        meta = json.loads(r[3])
        print(f"  heat={r[2]:5.1f}  {meta.get('name')}  series={meta.get('series')}", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description="Build set-ranked liquidity scrape queue")
    p.add_argument("--trend-limit", type=int, default=500)
    p.add_argument("--spotlight-limit", type=int, default=100)
    p.add_argument("--top-sets", type=int, default=40)
    p.add_argument("--floor-per-set", type=int, default=4)
    p.add_argument("--ceiling-per-set", type=int, default=20)
    args = p.parse_args()
    compute_rank(
        trend_limit=args.trend_limit,
        spotlight_limit=args.spotlight_limit,
        top_sets=args.top_sets,
        floor_per_set=args.floor_per_set,
        ceiling_per_set=args.ceiling_per_set,
    )


if __name__ == "__main__":
    main()
