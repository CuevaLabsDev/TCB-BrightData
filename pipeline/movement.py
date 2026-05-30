"""Movement-quality precompute -> price_windows.movement_* columns.

TCGplayer "market" is listing-derived, so a rising market may be real demand
or "price parking" (a seller re-listing high with no sales). This step scores
every tracked series with the same robust math used by the Next.js agent tool
(`src/lib/price-intelligence/movement.ts`) so the warehouse can be filtered on
movement quality and the watcher can suppress parked breakouts.

This batch pass uses listing signals (robust-z on the daily market series,
market-vs-lowest-ask gap, 30d-trend coherence) plus stored TCGplayer liquidity.
Creator and eBay-sold-comp context are sparse and are layered in live by the
agent tool, not here.

Run from the repo root:  python -m pipeline.movement
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict

from .db import get_conn

MAD_SCALE = 0.6745
HISTORY_DAYS = 90


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def _mad(values: list[float]) -> float:
    if not values:
        return 0.0
    med = _median(values)
    return _median([abs(v - med) for v in values])


def _robust_z_latest(history: list[float], latest: float) -> float | None:
    """Robust z-score of `latest` against history+latest (median + MAD)."""
    series = history + [latest]
    if len(series) < 6:  # need >= 5 history points
        return None
    scale = _mad(series)
    if scale == 0:
        return 0.0
    med = _median(series)
    return MAD_SCALE * (latest - med) / scale


def assess(
    market_history: list[float],
    latest_market: float | None,
    latest_low: float | None,
    chg_7d_pct: float | None,
    avg_market_30d: float | None,
    sold_velocity: float | None,
    liquidity_score: float | None,
    bid_ask_spread_pct: float | None,
) -> tuple[str, float, list[str]]:
    """Mirror of detectMovementSignals() in movement.ts (listing + liquidity)."""
    codes: list[str] = []
    parking = 0
    justified = 0

    history = [v for v in market_history if v and v > 0]
    moving = chg_7d_pct is not None and abs(chg_7d_pct) > 12

    latest_z: float | None = None
    if latest_market is not None and len(history) >= 5:
        latest_z = _robust_z_latest(history, latest_market)
        if latest_z is not None and latest_z > 3.5:
            codes.append("spike_detected")
            parking += 2
        elif latest_z is not None and latest_z < -3.5:
            codes.append("crash_detected")
            parking += 2

    if latest_market is not None and latest_low and latest_low > 0:
        if latest_market > latest_low * 1.15:
            codes.append("market_low_divergence")
            parking += 2

    if bid_ask_spread_pct is not None and bid_ask_spread_pct < -15:
        codes.append("market_above_live_ask")
        parking += 2

    if moving and sold_velocity is not None and sold_velocity < 0.1:
        codes.append("move_without_volume")
        parking += 2

    if (
        liquidity_score is not None
        and liquidity_score < 25
        and (moving or (latest_z is not None and abs(latest_z) > 3.5))
    ):
        codes.append("thin_market")
        parking += 1

    if moving and latest_market is not None and avg_market_30d and avg_market_30d > 0:
        avg_gap_pct = (latest_market - avg_market_30d) / avg_market_30d * 100
        if abs(avg_gap_pct) > 15:
            codes.append("move_without_trend")
            parking += 1

    if sold_velocity is not None and sold_velocity >= 0.5:
        codes.append("healthy_velocity")
        justified += 1

    net = parking - justified
    if net >= 4:
        verdict = "likely_parking"
    elif net >= 2:
        verdict = "suspicious"
    elif justified > 0 and parking <= 1:
        verdict = "justified"
    else:
        verdict = "mixed"

    confidence = 0.4
    if len(history) >= 30:
        confidence += 0.2
    if sold_velocity is not None or liquidity_score is not None:
        confidence += 0.2
    confidence = round(min(1.0, max(0.0, confidence)), 3)

    return verdict, confidence, codes


def _fetch_liquidity(conn) -> dict[tuple[int, str], dict]:
    """Latest TCGplayer-preferred liquidity per (product, sub_type)."""
    out: dict[tuple[int, str], dict] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            select product_id, sub_type, source, sold_velocity,
                   liquidity_score, bid_ask_spread_pct
            from liquidity
            order by product_id, sub_type,
                     (source = 'tcgplayer') desc, as_of desc
            """
        )
        for pid, sub, source, vel, score, spread in cur.fetchall():
            key = (pid, sub)
            if key in out:  # first row wins (tcgplayer / freshest)
                continue
            out[key] = {
                "sold_velocity": float(vel) if vel is not None else None,
                "liquidity_score": float(score) if score is not None else None,
                "bid_ask_spread_pct": float(spread) if spread is not None else None,
            }
    return out


def _fetch_history(conn) -> tuple[dict, dict]:
    """Per-series recent market series and latest low from daily_prices."""
    hist: dict[tuple[int, str], list[float]] = defaultdict(list)
    latest_low: dict[tuple[int, str], float] = {}
    with conn.cursor(name="daily_movement") as cur:  # server-side cursor
        cur.itersize = 50_000
        cur.execute(
            """
            select product_id, sub_type, low, market
            from daily_prices
            where date >= (select max(date) from daily_prices) - %s
            order by product_id, sub_type, date
            """,
            (HISTORY_DAYS,),
        )
        for pid, sub, low, market in cur:
            key = (pid, sub)
            if market is not None:
                hist[key].append(float(market))
            if low is not None:
                latest_low[key] = float(low)  # ordered by date asc -> last wins
    return hist, latest_low


def compute_movement() -> None:
    counts: dict[str, int] = defaultdict(int)
    with get_conn() as conn:
        liquidity = _fetch_liquidity(conn)
        hist, latest_low = _fetch_history(conn)

        with conn.cursor() as cur:
            cur.execute(
                "select product_id, sub_type, market, chg_7d_pct, avg_market_30d "
                "from price_windows"
            )
            windows = cur.fetchall()

        print(
            f"[movement] series={len(windows)} | with_history={len(hist)} | "
            f"with_liquidity={len(liquidity)}",
            flush=True,
        )

        updates: list[tuple] = []
        for pid, sub, market, chg7d, avg30 in windows:
            key = (pid, sub)
            liq = liquidity.get(key, {})
            verdict, confidence, codes = assess(
                market_history=hist.get(key, []),
                latest_market=float(market) if market is not None else None,
                latest_low=latest_low.get(key),
                chg_7d_pct=float(chg7d) if chg7d is not None else None,
                avg_market_30d=float(avg30) if avg30 is not None else None,
                sold_velocity=liq.get("sold_velocity"),
                liquidity_score=liq.get("liquidity_score"),
                bid_ask_spread_pct=liq.get("bid_ask_spread_pct"),
            )
            counts[verdict] += 1
            updates.append((verdict, confidence, codes, pid, sub))

        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")
            cur.executemany(
                "update price_windows set movement_verdict = %s, "
                "movement_confidence = %s, movement_codes = %s "
                "where product_id = %s and sub_type = %s",
                updates,
            )
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "insert into ingest_runs (kind, finished_at, status, rows, detail) "
                "values ('movement', now(), 'ok', %s, %s)",
                (len(updates), json.dumps(dict(counts))),
            )
        conn.commit()

    summary = " | ".join(f"{k}={v}" for k, v in sorted(counts.items()))
    print(f"[movement] done: {len(updates)} rows updated | {summary}", flush=True)


if __name__ == "__main__":
    compute_movement()
