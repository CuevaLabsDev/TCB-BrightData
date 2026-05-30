// Create one Triggerware trigger per tier1 watchlist creator.
//
// Prerequisite (manual, in the Triggerware console): install the catalog social
// connector(s) for the platforms below and configure their platform API keys.
// Triggers are named queries; here we describe each in plain English and let
// Triggerware generate the SQL against the installed connector's tables.
//
// The tier1 list MUST stay in sync with src/lib/social/watchlist.ts.
//   node scripts/setup-triggerware.mjs          # create/update triggers
//   node scripts/setup-triggerware.mjs --list   # just list existing triggers
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const API = (process.env.TRIGGERWARE_API_URL || env.TRIGGERWARE_API_URL || "https://api.triggerware.com").replace(/\/$/, "");
const KEY = process.env.TRIGGERWARE_API_KEY || env.TRIGGERWARE_API_KEY || env.triggerwareai_api_key;
const PREFIX = process.env.TRIGGERWARE_TRIGGER_PREFIX || env.TRIGGERWARE_TRIGGER_PREFIX || "tcb_tier1_";

if (!KEY) {
  console.error("[triggerware] no API key (TRIGGERWARE_API_KEY / triggerwareai_api_key)");
  process.exit(1);
}

// Keep in sync with tier1 entries in src/lib/social/watchlist.ts.
const TIER1 = [
  { id: "youtube-pokerev", platform: "youtube", handle: "PokeRev" },
  { id: "x-thepokerev", platform: "x", handle: "ThePokeRev" },
  { id: "youtube-smpratte", platform: "youtube", handle: "smpratte" },
  { id: "reddit-pokeinvesting", platform: "reddit", handle: "PokeInvesting" },
];

const triggerName = (id) => `${PREFIX}${id}`.replace(/[^a-zA-Z0-9_]/g, "_");

async function tw(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Api-Key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

const list = await tw("GET", "/triggers");
console.log(`[triggerware] GET /triggers -> ${list.status}`);
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(list.json, null, 2));
  process.exit(list.ok ? 0 : 1);
}

const existing = new Set(Array.isArray(list.json) ? list.json.map((t) => t.name) : []);

for (const e of TIER1) {
  const name = triggerName(e.id);
  const handleRef = e.platform === "reddit" ? `r/${e.handle}` : `@${e.handle}`;
  const description =
    `Monitor new posts from ${handleRef} on ${e.platform} about Pokemon trading cards. ` +
    `Return post_url, posted_at, and caption, newest first, limit 10.`;

  const payload = { name, description, schedule: 900 };
  const verb = existing.has(name) ? "PATCH" : "POST";
  const path = existing.has(name) ? `/triggers/${encodeURIComponent(name)}` : "/triggers";
  const r = await tw(verb, path, payload);
  console.log(`[triggerware] ${verb} ${name} -> ${r.status}`);
  if (!r.ok) console.log("   ", JSON.stringify(r.json).slice(0, 300));
}

console.log(
  "\n[triggerware] Done. If creates failed with a connector/schema error, install the catalog\n" +
    "social connector(s) in the console first, then re-run. Verify with: node scripts/verify-triggerware.mjs",
);
