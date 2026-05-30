import { NextResponse } from "next/server";
import { searchCards } from "@/lib/queries";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ results: [] });
  const cards = await searchCards(q, 12);
  return NextResponse.json({
    results: cards.map((c) => ({
      productId: c.productId,
      subType: c.subType,
      name: c.name,
      setName: c.setName,
      market: c.market,
      chg30d: c.chg30d,
    })),
  });
}
