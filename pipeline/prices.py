"""Price-history ingest from local tcgcsv archives -> Supabase.

For each daily archive ``~/.tcgcsv/archives/prices-YYYY-MM-DD.ppmd.7z`` we read
only category-3 (Pokemon) ``{date}/3/{groupId}/prices`` files, then:

  * load ``daily_prices`` (last N days, series whose latest market >= min_market)
  * compute ``price_windows`` for EVERY series (7/30/90/180d changes, 30d
    volatility, 180d hi/lo) from the most recent ~181 archives.

Default is full-catalog breadth (windows for all 44k series) with 365 days of
daily charts for series >= $2. Use ``--daily-days all --min-market 0`` for the
full 2-year daily depth (needs Supabase Pro storage).

Incremental mode (``--incremental``) downloads one day's archive from tcgcsv,
upserts into ``daily_prices``, and recomputes ``price_windows`` from DB history.
Used by the free GitHub Actions daily job — does not truncate ``daily_prices``.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import tempfile
import shutil
import statistics
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import py7zr

from .db import get_conn
from .movement import compute_movement

ARCHIVE_DIR = Path.home() / ".tcgcsv" / "archives"
ARCHIVE_BASE = "https://tcgcsv.com/archive/tcgplayer"
CAT3_RE = re.compile(r"/3/\d+/prices$")
WINDOW_DAYS = 181          # archives needed to cover a 180d lookback
LOOKBACKS = {"7d": 7, "30d": 30, "90d": 90, "180d": 180}


def archive_dates() -> list[tuple[dt.date, Path]]:
    out = []
    for p in ARCHIVE_DIR.glob("prices-*.ppmd.7z"):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", p.name)
        if m:
            out.append((dt.date.fromisoformat(m.group(1)), p))
    out.sort()
    return out


def download_archive(day: dt.date, dest_dir: Path) -> Path:
    """Download ``prices-YYYY-MM-DD.ppmd.7z`` into dest_dir. Raises on HTTP errors."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / f"prices-{day.isoformat()}.ppmd.7z"
    if path.is_file() and path.stat().st_size > 0:
        print(f"[prices] using cached {path}", flush=True)
        return path

    url = f"{ARCHIVE_BASE}/prices-{day.isoformat()}.ppmd.7z"
    print(f"[prices] downloading {url}", flush=True)
    req = urllib.request.Request(
        url, headers={"User-Agent": "tcb-ingest/1.0 (daily-incremental)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            path.write_bytes(resp.read())
    except urllib.error.HTTPError as e:
        if path.exists():
            path.unlink(missing_ok=True)
        raise FileNotFoundError(f"archive not found for {day}: HTTP {e.code}") from e
    except Exception:
        if path.exists():
            path.unlink(missing_ok=True)
        raise

    if path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        raise FileNotFoundError(f"empty archive for {day}")
    print(f"[prices] saved {path} ({path.stat().st_size // 1024} KB)", flush=True)
    return path


def resolve_archive_day(
    explicit: dt.date | None = None,
    dest_dir: Path | None = None,
) -> tuple[dt.date, Path]:
    """Return (day, path). Try today then yesterday unless ``explicit`` is set."""
    dest = dest_dir or ARCHIVE_DIR
    if explicit is not None:
        # Prefer a local cache under ARCHIVE_DIR when present.
        local = ARCHIVE_DIR / f"prices-{explicit.isoformat()}.ppmd.7z"
        if local.is_file() and local.stat().st_size > 0:
            return explicit, local
        return explicit, download_archive(explicit, dest)

    today = dt.date.today()
    candidates = [today, today - dt.timedelta(days=1)]
    errors: list[str] = []
    for day in candidates:
        local = ARCHIVE_DIR / f"prices-{day.isoformat()}.ppmd.7z"
        if local.is_file() and local.stat().st_size > 0:
            print(f"[prices] using local archive for {day}", flush=True)
            return day, local
        try:
            return day, download_archive(day, dest)
        except FileNotFoundError as e:
            errors.append(str(e))
            continue
    raise SystemExit(
        "no tcgcsv archive available for today or yesterday:\n  " + "\n  ".join(errors)
    )


def parse_archive(path: Path) -> list[tuple]:
    """Return rows: (product_id, sub_type, low, mid, high, market, direct_low)."""
    tmp = Path(tempfile.mkdtemp(prefix="tcgp_"))
    rows: list[tuple] = []
    try:
        with py7zr.SevenZipFile(path, "r") as z:
            targets = [n for n in z.getnames() if CAT3_RE.search(n)]
            z.extract(path=tmp, targets=targets)
        for n in targets:
            fp = tmp / n
            if not fp.is_file():
                continue
            try:
                data = json.loads(fp.read_text())
            except Exception:  # noqa: BLE001
                continue
            if not data.get("success"):
                continue
            for it in data.get("results", []):
                rows.append(
                    (
                        it["productId"],
                        it.get("subTypeName") or "Normal",
                        it.get("lowPrice"),
                        it.get("midPrice"),
                        it.get("highPrice"),
                        it.get("marketPrice"),
                        it.get("directLowPrice"),
                    )
                )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rows


PCT_DENOM_FLOOR = 1.0   # ignore changes off a sub-$1 base (pre-release/placeholder noise)
PCT_CAP = 2000.0        # clamp absurd outliers from thin early history


def _pct(now: float, past: float) -> float | None:
    """Percent change with guards against tiny-denominator blowups.

    Cards whose lookback price was a near-zero placeholder (common for
    pre-release rows) otherwise produce nonsense like +90,000%. We treat a
    sub-$1 base as "no meaningful baseline" and clamp the rest to +/-PCT_CAP.
    """
    if past is None or now is None or past < PCT_DENOM_FLOOR:
        return None
    pct = (now - past) / past * 100
    if pct > PCT_CAP:
        return PCT_CAP
    if pct < -PCT_CAP:
        return -PCT_CAP
    return round(pct, 2)


def _nearest_on_or_before(series: dict[dt.date, float], target: dt.date):
    """Latest market on or before target date."""
    best = None
    for d, v in series.items():
        if d <= target and v is not None:
            if best is None or d > best[0]:
                best = (d, v)
    return best[1] if best else None


# Daily-series cleaning ------------------------------------------------------
# TCGplayer "market" is listing-derived, so a single parked listing can spike
# one day's market well above where cards actually trade. A point-to-point
# comparison (now vs N-days-ago) against such a spike produces nonsense 7/30/90d
# %-changes and skews the 30d average + volatility. We clean each series with a
# Hampel filter (centered rolling median + MAD) BEFORE computing any window
# metric: transient single-day outliers are clipped back to the local median,
# while genuine SUSTAINED moves survive (the rolling median catches up to them).
HAMPEL_WINDOW = 7        # centered window (days) for the rolling median
HAMPEL_SIGMAS = 3.5      # robust deviations beyond which a day is an outlier
MAD_TO_STD = 1.4826      # scales MAD to a stdev-equivalent for gaussian data
MIN_CLEAN_POINTS = 5     # series shorter than this are left untouched
FLAT_REL_FLOOR = 0.5     # when the window has ~zero spread (MAD=0), clip days
                         # that deviate > this fraction from the local median


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def clean_market_series(
    hist: dict[dt.date, float],
) -> tuple[dict[dt.date, float], int]:
    """Return a Hampel-cleaned copy of a {date: market} series + clip count.

    Outlier days are replaced (not dropped) with the local rolling median so the
    series stays continuous for lookback-anchor and average computations.
    """
    points = sorted((d, v) for d, v in hist.items() if v is not None)
    if len(points) < MIN_CLEAN_POINTS:
        return dict(hist), 0

    dates = [d for d, _ in points]
    values = [float(v) for _, v in points]
    half = HAMPEL_WINDOW // 2
    cleaned: dict[dt.date, float] = {}
    clipped = 0
    for i, (d, v) in enumerate(zip(dates, values)):
        window = values[max(0, i - half) : i + half + 1]
        med = _median(window)
        mad = _median([abs(w - med) for w in window])
        if mad > 0:
            is_outlier = abs(v - med) > MAD_TO_STD * HAMPEL_SIGMAS * mad
        else:
            # Near-constant window: MAD-based threshold collapses to 0, so a
            # lone spike/crash would otherwise sneak through. Flag gross
            # relative deviations from the (constant) local median instead.
            is_outlier = med > 0 and abs(v - med) > FLAT_REL_FLOOR * med
        if is_outlier:
            cleaned[d] = round(med, 2)
            clipped += 1
        else:
            cleaned[d] = v
    return cleaned, clipped


def compute_windows(series_hist: dict[tuple, dict[dt.date, float]], as_of: dt.date):
    rows = []
    total_clipped = 0
    for (pid, sub), raw_hist in series_hist.items():
        if not raw_hist:
            continue
        hist, clipped = clean_market_series(raw_hist)
        total_clipped += clipped
        cur_market = hist.get(as_of) or _nearest_on_or_before(hist, as_of)
        if cur_market is None:
            continue
        lb_vals = {
            k: _nearest_on_or_before(hist, as_of - dt.timedelta(days=days))
            for k, days in LOOKBACKS.items()
        }
        last30 = [v for d, v in hist.items() if v is not None and (as_of - d).days <= 30]
        last180 = [v for d, v in hist.items() if v is not None and (as_of - d).days <= 180]
        avg30 = round(statistics.fmean(last30), 2) if last30 else None
        vol30 = (
            round(statistics.pstdev(last30) / statistics.fmean(last30), 4)
            if len(last30) > 1 and statistics.fmean(last30) else None
        )
        rows.append(
            (
                pid, sub, as_of, cur_market,
                _pct(cur_market, lb_vals["7d"]), _pct(cur_market, lb_vals["30d"]),
                _pct(cur_market, lb_vals["90d"]), _pct(cur_market, lb_vals["180d"]),
                lb_vals["7d"], lb_vals["30d"], lb_vals["90d"], lb_vals["180d"],
                max(last180) if last180 else None, min(last180) if last180 else None,
                avg30, vol30, len(hist),
            )
        )
    print(f"[windows] cleaned {total_clipped} outlier days across {len(rows)} series", flush=True)
    return rows


DAILY_COLS = "(product_id, sub_type, date, low, mid, high, market, direct_low)"
FLUSH_EVERY = 250_000   # rows per COPY batch (keeps each statement small)


def _flush_daily(conn, buffer: list[tuple]) -> None:
    """COPY a batch of daily rows and commit (bounded statement size)."""
    if not buffer:
        return
    with conn.cursor() as cur:
        with cur.copy(f"copy daily_prices {DAILY_COLS} from stdin") as cp:
            for row in buffer:
                cp.write_row(row)
    conn.commit()


def ingest_prices(daily_days: int | None, min_market: float, workers: int) -> None:
    dates = archive_dates()
    if not dates:
        raise SystemExit(f"no archives in {ARCHIVE_DIR}")
    as_of = dates[-1][0]
    print(f"[prices] {len(dates)} archives | as_of={as_of} | daily_days={daily_days} | min_market={min_market}", flush=True)

    window_start = as_of - dt.timedelta(days=WINDOW_DAYS)
    daily_start = dates[0][0] if daily_days is None else as_of - dt.timedelta(days=daily_days)

    cutoff = min(window_start, daily_start)
    work = [(d, p) for d, p in dates if d >= cutoff]
    print(f"[prices] parsing {len(work)} archives from {work[0][0]} (cutoff={cutoff})", flush=True)

    # Latest snapshot -> tracked set (which series get daily-history rows stored)
    latest_market = {(r[0], r[1]): r[5] for r in parse_archive(dates[-1][1])}
    tracked = {
        k for k, mk in latest_market.items() if mk is not None and float(mk) >= min_market
    }
    print(f"[prices] series total={len(latest_market)} tracked(>= ${min_market})={len(tracked)}", flush=True)

    series_hist: dict[tuple, dict[dt.date, float]] = {}
    daily_buffer: list[tuple] = []
    copied = 0

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")      # bulk load — no per-statement cap
            cur.execute("set synchronous_commit = off;")    # faster commits, safe for reload
            cur.execute("truncate table daily_prices;")
            cur.execute("truncate table price_windows;")
        conn.commit()

        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(parse_archive, p): d for d, p in work}
            done = 0
            for fut in as_completed(futs):
                d = futs[fut]
                rows = fut.result()
                done += 1
                in_window = window_start <= d <= as_of
                in_daily = d >= daily_start
                for (pid, sub, low, mid, high, market, dlow) in rows:
                    key = (pid, sub)
                    if in_window and market is not None:
                        series_hist.setdefault(key, {})[d] = float(market)
                    if in_daily and key in tracked:
                        daily_buffer.append((pid, sub, d, low, mid, high, market, dlow))
                        copied += 1
                if len(daily_buffer) >= FLUSH_EVERY:
                    _flush_daily(conn, daily_buffer)
                    daily_buffer = []
                if done % 25 == 0:
                    print(f"[prices] parsed {done}/{len(work)} | daily rows={copied} | series={len(series_hist)}", flush=True)

        _flush_daily(conn, daily_buffer)
        print(f"[prices] daily_prices loaded: {copied} rows", flush=True)

        # Compute + load price_windows for ALL series (small table, single COPY)
        print(f"[prices] computing windows for {len(series_hist)} series...", flush=True)
        wrows = compute_windows(series_hist, as_of)
        with conn.cursor() as cur:
            with cur.copy(
                """copy price_windows
                   (product_id, sub_type, as_of, market, chg_7d_pct, chg_30d_pct,
                    chg_90d_pct, chg_180d_pct, market_7d_ago, market_30d_ago,
                    market_90d_ago, market_180d_ago, high_180d, low_180d,
                    avg_market_30d, volatility_30d, data_points) from stdin"""
            ) as cp:
                for r in wrows:
                    cp.write_row(r)
        conn.commit()
        print(f"[prices] price_windows loaded: {len(wrows)} rows", flush=True)

        with conn.cursor() as cur:
            cur.execute(
                "insert into ingest_runs (kind, finished_at, status, rows, detail) "
                "values ('prices', now(), 'ok', %s, %s)",
                (copied + len(wrows),
                 json.dumps({"as_of": str(as_of), "daily_rows": copied,
                             "windows": len(wrows), "tracked": len(tracked)})),
            )
        conn.commit()

    compute_movement()
    print("[prices] done.", flush=True)


def recompute_windows_only(workers: int) -> None:
    """Re-parse the 180d window of archives and rewrite ONLY price_windows.

    Fast path used after tuning the analytics formulas — leaves the large
    daily_prices table untouched.
    """
    dates = archive_dates()
    as_of = dates[-1][0]
    window_start = as_of - dt.timedelta(days=WINDOW_DAYS)
    work = [(d, p) for d, p in dates if d >= window_start]
    print(f"[windows] reparsing {len(work)} archives from {work[0][0]} | as_of={as_of}", flush=True)

    series_hist: dict[tuple, dict[dt.date, float]] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(parse_archive, p): d for d, p in work}
        done = 0
        for fut in as_completed(futs):
            d = futs[fut]
            done += 1
            for (pid, sub, low, mid, high, market, dlow) in fut.result():
                if market is not None:
                    series_hist.setdefault((pid, sub), {})[d] = float(market)
            if done % 25 == 0:
                print(f"[windows] parsed {done}/{len(work)} | series={len(series_hist)}", flush=True)

    print(f"[windows] computing for {len(series_hist)} series...", flush=True)
    wrows = compute_windows(series_hist, as_of)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")
            cur.execute("truncate table price_windows;")
            with cur.copy(
                """copy price_windows
                   (product_id, sub_type, as_of, market, chg_7d_pct, chg_30d_pct,
                    chg_90d_pct, chg_180d_pct, market_7d_ago, market_30d_ago,
                    market_90d_ago, market_180d_ago, high_180d, low_180d,
                    avg_market_30d, volatility_30d, data_points) from stdin"""
            ) as cp:
                for r in wrows:
                    cp.write_row(r)
        conn.commit()
    print(f"[windows] price_windows rewritten: {len(wrows)} rows", flush=True)
    compute_movement()


