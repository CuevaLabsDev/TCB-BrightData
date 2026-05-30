import { AgentChat } from "@/components/agent-chat";

export const dynamic = "force-dynamic";

export default function AgentPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Ask TCB</h1>
        <p className="mt-1 text-sm text-muted">
          Your analyst for the full market — price, grades, liquidity, creators, and memory.
          Every answer comes from live TCB data, never invented.
        </p>
      </div>
      <AgentChat />
    </div>
  );
}
