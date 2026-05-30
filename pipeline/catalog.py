"""Catalog ingest: tcgcsv groups (sets) + products (cards/sealed) -> Supabase.

The daily price archives only contain prices keyed by productId; all human
metadata (names, images, rarity, set names) comes from the tcgcsv catalog API:
  https://tcgcsv.com/tcgplayer/3/groups
  https://tcgcsv.com/tcgplayer/3/{groupId}/products
"""
from __future__ import annotations

import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from .db import get_conn

CATEGORY = 3
BASE = "https://tcgcsv.com/tcgplayer"
SEALED_RE = re.compile(
    r"\b(booster|box|pack|blister|tin|collection|bundle|case|deck|portfolio|"
    r"sleeve|elite trainer|etb|premium|display|gift|build|battle deck|"
    r"theme deck|starter|trainer kit|poster|binder)\b",
    re.I,
)


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "tcb-ingest/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def _ext(product: dict) -> dict[str, str]:
    out = {}
    for item in product.get("extendedData") or []:
        name = item.get("name")
        if name:
            out[name] = item.get("value")
    return out


def fetch_groups() -> list[dict]:
    data = _get(f"{BASE}/{CATEGORY}/groups")
    return data.get("results", [])


def fetch_products(group_id: int) -> list[dict]:
    data = _get(f"{BASE}/{CATEGORY}/{group_id}/products")
    return data.get("results", [])


def ingest_catalog() -> tuple[int, int]:
    groups = fetch_groups()
    print(f"[catalog] {len(groups)} groups")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """insert into groups
                     (group_id, category_id, name, abbreviation, published_on, modified_on)
                   values (%s,%s,%s,%s,%s,%s)
                   on conflict (group_id) do update set
                     name=excluded.name, abbreviation=excluded.abbreviation,
                     published_on=excluded.published_on, modified_on=excluded.modified_on""",
                [
                    (
                        g["groupId"], g.get("categoryId", CATEGORY), g.get("name"),
                        g.get("abbreviation"), g.get("publishedOn"), g.get("modifiedOn"),
                    )
                    for g in groups
                ],
            )
        conn.commit()

    # Fetch products per group in parallel
    all_rows: list[tuple] = []
    errors = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(fetch_products, g["groupId"]): g for g in groups}
        for fut in as_completed(futs):
            g = futs[fut]
            try:
                products = fut.result()
            except Exception as e:  # noqa: BLE001
                errors += 1
                print(f"[catalog] group {g['groupId']} failed: {e}")
                continue
            for p in products:
                ed = _ext(p)
                name = p.get("name", "")
                is_card = ("Rarity" in ed) or ("Number" in ed)
                is_sealed = (not is_card) or bool(SEALED_RE.search(name))
                all_rows.append(
                    (
                        p["productId"], p.get("groupId", g["groupId"]),
                        p.get("categoryId", CATEGORY), name, p.get("cleanName"),
                        p.get("imageUrl"), p.get("url"),
                        ed.get("Number"), ed.get("Rarity"), ed.get("CardType"),
                        ed.get("HP"), ed.get("Stage"), is_sealed, p.get("modifiedOn"),
                    )
                )

    print(f"[catalog] {len(all_rows)} products ({errors} group errors). Upserting...")
    with get_conn() as conn:
        with conn.cursor() as cur:
            # batched upsert
            B = 2000
            for i in range(0, len(all_rows), B):
                cur.executemany(
                    """insert into products
                         (product_id, group_id, category_id, name, clean_name, image_url, url,
                          number, rarity, card_type, hp, stage, is_sealed, modified_on)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (product_id) do update set
                         group_id=excluded.group_id, name=excluded.name,
                         clean_name=excluded.clean_name, image_url=excluded.image_url,
                         url=excluded.url, number=excluded.number, rarity=excluded.rarity,
                         card_type=excluded.card_type, hp=excluded.hp, stage=excluded.stage,
                         is_sealed=excluded.is_sealed, modified_on=excluded.modified_on""",
                    all_rows[i : i + B],
                )
                conn.commit()
    print(f"[catalog] done: {len(groups)} groups, {len(all_rows)} products")
    return len(groups), len(all_rows)


if __name__ == "__main__":
    ingest_catalog()
