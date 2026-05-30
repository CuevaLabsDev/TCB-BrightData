"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Layers,
  LayoutDashboard,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/movers", label: "Movers", icon: TrendingUp },
  { href: "/sets", label: "Sets", icon: Layers },
  { href: "/creators", label: "Creators", icon: Users },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/agent", label: "Ask TCB", icon: Sparkles },
];

export function NavLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        mobile
          ? "flex gap-1 overflow-x-auto pb-1"
          : "hidden items-center gap-1 md:flex",
      )}
    >
      {NAV.map((item) => {
        const Icon = item.icon;
        const active =
          pathname === item.href ||
          (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition",
              active
                ? "bg-accent/10 text-foreground ring-1 ring-accent/20"
                : "text-muted hover:bg-panel-strong hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
