import { generateText, convertToModelMessages, stepCountIs, type UIMessage } from "ai";
import { getAgentModel, getMaxOutputTokens, hasFeatherless } from "@/lib/agent/featherless";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { agentTools } from "@/lib/agent/tools";

export const maxDuration = 120;

const MAX_TOOL_STEPS = 5;
const STORED_AGENT_TOOLS = [
  "search_catalog",
  "get_price_analytics",
  "assess_price_movement",
  "find_setup_candidates",
  "get_top_movers",
  "get_grade_arbitrage",
  "get_liquidity",
  "get_creator_sentiment",
  "recall_market_memory",
] satisfies Array<keyof typeof agentTools>;

function latestUserText(messages: UIMessage[]) {
  const latestUser = messages.findLast((m) => m.role === "user");
  return (
    latestUser?.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .toLowerCase() ?? ""
  );
}

function wantsLiveBrightData(messages: UIMessage[]) {
  return /\b(live|fresh|refresh|scan|scrape|real[-\s]?time|latest|today|bright\s?data)\b/.test(
    latestUserText(messages),
  );
}

/**
 * Agent endpoint. We use generateText (not streamText) for the tool loop:
 * Featherless streams tool calls in a Hermes-style format that AI SDK v6's
 * streaming parser recognizes for display but never finalizes for execution,
 * so streamText stalls after the first tool-input. generateText parses the
 * complete response and runs the multi-step loop reliably.
 *
 * Returns: { text, toolsUsed, steps } consumed by the chat UI.
 */
export async function POST(req: Request) {
  if (!hasFeatherless()) {
    return Response.json(
      { error: "FEATHERLESS_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();
  const allowLiveRefresh = wantsLiveBrightData(messages);
  const systemPrompt = allowLiveRefresh
    ? SYSTEM_PROMPT
    : `${SYSTEM_PROMPT}

Use stored warehouse data first. Live Bright Data refresh is disabled unless the user explicitly asks for a live, fresh, refreshed, latest, today, scan, scrape, real-time, or Bright Data lookup. If stored liquidity or graded comps are missing, say that stored data is missing and offer a live refresh.`;

  try {
    const result = await generateText({
      model: getAgentModel(),
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      tools: agentTools,
      activeTools: allowLiveRefresh ? undefined : STORED_AGENT_TOOLS,
      experimental_context: { allowLiveRefresh },
      stopWhen: stepCountIs(MAX_TOOL_STEPS + 1),
      prepareStep: ({ stepNumber }) =>
        stepNumber >= MAX_TOOL_STEPS
          ? {
              toolChoice: "none",
              system: `${systemPrompt}

You have enough tool results. Do not call more tools. Synthesize the final operator answer from the returned data only. If the data is insufficient, say exactly what is missing.`,
            }
          : undefined,
      maxOutputTokens: getMaxOutputTokens(),
      temperature: 0.2,
    });

    const toolsUsed = result.steps.flatMap((s) =>
      (s.toolCalls ?? []).map((t) => t.toolName),
    );

    return Response.json({
      text: result.text,
      toolsUsed: [...new Set(toolsUsed)],
      steps: result.steps.length,
      liveRefreshEnabled: allowLiveRefresh,
    });
  } catch (e) {
    console.error("[agent] error:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : "agent failed" },
      { status: 500 },
    );
  }
}
