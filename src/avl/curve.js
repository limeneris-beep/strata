/**
 * Curve Builder
 *
 * Merges interpolated levels from Jupiter samples with GMM-extrapolated
 * levels, applies volatility adjustment, and tags levels with TTLs.
 * Produces the final CurveSnapshot consumed by the serving layer.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§5.4)
 */

const config = require('./config');
const { interpolateLevels } = require('./model/interpolator');
const { fitGMM, generateGMMLevels } = require('./model/distributor');
const { calculateSpread, applyVolatilityAdjustment, VolatilityTracker } = require('./model/volatility');

// Singleton volatility tracker
const volatilityTracker = new VolatilityTracker(config.volatility.windowMinutes);

/**
 * Determine which band a level belongs to based on bp distance from mid.
 *
 * @param {number} bpFromMid - basis points away from mid-price
 * @returns {'inner'|'mid'|'outer'}
 */
function getBand(bpFromMid) {
  const { bands } = config;
  if (bpFromMid <= bands.inner.maxImpactPct * 100) return 'inner';
  if (bpFromMid <= bands.mid.maxImpactPct * 100) return 'mid';
  return 'outer';
}

/**
 * Get TTL in ms for a given band.
 *
 * @param {'inner'|'mid'|'outer'} band
 * @returns {number} TTL in milliseconds
 */
function getBandTtl(band) {
  return config.bands[band].ttl;
}

/**
 * Get the bp spacing for a given band.
 */
function getBandBpSpacing(band) {
  return config.bands[band].bpSpacing;
}

/**
 * Merge interpolated levels (from Jupiter samples) with extrapolated
 * levels (from GMM). Interpolated levels take priority; GMM fills gaps
 * beyond the sampled range.
 *
 * @param {Array} interpolated - levels from PCHIP interpolation
 * @param {Array} extrapolated - levels from GMM model
 * @param {number} maxLevels - max levels per side to include
 * @returns {Array} merged and capped levels
 */
function mergeLevels(interpolated, extrapolated, maxLevels) {
  if (interpolated.length === 0) return extrapolated.slice(0, maxLevels);
  if (extrapolated.length === 0) return interpolated.slice(0, maxLevels);

  // Detect direction from the extrapolated data itself:
  // asks → extrapolation has higher prices than interpolation
  // bids → extrapolation has lower prices than interpolation
  const avgInterp = interpolated.reduce((s, l) => s + l.price, 0) / interpolated.length;
  const avgExtra = extrapolated.reduce((s, l) => s + l.price, 0) / extrapolated.length;
  const extrapolationGoesUp = avgExtra > avgInterp;

  // Boundary: the edge of interpolation facing the extrapolation side
  const boundary = extrapolationGoesUp
    ? Math.max(...interpolated.map(l => l.price))   // asks: highest interp price
    : Math.min(...interpolated.map(l => l.price));  // bids: lowest interp price

  const merged = [...interpolated];

  for (const level of extrapolated) {
    const qualifies = extrapolationGoesUp
      ? level.price > boundary
      : level.price < boundary;
    if (qualifies) merged.push(level);
  }

  // Sort consistently
  merged.sort((a, b) => extrapolationGoesUp ? a.price - b.price : b.price - a.price);

  return merged.slice(0, maxLevels);
}

/**
 * Smooth level sizes using a rolling average window.
 *
 * @param {Array} levels
 * @param {number} windowSize
 * @returns {Array}
 */
function smoothLevels(levels, windowSize = 3) {
  if (levels.length < 2 || windowSize < 2) return levels;

  return levels.map((l, i) => {
    if (i === 0 || i === levels.length - 1) return l;

    let sum = l.size;
    let count = 1;
    for (let j = 1; j < windowSize; j++) {
      if (i - j >= 0) { sum += levels[i - j].size; count++; }
      if (i + j < levels.length) { sum += levels[i + j].size; count++; }
    }

    return { ...l, size: +(sum / count).toFixed(4) };
  });
}

/**
 * Determine source string for a level.
 */
function determineSource(level) {
  if (level.source) return level.source;
  if (level.modeled) return 'gmm_model';
  if (level.interpolated) return 'jupiter_interpolated';
  return 'jupiter_sampled';
}

/**
 * Build a complete curve snapshot from sampled ask/bid points.
 *
 * @param {Array} askSampled - sampled ask points from Jupiter
 * @param {Array} bidSampled - sampled bid points from Jupiter
 * @returns {object} CurveSnapshot
 */
