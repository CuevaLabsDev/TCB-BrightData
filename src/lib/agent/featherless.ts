import { createOpenAI } from "@ai-sdk/openai";

/**
 * Featherless AI — the hackathon's open-source inference partner.
 * OpenAI-compatible endpoint; we use it for BOTH the chat/tool-calling agent
 * and structured extraction (sentiment, market narratives).
 *
 * Model choice matters: small instruct models (3B) ramble fake turns without
 * stop tokens. We default to Qwen2.5-7B (fast, clean JSON) and use Llama-3.1-8B
 * for the agent, which tool-calls + extracts most reliably.
 */
const FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";

export const FEATHERLESS_MODELS = {
  /** Fast, clean JSON — default for extraction (response_format json_object). */
  default: "Qwen/Qwen2.5-7B-Instruct",
  /** Trained for function calling (Featherless: Qwen3 family + Kimi-K2 only). */
  agent: "Qwen/Qwen3-14B",
  /** Fastest, for high-volume bulk extraction. */
  fast: "Qwen/Qwen2.5-7B-Instruct",
} as const;

const DEFAULT_MAX_OUTPUT_TOKENS = 700;

export function hasFeatherless() {
  return Boolean(process.env.FEATHERLESS_API_KEY);
}

function provider() {
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) throw new Error("FEATHERLESS_API_KEY is not configured");
  return createOpenAI({
    baseURL: FEATHERLESS_BASE_URL,
    apiKey,
    headers: {
      "HTTP-Referer":
        process.env.FEATHERLESS_APP_URL ?? process.env.TCB_APP_URL ?? "http://localhost:3000",
      "X-Title": "Trading Card Block",
    },
  });
}

/** AI SDK model for the chat/tool-calling agent. */
export function getAgentModel() {
  const id = process.env.FEATHERLESS_AGENT_MODEL ?? FEATHERLESS_MODELS.agent;
  return provider().chat(id);
}

/** AI SDK model for fast structured tasks. */
export function getExtractionModel() {
  const id = process.env.FEATHERLESS_MODEL ?? FEATHERLESS_MODELS.default;
  return provider().chat(id);
}

export function getAgentModelId() {
  return process.env.FEATHERLESS_AGENT_MODEL ?? FEATHERLESS_MODELS.agent;
}

export function getMaxOutputTokens() {
  const raw = process.env.FEATHERLESS_MAX_OUTPUT_TOKENS;
  if (!raw) return DEFAULT_MAX_OUTPUT_TOKENS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Direct JSON extraction via Featherless chat completions with
 * response_format=json_object + stop tokens (prevents small-model rambling).
 */
export async function extractJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<T | null> {
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) throw new Error("FEATHERLESS_API_KEY is not configured");

  const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? FEATHERLESS_MODELS.default,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: opts.maxTokens ?? 400,
      temperature: 0.1,
      response_format: { type: "json_object" },
      stop: ["\n\nuser", "\n\nUser", "```"],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    return JSON.parse(content.trim()) as T;
  } catch {
    // salvage the first {...} block
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
