import Link from "next/link";
import { Layers, Sparkles } from "lucide-react";
import { GlobalSearch } from "@/components/global-search";
import { NavLinks } from "@/components/nav-links";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-accent shadow-sm">
            <Layers className="size-5" />
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-bold leading-tight tracking-tight text-foreground">Trading Card Block</p>
            <p className="text-[10px] uppercase leading-tight tracking-widest text-subtle">
              The Card Market, Unified
            </p>
          </div>
        </Link>

        <NavLinks />

        <div className="ml-auto flex items-center gap-3">
          <GlobalSearch />
          <Link
            href="/agent"
            className="hidden h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 sm:inline-flex"
          >
            <Sparkles className="size-4" />
            Ask TCB
          </Link>
        </div>
      </div>
      <div className="border-t border-border px-4 pt-2 md:hidden">
        <NavLinks mobile />
      </div>
    </header>
  );
}