def upsert_day(day: dt.date, rows: list[tuple], min_market: float) -> int:
    """Upsert one day's prices for series with market >= min_market. No truncate."""
    tracked: list[tuple] = []
    for pid, sub, low, mid, high, market, dlow in rows:
        if market is not None and float(market) >= min_market:
            tracked.append((pid, sub, day, low, mid, high, market, dlow))

    if not tracked:
        print(f"[prices] upsert {day}: 0 tracked rows (min_market=${min_market})", flush=True)
        return 0

    print(
        f"[prices] upserting {len(tracked)} rows for {day} (min_market=${min_market})",
        flush=True,
    )
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")
            cur.execute(
                """
                create temporary table daily_prices_stage (
                  product_id integer,
                  sub_type   text,
                  date       date,
                  low        numeric,
                  mid        numeric,
                  high       numeric,
                  market     numeric,
                  direct_low numeric
                ) on commit drop
                """
            )
            with cur.copy(
                "copy daily_prices_stage "
                "(product_id, sub_type, date, low, mid, high, market, direct_low) "
                "from stdin"
            ) as cp:
                for row in tracked:
                    cp.write_row(row)
            cur.execute(
                """
                insert into daily_prices
                  (product_id, sub_type, date, low, mid, high, market, direct_low)
                select product_id, sub_type, date, low, mid, high, market, direct_low
                from daily_prices_stage
                on conflict (product_id, sub_type, date) do update set
                  low = excluded.low,
                  mid = excluded.mid,
                  high = excluded.high,
                  market = excluded.market,
                  direct_low = excluded.direct_low
                """
            )
        conn.commit()
    print(f"[prices] daily_prices upserted: {len(tracked)} rows", flush=True)
    return len(tracked)


