/**
 * Price-movement quality detection.
 *
 * TCGplayer "market" is derived from active seller listings, not realized
 * transactions, so a rising market can be either real demand or "price
 * parking" (a seller re-listing high with no sales behind it). This module
 * ports the robust outlier math from the tcb-price-intelligence pipeline
 * (MAD / robust z-score + Hampel filter) and combines it with the demand and
 * narrative signals this warehouse already stores to classify a move as
 * justified vs. likely parking.
 *
 * Pure functions only — no DB or network. Shared by the agent tool and any
 * server code that needs a deterministic verdict. It NEVER produces a fair
 * value or a buy/sell recommendation; it only judges movement quality.
 */

export type MovementVerdict =
  | "justified"
  | "mixed"
  | "suspicious"
  | "likely_parking";

export interface MovementSignalInput {
  /** Recent daily market series (oldest -> newest), e.g. last 90 days. */
  marketHistory: number[];
  /** Latest daily snapshot from `daily_prices`. */
  latestMarket: number | null;
  latestLow: number | null;
  latestHigh: number | null;
  /** Rolling analytics from `price_windows`. */
  chg7dPct: number | null;
  avgMarket30d: number | null;
  /** Demand signals from `liquidity` (TCGplayer + eBay). */
  soldVelocity: number | null;
  liquidityScore: number | null;
  bidAskSpreadPct: number | null;
  /** Highest impact score among bullish/buy/hype creator posts on this card. */
  bullishCreatorImpact: number | null;
  /** eBay PSA/raw realized sold median, when available, for direction check. */
  soldCompMedian: number | null;
}

export interface MovementAssessment {
  verdict: MovementVerdict;
  confidence: number;
  reasonCodes: string[];
  metrics: Record<string, number | null>;
  /** Short rule-based summary for the LLM to expand when flagged. */
  narrativeHint: string;
  /** True when the move warrants an LLM narrative (suspicious/parking/spike). */
  needsNarrative: boolean;
}

const MAD_SCALE = 0.6745; // makes MAD a consistent estimator of stdev for normal data
const HAMPEL_SCALE = 1.4826;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

/**
 * Robust z-scores using the median + MAD (resistant to the very outliers we
 * are trying to find). Ported from tcb-price-intelligence outliers.py.
 */
export function robustZScores(values: number[]): number[] {
  const med = median(values);
  const scale = mad(values);
  if (scale === 0) return values.map(() => 0);
  return values.map((v) => (MAD_SCALE * (v - med)) / scale);
}

/**
 * Hampel filter over a centered rolling window. Returns the indices flagged as
 * temporal spikes. Ported from tcb-price-intelligence outliers.py.
 */
export function hampelSpikes(
  series: number[],
  windowSize = 7,
  nSigmas = 3,
): number[] {
  const flagged: number[] = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < series.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(series.length, i + half + 1);
    const window = series.slice(lo, hi);
    if (window.length < 3) continue;
    const med = median(window);
    const threshold = HAMPEL_SCALE * nSigmas * mad(window);
    if (threshold > 0 && Math.abs(series[i] - med) > threshold) flagged.push(i);
  }
  return flagged;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const round = (value: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
};

/**
 * Classify a price move as justified vs likely parking. Deterministic: every
 * number in `metrics` comes from the inputs, none are invented.
 */
