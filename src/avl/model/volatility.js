/**
 * Volatility Calculator
 *
 * Tracks price volatility over a configurable window and computes
 * adjustment factors for spread widening and depth shrinking.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§6.2)
 */

const config = require('../config');

/**
 * Ring buffer for storing recent mid-price observations.
 */
class VolatilityTracker {
  constructor(windowMinutes = 5) {
    this.windowMs = windowMinutes * 60 * 1000;
    this.samples = []; // [{ price, ts }]
    this.annualizedVol = config.volatility.normalVol;
  }

  /**
   * Record a mid-price observation.
   *
   * @param {number} price - current mid-price
   */
  record(price) {
    const now = Date.now();
    this.samples.push({ price, ts: now });
    this._prune(now);
    this._recompute(now);
  }

  /**
   * Remove samples outside the time window.
   */
  _prune(now) {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }
  }

  /**
   * Recompute annualized volatility from recent samples.
   */
  _recompute(now) {
    if (this.samples.length < 10) {
      // Not enough data yet; use default
      this.annualizedVol = config.volatility.normalVol;
      return;
    }

    // Compute log returns
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let i = 1; i < this.samples.length; i++) {
      const r = Math.log(this.samples[i].price / this.samples[i - 1].price);
      // Filter out extreme outliers (>5% in one tick)
      if (Math.abs(r) > 0.05) continue;
      sum += r;
      sumSq += r * r;
      count++;
    }

    if (count < 5) {
      this.annualizedVol = config.volatility.normalVol;
      return;
    }

    const mean = sum / count;
    const variance = (sumSq - count * mean * mean) / (count - 1);
    const sampleStd = Math.sqrt(Math.max(0, variance));

    // Time span in years
    const timeSpanMs = this.samples[this.samples.length - 1].ts - this.samples[0].ts;
    const timeSpanYears = timeSpanMs / (365.25 * 86400 * 1000);

    if (timeSpanYears <= 0) {
      this.annualizedVol = config.volatility.normalVol;
      return;
    }

    // Annualize: σ_annual = σ_sample / √(Δt in years)
    this.annualizedVol = sampleStd / Math.sqrt(timeSpanYears);

    // Clamp to reasonable range
    this.annualizedVol = Math.max(0.05, Math.min(this.annualizedVol, 5.0));
  }

  /**
   * Get the current annualized volatility estimate.
   *
   * @returns {number} annualized volatility (e.g., 0.5 = 50%)
   */
  getVolatility() {
    return this.annualizedVol;
  }

  /**
   * Get the volatility factor (current / normal).
   * factor > 1 means elevated volatility → widen spread, shrink depth.
   *
   * @returns {number}
   */
  getVolatilityFactor() {
    const normalVol = config.volatility.normalVol;
    const factor = this.annualizedVol / normalVol;
    return Math.min(factor, config.volatility.extremeThreshold);
  }

  /**
   * Get number of samples in the window.
   */
  sampleCount() {
    return this.samples.length;
  }

  /**
   * Clear all samples.
   */
  reset() {
    this.samples = [];
    this.annualizedVol = config.volatility.normalVol;
  }
}

/**
 * Calculate spread in basis points given mid-price and volatility.
 *
 * @param {number} midPrice - current mid price
 * @param {number} volatilityFactor - current vol / normal vol
 * @returns {number} spread in basis points
 */
function calculateSpread(midPrice, volatilityFactor = 1.0) {
  const baseBps = config.spread.baseBps;
  const volMultiplier = config.spread.volatilityMultiplier;

  // σ_tick = annualized vol * sqrt(sample interval / year)
  const sampleIntervalSeconds = 5; // Average sampling interval
  const secondsPerYear = 365.25 * 86400;

  // Use the volatility factor to estimate current σ
  const sigmaAnnual = config.volatility.normalVol * volatilityFactor;
  const sigmaTick = sigmaAnnual * Math.sqrt(sampleIntervalSeconds / secondsPerYear);

  const spreadBps = baseBps + sigmaTick * 10000 * volMultiplier;

  // Clamp
  return Math.max(config.spread.minBps, Math.min(spreadBps, config.spread.maxBps));
}

/**
 * Apply volatility adjustment to a set of levels.
 *
 * High volatility:
 *   1. Level sizes shrink (liquidity providers pull orders)
 *   2. TTLs increase (less frequent updates acceptable)
 *
 * @param {Array} levels - array of level objects
 * @param {number} volFactor - current vol / normal vol
 * @returns {Array} adjusted levels
 */
function applyVolatilityAdjustment(levels, volFactor) {
  if (volFactor <= 1.0) return levels; // Normal conditions, no adjustment

  const sizeMultiplier = 1 / volFactor; // 2x vol → half the size
  const ttlMultiplier = Math.sqrt(volFactor); // 2x vol → 1.4x longer TTL

  return levels.map(l => ({
    ...l,
    size: l.size * sizeMultiplier,
    ttl: l.baseTtl ? l.baseTtl * ttlMultiplier : l.ttl,
  }));
}

module.exports = {
  VolatilityTracker,
  calculateSpread,
  applyVolatilityAdjustment,
};