function buildCurve(askSampled, bidSampled) {
  const midPrice = estimateMidPrice(askSampled, bidSampled);

  // Record mid-price for volatility tracking
  if (midPrice > 0) {
    volatilityTracker.record(midPrice);
  }

  const volFactor = volatilityTracker.getVolatilityFactor();
  const spreadBps = calculateSpread(midPrice, volFactor);
  const bands = config.bands;

  // 1. Fit GMM from Jupiter samples (for calibration — skip interpolator)
  const gmmAskParams = fitGMM(askSampled, midPrice);
  const gmmBidParams = fitGMM(bidSampled, midPrice);

  // 2. Generate levels via exponential decay from near-mid (10bp) to outer (1000bp)
  //    Pass empty interpolated so GMM starts fresh with full 800 SOL pool
  const mergedAsks = generateGMMLevels(midPrice, gmmAskParams, 'ask', [], bands);
  const mergedBids = generateGMMLevels(midPrice, gmmBidParams, 'bid', [], bands);

  // 3. Limit to max virtual levels
  const cappedAsks = mergedAsks.slice(0, config.markets['SOL/USDC'].maxVirtualLevels);
  const cappedBids = mergedBids.slice(0, config.markets['SOL/USDC'].maxVirtualLevels);

  // 4. Smooth level sizes
  const smoothedAsks = smoothLevels(cappedAsks, config.depth.smoothingWindow);
  const smoothedBids = smoothLevels(cappedBids, config.depth.smoothingWindow);

  // 6. Apply volatility adjustment
  const adjustedAsks = applyVolatilityAdjustment(smoothedAsks, volFactor);
  const adjustedBids = applyVolatilityAdjustment(smoothedBids, volFactor);

  // 7. Tag with TTLs and timestamps
  const now = Date.now();
  const taggedAsks = adjustedAsks.map(l => {
    const bpFromMid = ((l.price - midPrice) / midPrice) * 10000;
    const band = getBand(Math.abs(bpFromMid));
    const baseTtl = getBandTtl(band);
    return {
      price: l.price,
      size: Math.min(l.size, config.depth.maxSizePerLevel),
      cumulativeSize: l.cumulativeSize || 0,
      band,
      ttl: baseTtl,
      expiresAt: now + baseTtl,
      source: determineSource(l),
      interpolated: l.interpolated || false,
      modeled: l.modeled || false,
      type: 'virtual',
      ts: now,
    };
  });

  const taggedBids = adjustedBids.map(l => {
    const bpFromMid = ((midPrice - l.price) / midPrice) * 10000;
    const band = getBand(Math.abs(bpFromMid));
    const baseTtl = getBandTtl(band);
    return {
      price: l.price,
      size: Math.min(l.size, config.depth.maxSizePerLevel),
      cumulativeSize: l.cumulativeSize || 0,
      band,
      ttl: baseTtl,
      expiresAt: now + baseTtl,
      source: determineSource(l),
      interpolated: l.interpolated || false,
      modeled: l.modeled || false,
      type: 'virtual',
      ts: now,
    };
  });

  // Sort asks ascending, bids descending
  taggedAsks.sort((a, b) => a.price - b.price);
  taggedBids.sort((a, b) => b.price - a.price);

  const volatilityPct = volatilityTracker.getVolatility() * 100;

  return {
    asks: taggedAsks,
    bids: taggedBids,
    midPrice: +midPrice.toFixed(4),
    spread: spreadBps,
    spreadBps: +spreadBps.toFixed(2),
    volatility: +volatilityPct.toFixed(1),
    volatilityFactor: +volFactor.toFixed(2),
    source: 'jupiter',
    ts: now,
    askCount: taggedAsks.length,
    bidCount: taggedBids.length,
  };
}

/**
 * Estimate mid-price from the smallest sampled points.
 * Uses the first (smallest) ask and last (smallest) bid.
 *
 * @param {Array} askSampled
 * @param {Array} bidSampled
 * @returns {number}
 */
function estimateMidPrice(askSampled, bidSampled) {
  if (askSampled.length > 0 && bidSampled.length > 0) {
    const bestAsk = Math.min(...askSampled.map(a => a.price));
    const bestBid = Math.max(...bidSampled.map(b => b.price));
    return (bestAsk + bestBid) / 2;
  }
  if (askSampled.length > 0) {
    return Math.min(...askSampled.map(a => a.price));
  }
  if (bidSampled.length > 0) {
    return Math.max(...bidSampled.map(b => b.price));
  }
  return 150; // Fallback to ~$150 for SOL
}

/**
 * Build a curve with only modeled data (no real samples).
 * Used as last-resort fallback.
 *
 * @param {number} midPrice
 * @returns {object} CurveSnapshot
 */
function buildModeledOnlyCurve(midPrice) {
  // Create synthetic sample points centered at midPrice
  const syntheticSample = [
    { size: 1, price: midPrice * 1.001 },
    { size: 5, price: midPrice * 1.005 },
    { size: 20, price: midPrice * 1.02 },
  ];

  const syntheticBidSample = [
    { size: 1, price: midPrice * 0.999 },
    { size: 5, price: midPrice * 0.995 },
    { size: 20, price: midPrice * 0.98 },
  ];

  return buildCurve(syntheticSample, syntheticBidSample);
}

module.exports = {
  buildCurve,
  buildModeledOnlyCurve,
  mergeLevels,
  smoothLevels,
  estimateMidPrice,
  getBand,
  getBandTtl,
  volatilityTracker,
};
