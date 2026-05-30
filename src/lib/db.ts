import "server-only";
import postgres from "postgres";

/**
 * Direct Postgres access to the Trading Card Block warehouse (fresh Supabase).
 *
 * Reads run from Server Components / Route Handlers only. On Vercel use the
 * Supabase TRANSACTION pooler URL (port 6543) via SUPABASE_DB_URL — it scales
 * to serverless fan-out (the session pooler caps at 15 clients). The Python
 * pipeline uses the session pooler (5432) for bulk COPY via PIPELINE_DB_URL.
 */
type Sql = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __tcbSql: Sql | undefined;
}

function connectionString() {
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
}

function makeClient(): Sql {
  const cs = connectionString();
  // During `next build` page-data collection the env may be absent. Returning a
  // client pointed at a placeholder is fine because no queries run at build
  // time (all DB pages are `force-dynamic`); the real connection string is
  // present at request time on the server.
  return postgres(cs || "postgres://placeholder", {
    // Must exceed the widest per-request parallel fan-out (dashboard issues 7
    // queries via Promise.all). Too small a pool over the transaction pooler
    // corrupts postgres.js connection state on concurrent queries
    // ("Cannot read properties of undefined (reading 'length')").
    max: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    // prepare:false uses the unnamed statement; fetch_types:false stops the
    // type-introspection round-trip that otherwise triggers
    // "bind message supplies N parameters, but prepared statement requires 0"
    // on the Supabase transaction pooler.
    prepare: false,
    fetch_types: false,
    ssl: "require",
  });
}

/**
 * Real postgres.js client (not a Proxy — proxying the tagged-template function
 * breaks postgres.js internals when minified in production builds). Cached on
 * globalThis so dev hot-reload + serverless instance reuse share one pool.
 */
export const sql: Sql = global.__tcbSql ?? makeClient();
global.__tcbSql = sql;

export function hasDb() {
  return Boolean(connectionString());
}
