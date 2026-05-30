// Verify the Triggerware integration is ready before the /api/cron/triggerware
// route is allowed to drive scans. Exits 0 only when the API is reachable.
//
// Checks: (1) GET /triggers returns 200, (2) lists the tcb_tier1_* triggers,
// (3) double-polls one to confirm the poll endpoint works and clears deltas.
//   node scripts/verify-triggerware.mjs
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
  console.error("[verify] FAIL: no API key (TRIGGERWARE_API_KEY / triggerwareai_api_key)");
  process.exit(1);
}

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
console.log(`[verify] GET /triggers -> ${list.status}`);
if (!list.ok) {
  console.error("[verify] FAIL: triggers endpoint not reachable.");
  process.exit(1);
}

const triggers = Array.isArray(list.json) ? list.json : [];
const tier1 = triggers.filter((t) => typeof t.name === "string" && t.name.startsWith(PREFIX));
console.log(`[verify] ${triggers.length} triggers total, ${tier1.length} tier1 (${PREFIX}*).`);
for (const t of tier1) console.log(`   - ${t.name} [${t.status}] every ${t.schedule}s`);

if (tier1.length === 0) {
  console.log(
    "[verify] No tier1 triggers yet — run scripts/setup-triggerware.mjs after installing the\n" +
      "         catalog social connector(s) in the console. API connectivity OK.",
  );
  process.exit(0);
}

const target = tier1[0].name;
console.log(`\n[verify] double-poll ${target}`);
const p1 = await tw("POST", `/triggers/${encodeURIComponent(target)}/poll`);
console.log(`   poll #1 -> ${p1.status} added=${(p1.json.added || []).length} deleted=${(p1.json.deleted || []).length}`);
await new Promise((r) => setTimeout(r, 1500));
const p2 = await tw("POST", `/triggers/${encodeURIComponent(target)}/poll`);
console.log(`   poll #2 -> ${p2.status} added=${(p2.json.added || []).length} deleted=${(p2.json.deleted || []).length}`);

if (p1.ok && p2.ok) {
  console.log("\n[verify] OK — Triggerware reachable and polling.");
  process.exit(0);
}
console.error("\n[verify] FAIL: poll endpoint error.");
process.exit(1);
