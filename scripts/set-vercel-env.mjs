// Upsert production env vars to Vercel via the API (reliable; the CLI stdin path
// silently stored empty values). Reads values from .env.local.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const AUTH = `${homedir()}/Library/Application Support/com.vercel.cli/auth.json`;
const TOKEN = JSON.parse(readFileSync(AUTH, "utf8")).token;
const TEAM = "team_m3sM3TcpvJUlw0L6DuJ139Fh";
const PROJ = "prj_DSHlx4h8FdO1IkPZCsDJ7dqEWCld";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const KEYS = [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL", "DATABASE_URL",
  "BRIGHT_DATA_API_KEY", "BRIGHT_DATA_SERP_ZONE", "BRIGHT_DATA_UNLOCKER_ZONE",
  "FEATHERLESS_API_KEY", "FEATHERLESS_MODEL", "FEATHERLESS_AGENT_MODEL",
  "FEATHERLESS_MAX_OUTPUT_TOKENS", "CRON_SECRET",
];

const base = `https://api.vercel.com`;
const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// fetch existing env to get ids for update
const listRes = await fetch(`${base}/v9/projects/${PROJ}/env?teamId=${TEAM}&decrypt=false`, { headers: h });
const list = await listRes.json();
const existing = new Map((list.envs || []).map((e) => [e.key, e.id]));

for (const key of KEYS) {
  const value = env[key];
  if (!value) { console.log(`- ${key}: missing in .env.local`); continue; }

  // remove any existing entries for this key (could be multiple/empty)
  for (const e of (list.envs || []).filter((e) => e.key === key)) {
    await fetch(`${base}/v9/projects/${PROJ}/env/${e.id}?teamId=${TEAM}`, { method: "DELETE", headers: h });
  }

  const body = {
    key,
    value,
    type: "encrypted",
    target: ["production", "preview", "development"],
  };
  const res = await fetch(`${base}/v10/projects/${PROJ}/env?teamId=${TEAM}`, {
    method: "POST", headers: h, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (res.ok) console.log(`+ ${key} (len=${value.length})`);
  else console.log(`! ${key} FAILED: ${JSON.stringify(j.error || j).slice(0, 120)}`);
}
console.log("done");
