"""Reddit social -> price lead/lag correlation.

The hypothesis engine. Reads `reddit_mentions` (written by scripts/ingest-reddit.mjs),
rolls them into a per-card-per-day social aggregate, finds each card's social
"spike" days, and measures what price did AFTER the spike (the lag) on both
TCGplayer (`daily_prices`) and eBay realized sold (`ebay_sold_daily`). Writes
`reddit_card_daily` + `social_price_corr` and prints a ranked findings report —
the evidence for "can social move the market" before the move shows up in price.

Only events with forward price coverage are scored: the local tcgcsv archive
(daily_prices) ends well before today, so a spike needs >=1 trading day of
forward data within the window to be measurable.

Run:  pipeline/.venv/bin/python -m pipeline.reddit_corr
"""
from __future__ import annotations

import datetime as dt
import json
import statistics
from collections import defaultdict

from .db import get_conn

# A spike day = social_z >= Z_THRESH, OR a hard floor of mentions for cards with
# too little history to form a stable baseline.
Z_THRESH = 1.5
MIN_MENTIONS_SPIKE = 3
FORWARD_DAYS = (1, 3, 7)


def _pct(now, past):
    if now is None or past is None or float(past) <= 0:
        return None
    return round((float(now) - float(past)) / float(past) * 100, 2)


def _nearest_on_or_before(series: dict[dt.date, float], target: dt.date):
    best = None
    for d, v in series.items():
        if d <= target and v is not None and (best is None or d > best[0]):
            best = (d, v)
    return best[1] if best else None


def _nearest_on_or_after(series: dict[dt.date, float], target: dt.date):
    best = None
    for d, v in series.items():
        if d >= target and v is not None and (best is None or d < best[0]):
            best = (d, v)
    return best[1] if best else None


def build_card_daily(cur) -> None:
    """(Re)build reddit_card_daily from reddit_mentions."""
    cur.execute("truncate table reddit_card_daily")
    cur.execute(
        """
        insert into reddit_card_daily
          (product_id, day, mention_count, comment_mentions, total_score,
           distinct_authors, bullish_ratio, weighted_score)
        select
          m.product_id,
          m.mentioned_on as day,
          count(*) as mention_count,
          count(*) filter (where m.source_type = 'comment') as comment_mentions,
          coalesce(sum(greatest(m.score, 0)), 0) as total_score,
          count(distinct coalesce(rc.author, rt.author)) as distinct_authors,
          round(avg((m.sentiment = 'bullish')::int)::numeric, 3) as bullish_ratio,
          -- engagement-weighted: each mention worth 1 + log10(1+upvotes)
          round(sum(1 + log(10, 1 + greatest(m.score, 0)))::numeric, 2) as weighted_score
        from reddit_mentions m
        left join reddit_comments rc on rc.comment_id = m.source_id and m.source_type = 'comment'
        left join reddit_threads  rt on rt.thread_id  = m.source_id and m.source_type = 'thread'
        group by m.product_id, m.mentioned_on
        """
    )


def load_price_series(cur, product_id: int) -> dict[dt.date, float]:
    """Daily TCGplayer market for a product, using its most-populated sub_type
    (daily_prices often keys chase cards under 'Normal' even when price_windows
    labels them 'Holofoil')."""
    cur.execute(
        """
        with picked as (
          select sub_type from daily_prices where product_id = %s
          group by sub_type order by count(*) desc limit 1
        )
        select dp.date, dp.market
        from daily_prices dp, picked
        where dp.product_id = %s and dp.sub_type = picked.sub_type and dp.market is not null
        """,
        (product_id, product_id),
    )
    return {r[0]: float(r[1]) for r in cur.fetchall()}


def load_ebay_series(cur, product_id: int) -> dict[dt.date, float]:
    cur.execute(
        "select sold_date, median_price from ebay_sold_daily "
        "where product_id = %s and median_price is not null",
        (product_id,),
    )
    return {r[0]: float(r[1]) for r in cur.fetchall()}


