import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("card-surface", className)}>{children}</div>;
}

export function CardHeader({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("flex items-start justify-between gap-4 p-5", className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn("text-base font-semibold text-foreground", className)}>{children}</h2>;
}

export function CardDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("mt-1 text-sm text-muted", className)}>{children}</p>;
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 pb-5", className)}>{children}</div>;
}

export function Stat({
  label,
  value,
  sub,
  accent,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
  icon?: ElementType;
}) {
  return (
    <div className="card-surface relative overflow-hidden p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">{label}</p>
          <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums", accent ?? "text-foreground")}>
            {value}
          </p>
          {sub && <p className="mt-0.5 truncate text-xs text-subtle">{sub}</p>}
        </div>
        {Icon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-panel-strong text-muted">
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "emerald" | "sky" | "amber" | "rose" | "violet";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-panel-strong text-muted",
    emerald: "border-success/30 bg-success/10 text-success",
    sky: "border-info/30 bg-info/10 text-info",
    amber: "border-warning/30 bg-warning/10 text-warning",
    rose: "border-danger/30 bg-danger/10 text-danger",
    violet: "border-accent/30 bg-accent/10 text-accent",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-subtle">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}