def load_series_hist_from_db(as_of: dt.date) -> dict[tuple, dict[dt.date, float]]:
    """Load market history from daily_prices for the 180d lookback window."""
    start = as_of - dt.timedelta(days=WINDOW_DAYS)
    series_hist: dict[tuple, dict[dt.date, float]] = {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")
            cur.execute(
                """
                select product_id, sub_type, date, market
                from daily_prices
                where date >= %s and date <= %s and market is not null
                """,
                (start, as_of),
            )
            for pid, sub, d, market in cur:
                series_hist.setdefault((int(pid), str(sub)), {})[d] = float(market)
    print(
        f"[windows] loaded {len(series_hist)} series from daily_prices "
        f"({start}..{as_of})",
        flush=True,
    )
    return series_hist


def recompute_windows_from_db(as_of: dt.date, today_rows: list[tuple]) -> int:
    """Rewrite price_windows from DB history + today's full archive markets."""
    series_hist = load_series_hist_from_db(as_of)
    for pid, sub, _low, _mid, _high, market, _dlow in today_rows:
        if market is not None:
            series_hist.setdefault((pid, sub), {})[as_of] = float(market)

    print(f"[windows] computing for {len(series_hist)} series...", flush=True)
    wrows = compute_windows(series_hist, as_of)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0;")
            cur.execute("truncate table price_windows;")
            with cur.copy(
                """copy price_windows
                   (product_id, sub_type, as_of, market, chg_7d_pct, chg_30d_pct,
                    chg_90d_pct, chg_180d_pct, market_7d_ago, market_30d_ago,
                    market_90d_ago, market_180d_ago, high_180d, low_180d,
                    avg_market_30d, volatility_30d, data_points) from stdin"""
            ) as cp:
                for r in wrows:
                    cp.write_row(r)
        conn.commit()
    print(f"[windows] price_windows rewritten: {len(wrows)} rows", flush=True)
    return len(wrows)


def ingest_incremental(explicit_date: dt.date | None, min_market: float) -> None:
    """Download one day, upsert daily_prices, recompute windows from DB."""
    tmp: Path | None = None
    try:
        tmp = Path(tempfile.mkdtemp(prefix="tcgcsv_inc_"))
        as_of, path = resolve_archive_day(explicit_date, dest_dir=tmp)
        # If we used a local ARCHIVE_DIR cache, path may be outside tmp — that's fine.
        print(f"[prices] incremental as_of={as_of} | min_market={min_market}", flush=True)
        rows = parse_archive(path)
        print(f"[prices] parsed {len(rows)} price rows from archive", flush=True)

        upserted = upsert_day(as_of, rows, min_market)
        windows = recompute_windows_from_db(as_of, rows)

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "insert into ingest_runs (kind, finished_at, status, rows, detail) "
                    "values ('prices', now(), 'ok', %s, %s)",
                    (
                        upserted + windows,
                        json.dumps(
                            {
                                "mode": "incremental",
                                "as_of": str(as_of),
                                "daily_rows": upserted,
                                "windows": windows,
                                "min_market": min_market,
                            }
                        ),
                    ),
                )
            conn.commit()

        compute_movement()
        print("[prices] incremental done.", flush=True)
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily-days", default="365", help="days of daily history to store, or 'all'")
    ap.add_argument("--min-market", type=float, default=2.0, help="min latest market to store daily")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--windows-only", action="store_true", help="rewrite price_windows only")
    ap.add_argument(
        "--incremental",
        action="store_true",
        help="download one day from tcgcsv, upsert daily_prices, recompute windows from DB",
    )
    ap.add_argument(
        "--date",
        type=str,
        default=None,
        help="with --incremental: YYYY-MM-DD archive date (default: today, else yesterday)",
    )
    a = ap.parse_args()
    if a.windows_only:
        recompute_windows_only(a.workers)
        return
    if a.incremental:
        explicit = dt.date.fromisoformat(a.date) if a.date else None
        ingest_incremental(explicit, a.min_market)
        return
    daily_days = None if str(a.daily_days).lower() == "all" else int(a.daily_days)
    ingest_prices(daily_days, a.min_market, a.workers)


if __name__ == "__main__":
    main()