export function detectMovementSignals(
  input: MovementSignalInput,
): MovementAssessment {
  const codes: string[] = [];
  let parking = 0;
  let justified = 0;

  const history = input.marketHistory.filter((v) => Number.isFinite(v) && v > 0);
  const latest = input.latestMarket;
  const chg7d = input.chg7dPct;

  // --- Robust outlier on the latest market vs its own history -------------
  let latestZ: number | null = null;
  if (latest !== null && history.length >= 5) {
    const z = robustZScores([...history, latest]);
    latestZ = z[z.length - 1];
    if (latestZ > 3.5) {
      codes.push("spike_detected");
      parking += 2;
    } else if (latestZ < -3.5) {
      codes.push("crash_detected");
      parking += 2;
    }
  }
  const spikeDays = history.length >= 5 ? hampelSpikes(history).length : 0;

  // --- Market vs lowest live ask (the core parking tell) ------------------
  if (latest !== null && input.latestLow !== null && input.latestLow > 0) {
    if (latest > input.latestLow * 1.15) {
      codes.push("market_low_divergence");
      parking += 2;
    }
  }
  if (input.bidAskSpreadPct !== null && input.bidAskSpreadPct < -15) {
    // market sits well above the cheapest live listing
    codes.push("market_above_live_ask");
    parking += 2;
  }

  // --- Movement without realized volume -----------------------------------
  const moving = chg7d !== null && Math.abs(chg7d) > 12;
  if (moving && input.soldVelocity !== null && input.soldVelocity < 0.1) {
    codes.push("move_without_volume");
    parking += 2;
  }
  if (
    input.liquidityScore !== null &&
    input.liquidityScore < 25 &&
    (moving || (latestZ !== null && Math.abs(latestZ) > 3.5))
  ) {
    codes.push("thin_market");
    parking += 1;
  }

  // --- Range coherence: market jumped but the 30d average barely moved ----
  if (
    moving &&
    latest !== null &&
    input.avgMarket30d !== null &&
    input.avgMarket30d > 0
  ) {
    const avgGapPct = ((latest - input.avgMarket30d) / input.avgMarket30d) * 100;
    if (Math.abs(avgGapPct) > 15) {
      codes.push("move_without_trend");
      parking += 1;
    }
  }

  // --- Demand / narrative support (pull toward justified) -----------------
  if (input.bullishCreatorImpact !== null && input.bullishCreatorImpact >= 2) {
    codes.push("creator_catalyst");
    justified += 2;
  }
  if (input.soldVelocity !== null && input.soldVelocity >= 0.5) {
    codes.push("healthy_velocity");
    justified += 1;
  }
  if (
    moving &&
    latest !== null &&
    input.soldCompMedian !== null &&
    input.soldCompMedian > 0
  ) {
    const compGap = Math.abs(latest - input.soldCompMedian) / input.soldCompMedian;
    if (compGap <= 0.1) {
      codes.push("sold_comps_confirm");
      justified += 2;
    }
  }

  // --- Verdict ------------------------------------------------------------
  const net = parking - justified;
  let verdict: MovementVerdict;
  if (net >= 4) verdict = "likely_parking";
  else if (net >= 2) verdict = "suspicious";
  else if (justified > 0 && parking <= 1) verdict = "justified";
  else verdict = "mixed";

  // --- Confidence: how much evidence we actually had ----------------------
  let confidence = 0.4;
  if (history.length >= 30) confidence += 0.2;
  if (input.soldVelocity !== null || input.liquidityScore !== null) confidence += 0.2;
  if (input.bullishCreatorImpact !== null || input.soldCompMedian !== null)
    confidence += 0.2;
  confidence = round(clamp(confidence, 0, 1), 3);

  const needsNarrative =
    verdict === "suspicious" ||
    verdict === "likely_parking" ||
    codes.includes("spike_detected") ||
    codes.includes("crash_detected");

  return {
    verdict,
    confidence,
    reasonCodes: codes,
    metrics: {
      latestMarket: latest,
      latestLow: input.latestLow,
      chg7dPct: chg7d,
      avgMarket30d: input.avgMarket30d,
      soldVelocity: input.soldVelocity,
      liquidityScore: input.liquidityScore,
      bidAskSpreadPct: input.bidAskSpreadPct,
      robustZLatest: latestZ === null ? null : round(latestZ, 2),
      hampelSpikeDays: spikeDays,
      bullishCreatorImpact: input.bullishCreatorImpact,
      soldCompMedian: input.soldCompMedian,
      parkingScore: parking,
      justifiedScore: justified,
    },
    narrativeHint: buildNarrativeHint(verdict, codes),
    needsNarrative,
  };
}

function buildNarrativeHint(
  verdict: MovementVerdict,
  codes: string[],
): string {
  const phrases: Record<string, string> = {
    spike_detected: "latest market is a robust-z outlier vs its own history",
    crash_detected: "latest market is a robust-z negative outlier",
    market_low_divergence: "market sits >15% above the lowest live listing",
    market_above_live_ask: "market is well above the cheapest live ask",
    move_without_volume: "the move has no realized sold volume behind it",
    thin_market: "the market is thin (low liquidity score)",
    move_without_trend: "the spot move is not reflected in the 30d average",
    creator_catalyst: "a high-impact creator is bullish on this card",
    healthy_velocity: "cards are actually selling (healthy velocity)",
    sold_comps_confirm: "eBay sold comps confirm the move",
  };
  const reasons = codes.map((c) => phrases[c]).filter(Boolean);
  const lead =
    verdict === "likely_parking"
      ? "Likely listing-driven price parking"
      : verdict === "suspicious"
        ? "Suspicious, listing-driven move"
        : verdict === "justified"
          ? "Move appears demand-supported"
          : "Mixed signals";
  return reasons.length ? `${lead}: ${reasons.join("; ")}.` : `${lead}.`;
}
