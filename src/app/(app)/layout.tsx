import { Header } from "@/components/header";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none fixed inset-0 grid-bg opacity-40" />
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-accent/10 to-transparent" />
      <div className="relative flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
        <footer className="border-t border-border px-4 py-5 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-subtle">
            <span>Trading Card Block · The card market, unified</span>
            <span>Price · Liquidity · Grades · Creators · Alerts</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
