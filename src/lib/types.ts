// Shared domain types for the Trading Card Block warehouse + intel layers.

export interface CardSummary {
  productId: number;
  subType: string;
  name: string;
  cleanName: string | null;
  imageUrl: string | null;
  groupId: number | null;
  setName: string | null;
  setAbbr: string | null;
  number: string | null;
  rarity: string | null;
  cardType: string | null;
  url: string | null;
  isSealed: boolean;
  market: number | null;
  chg7d: number | null;
  chg30d: number | null;
  chg90d: number | null;
  chg180d: number | null;
  high180d: number | null;
  low180d: number | null;
  volatility30d: number | null;
  movementVerdict: string | null;
}

export interface PricePoint {
  date: string;
  low: number | null;
  mid: number | null;
  high: number | null;
  market: number | null;
}

export interface SetSummary {
  groupId: number;
  name: string;
  abbreviation: string | null;
  publishedOn: string | null;
  cardCount: number;
  avgMarket: number | null;
  totalMarket: number | null;
  avgChg30d: number | null;
}

export interface Liquidity {
  productId: number;
  subType: string;
  source: string;
  activeListings: number | null;
  totalQuantity: number | null;
  avgDailyQtySold: number | null;
  totalQtySold90d: number | null;
  soldVelocity: number | null;
  bidAskSpreadPct: number | null;
  liquidityScore: number | null;
  asOf: string;
}

export interface GradedComp {
  productId: number;
  grader: string;
  grade: number;
  sampleSize: number | null;
  /** Mean of outlier-filtered eBay sold prices. */
  avgSold: number | null;
  /** Converged PSA market = trimmed median of sold prices. */
  lastSold: number | null;
  rawMarket: number | null;
  gradeMultiple: number | null;
  /** eBay PSA solds per day over the dated lookback window. */
  soldPerDay: number | null;
  /** Approximate monthly velocity (soldPerDay * 30). */
  soldPerMonth: number | null;
  asOf: string;
}

export interface Creator {
  id: number;
  handle: string;
  platform: string;
  displayName: string | null;
  followers: number | null;
  url: string | null;
  impactScore: number;
  flagged: boolean;
}

export interface CreatorPost {
  id: number;
  creatorId: number | null;
  handle: string | null;
  platform: string;
  postUrl: string | null;
  postedAt: string | null;
  caption: string | null;
  likes: number | null;
  views: number | null;
  sentiment: string | null;
  signal: string | null;
  mentionedProducts: number[] | null;
  summary: string | null;
  impactPct: number | null;
}

export interface Signal {
  id: number;
  kind: string;
  severity: "info" | "watch" | "act";
  productId: number | null;
  subType: string | null;
  creatorId: number | null;
  title: string;
  body: string | null;
  metrics: Record<string, unknown> | null;
  links: Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

export interface MarketMemory {
  id: number;
  scope: string;
  periodStart: string | null;
  periodEnd: string | null;
  title: string | null;
  narrative: string;
  tags: string[] | null;
  metrics: Record<string, unknown> | null;
  createdAt: string;
}

export interface MarketStats {
  products: number;
  sets: number;
  trackedSeries: number;
  dailyRows: number;
  asOf: string | null;
  totalMarketValue: number | null;
}
