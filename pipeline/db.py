"""Database helpers for the Trading Card Block warehouse.

Loads env from the repo .env.local, opens psycopg connections against the
fresh Supabase Postgres, and applies the schema. Bulk loads use COPY.
"""
from __future__ import annotations

import os
import pathlib
import sys
from contextlib import contextmanager

import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
SCHEMA_FILE = ROOT / "supabase" / "schema.sql"


def load_env(path: pathlib.Path = ENV_FILE) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip())


def db_url() -> str:
    load_env()
    # Pipeline prefers the SESSION pooler (5432) for bulk COPY; fall back to others.
    url = (
        os.environ.get("PIPELINE_DB_URL")
        or os.environ.get("SUPABASE_DB_URL")
        or os.environ.get("DATABASE_URL")
    )
    if not url:
        raise SystemExit("PIPELINE_DB_URL / SUPABASE_DB_URL not set in .env.local")
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


@contextmanager
def get_conn(autocommit: bool = False):
    conn = psycopg.connect(db_url(), connect_timeout=20, autocommit=autocommit)
    try:
        yield conn
        if not autocommit:
            conn.commit()
    except Exception:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


def _split_statements(sql: str) -> list[str]:
    """Naive splitter — the schema uses no dollar-quoted bodies."""
    out, buf = [], []
    for line in sql.splitlines():
        buf.append(line)
        if line.rstrip().endswith(";"):
            chunk = "\n".join(buf).strip()
            buf = []
            # skip comment-only / empty chunks
            meaningful = [
                ln for ln in chunk.splitlines()
                if ln.strip() and not ln.strip().startswith("--")
            ]
            if meaningful:
                out.append(chunk)
    return out


def apply_schema() -> None:
    sql = SCHEMA_FILE.read_text()
    stmts = _split_statements(sql)
    print(f"[schema] applying {len(stmts)} statements -> {SCHEMA_FILE.name}")
    with get_conn(autocommit=True) as conn:
        with conn.cursor() as cur:
            for i, stmt in enumerate(stmts, 1):
                head = " ".join(stmt.split())[:70]
                try:
                    cur.execute(stmt)
                except Exception as e:  # noqa: BLE001
                    print(f"  [{i}] FAIL: {head} :: {type(e).__name__}: {str(e)[:160]}")
                    raise
            cur.execute(
                "select table_name from information_schema.tables "
                "where table_schema='public' order by table_name;"
            )
            tables = [r[0] for r in cur.fetchall()]
    print(f"[schema] OK. public tables ({len(tables)}): {', '.join(tables)}")


def ping() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("select version();")
            print("[db] connected:", cur.fetchone()[0][:70])
            cur.execute("select extname from pg_extension order by 1;")
            print("[db] extensions:", ", ".join(r[0] for r in cur.fetchall()))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "ping"
    if cmd == "apply-schema":
        apply_schema()
    elif cmd == "ping":
        ping()
    else:
        raise SystemExit(f"unknown command: {cmd}")