def correlate() -> dict:
    with get_conn() as conn:
        cur = conn.cursor()
        build_card_daily(cur)

        cur.execute("select max(date) from daily_prices")
        max_price_date = cur.fetchone()[0]
        if max_price_date is None:
            print("[corr] no daily_prices — nothing to correlate.")
            return {"events": 0}

        # Per-card daily social series
        cur.execute(
            "select product_id, day, mention_count, weighted_score, bullish_ratio "
            "from reddit_card_daily order by product_id, day"
        )
        by_card: dict[int, list] = defaultdict(list)
        for pid, day, mc, ws, br in cur.fetchall():
            by_card[pid].append((day, int(mc), float(ws or 0), float(br) if br is not None else None))

        cur.execute("delete from social_price_corr")
        events = []
        for pid, rows in by_card.items():
            scores = [r[2] for r in rows]
            mean = statistics.fmean(scores) if scores else 0.0
            std = statistics.pstdev(scores) if len(scores) > 1 else 0.0
            price = load_price_series(cur, pid)
            ebay = load_ebay_series(cur, pid)
            if not price:
                continue

            for day, mc, ws, br in rows:
                z = (ws - mean) / std if std > 0 else (0.0 if mc < MIN_MENTIONS_SPIKE else 3.0)
                is_spike = z >= Z_THRESH or mc >= MIN_MENTIONS_SPIKE
                if not is_spike:
                    continue
                # forward price coverage required
                if day >= max_price_date:
                    continue
                base = _nearest_on_or_before(price, day)
                if base is None:
                    continue
                fwd = {}
                for n in FORWARD_DAYS:
                    fwd[n] = _pct(_nearest_on_or_before(price, day + dt.timedelta(days=n)), base)
                ebay_base = _nearest_on_or_before(ebay, day) or _nearest_on_or_after(ebay, day)
                ebay_fwd = _nearest_on_or_before(ebay, day + dt.timedelta(days=7))
                ebay_chg = _pct(ebay_fwd, ebay_base) if ebay_base else None

                chg7 = fwd.get(7)
                preceded = (chg7 is not None and chg7 > 0)
                strength = round((chg7 or 0) * max(z, 0.0), 3)
                events.append(
                    (pid, day, ws, round(z, 3), fwd.get(1), fwd.get(3), chg7,
                     ebay_chg, preceded, strength)
                )

        for e in events:
            cur.execute(
                """insert into social_price_corr
                     (product_id, event_date, social_score, social_z, tcg_chg_1d,
                      tcg_chg_3d, tcg_chg_7d, ebay_chg_7d, preceded, corr_strength)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (product_id, event_date) do update set
                     social_score=excluded.social_score, social_z=excluded.social_z,
                     tcg_chg_1d=excluded.tcg_chg_1d, tcg_chg_3d=excluded.tcg_chg_3d,
                     tcg_chg_7d=excluded.tcg_chg_7d, ebay_chg_7d=excluded.ebay_chg_7d,
                     preceded=excluded.preceded, corr_strength=excluded.corr_strength""",
                e,
            )

        # attach the loudest thread URL per event (best-effort context)
        cur.execute(
            """
            update social_price_corr s set top_thread_url = t.url
            from (
              select distinct on (m.product_id, m.mentioned_on)
                     m.product_id, m.mentioned_on, rt.url
              from reddit_mentions m
              join reddit_threads rt on rt.thread_id = m.source_id and m.source_type = 'thread'
              order by m.product_id, m.mentioned_on, rt.score desc nulls last
            ) t
            where s.product_id = t.product_id and s.event_date = t.mentioned_on
            """
        )

        cur.execute(
            "insert into ingest_runs (kind, finished_at, status, rows, detail) "
            "values ('reddit_corr', now(), 'ok', %s, %s)",
            (len(events), json.dumps({"max_price_date": str(max_price_date),
                                      "cards": len(by_card)})),
        )
        conn.commit()
        report(cur, max_price_date, len(events))
        return {"events": len(events), "cards": len(by_card)}


def report(cur, max_price_date, n_events) -> None:
    print(f"\n=== Reddit social -> price findings (price data ends {max_price_date}) ===")
    print(f"scored {n_events} spike events with forward price coverage\n")
    if n_events == 0:
        print("No measurable events. Most Reddit mentions are NEWER than the price")
        print("archive end date, so there is no forward price to correlate yet.")
        print("Backfill Reddit further (node scripts/ingest-reddit.mjs --days 60)")
        print("and/or refresh daily_prices archives past today for a full proof.")
        return

    cur.execute(
        """
        select p.name, s.event_date, s.social_z, s.tcg_chg_1d, s.tcg_chg_3d,
               s.tcg_chg_7d, s.ebay_chg_7d, s.preceded, s.top_thread_url
        from social_price_corr s join products p on p.product_id = s.product_id
        order by s.corr_strength desc nulls last limit 20
        """
    )
    print(f"{'card':36s} {'date':10s} {'z':>5s} {'1d%':>7s} {'3d%':>7s} {'7d%':>7s} {'ebay7d%':>8s}  led")
    for name, d, z, c1, c3, c7, eb, pre, url in cur.fetchall():
        def f(x):
            return f"{float(x):+.1f}" if x is not None else "   -"
        print(f"{(name or '')[:36]:36s} {str(d):10s} {float(z or 0):5.1f} "
              f"{f(c1):>7s} {f(c3):>7s} {f(c7):>7s} {f(eb):>8s}  {'YES' if pre else 'no'}")

    cur.execute(
        """
        select p.name, count(*) n,
               round(avg((s.preceded)::int)::numeric, 2) hit_rate,
               round(avg(s.tcg_chg_7d)::numeric, 1) avg_fwd_7d
        from social_price_corr s join products p on p.product_id = s.product_id
        group by p.name having count(*) >= 1
        order by hit_rate desc, n desc limit 15
        """
    )
    print(f"\n=== per-card hit-rate (spike preceded a 7d rise) ===")
    print(f"{'card':36s} {'events':>7s} {'hit_rate':>9s} {'avg_fwd_7d%':>12s}")
    for name, n, hit, avg in cur.fetchall():
        print(f"{(name or '')[:36]:36s} {n:7d} {float(hit or 0):9.2f} {float(avg or 0):12.1f}")


if __name__ == "__main__":
    correlate()
