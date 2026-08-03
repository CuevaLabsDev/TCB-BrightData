/**
 * Consumption vs replenishment from consecutive liquidity snapshots.
 *
 * Consumption  = sold velocity (qty/day)
 * Replenishment = positive growth in listing depth per day
 * Absorption   = consumption / max(replenishment, eps)
 */

export interface DepthSnapshot {
  asOf: Date;
  activeListings: number | null;
  totalQuantity: number | null;
  soldVelocity: number | null;
}

export interface AbsorptionMetrics {
  listingsDelta: number | null;
  qtyDelta: number | null;
  consumptionRate: number | null;
  replenishmentRate: number | null;
  absorptionRatio: number | null;
  /** Score adjustment in [-10, +10] for the composite liquidity score. */
  scoreDelta: number;
}

const EPS = 0.05;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Derive absorption metrics comparing current depth to the prior snapshot. */
export function computeAbsorption(
  current: DepthSnapshot,
  prior: DepthSnapshot | null,
): AbsorptionMetrics {
  const consumptionRate =
    current.soldVelocity !== null && Number.isFinite(current.soldVelocity)
      ? round2(current.soldVelocity)
      : null;

  if (!prior) {
    return {
      listingsDelta: null,
      qtyDelta: null,
      consumptionRate,
      replenishmentRate: null,
      absorptionRatio: null,
      scoreDelta: 0,
    };
  }

  const ms = current.asOf.getTime() - prior.asOf.getTime();
  const days = Math.max(1 / 24, ms / (24 * 60 * 60 * 1000)); // min ~1 hour

  const listingsDelta =
    current.activeListings !== null && prior.activeListings !== null
      ? current.activeListings - prior.activeListings
      : null;
  const qtyDelta =
    current.totalQuantity !== null && prior.totalQuantity !== null
      ? current.totalQuantity - prior.totalQuantity
      : null;

  const depthDelta = qtyDelta !== null ? qtyDelta : listingsDelta;
  const replenishmentRate =
    depthDelta !== null && depthDelta > 0 ? round2(depthDelta / days) : depthDelta !== null ? 0 : null;

  let absorptionRatio: number | null = null;
  if (consumptionRate !== null && replenishmentRate !== null) {
    absorptionRatio = round4(consumptionRate / Math.max(replenishmentRate, EPS));
  }

  // Tightening (high absorption) adds up to +10; supply piling up subtracts up to -10.
  let scoreDelta = 0;
  if (absorptionRatio !== null) {
    if (absorptionRatio >= 2) scoreDelta = 10;
    else if (absorptionRatio >= 1) scoreDelta = 5;
    else if (absorptionRatio >= 0.5) scoreDelta = 0;
    else if (absorptionRatio >= 0.2) scoreDelta = -5;
    else scoreDelta = -10;
  } else if (
    consumptionRate !== null &&
    consumptionRate > 0.5 &&
    replenishmentRate === 0
  ) {
    // Selling with flat/shrinking supply — tight market.
    scoreDelta = 8;
  }

  return {
    listingsDelta,
    qtyDelta,
    consumptionRate,
    replenishmentRate,
    absorptionRatio,
    scoreDelta,
  };
}

/** Apply absorption score delta to a base 0–100 liquidity score. */
export function applyAbsorptionToScore(baseScore: number, scoreDelta: number): number {
  return Math.round(Math.min(100, Math.max(0, baseScore + scoreDelta)));
}
