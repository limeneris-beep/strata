/**
 * GMM Distribution Model
 *
 * Two-component Gaussian Mixture Model for extrapolating depth
 * beyond the largest sampled size. When Jupiter quotes don't cover
 * the full depth range, the GMM provides a statistically modeled
 * tail distribution.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§5.3)
 */

const config = require('../config');

/**
 * Error function approximation (Abramowitz and Stegun).
 * Same implementation as pyth.js but included here for independence.
 */
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Standard normal CDF.
 */
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Cumulative GMM distribution at point x (log-return from mid).
 *
 * @param {number} x - log-return from mid-price: ln(price / midPrice)
 * @param {{ w1: number, σ1: number, σ2: number }} params - GMM parameters
 * @returns {number} cumulative density (0..1)
 */
function cumulativeGMM(x, params) {
  const { w1, σ1, σ2 } = params;
  const cdf1 = normCdf(x / σ1);
  const cdf2 = normCdf(x / σ2);
  return w1 * cdf1 + (1 - w1) * cdf2;
}

/**
 * Fit GMM parameters to sampled data using grid search.
 * Minimizes squared error between observed cumulative depth
 * and modeled cumulative depth.
 *
 * @param {Array<{size: number, price: number}>} sampledPoints
 * @param {number} midPrice
 * @returns {{ w1: number, σ1: number, σ2: number }} best-fit params
 */
function fitGMM(sampledPoints, midPrice) {
  if (sampledPoints.length < 3) {
    // Not enough data: return defaults
    return getDefaultParams();
  }

  // Sort by price, build cumulative sizes
  const sorted = [...sampledPoints].sort((a, b) => a.price - b.price);

  let cum = 0;
  const observations = sorted.map(p => {
    cum += p.size;
    const logRet = Math.log(p.price / midPrice);
    return { logRet, cumulativeSize: cum };
  });

  const totalCumulative = cum;
  if (totalCumulative <= 0) {
    return getDefaultParams();
  }

  // Normalize cumulative sizes to 0..1
  const normalized = observations.map(o => ({
    logRet: o.logRet,
    cumFrac: o.cumulativeSize / totalCumulative,
  }));

  // Grid search over reasonable parameter ranges
  let bestParams = null;
  let bestError = Infinity;

  const sigma1Range = [];
  for (let σ1bps = 5; σ1bps <= 30; σ1bps += 5) sigma1Range.push(σ1bps);

  const sigma2Range = [];
  for (let σ2bps = 30; σ2bps <= 150; σ2bps += 10) sigma2Range.push(σ2bps);

  for (let w1 = 0.5; w1 <= 0.95; w1 += 0.05) {
    for (const σ1bps of sigma1Range) {
      for (const σ2bps of sigma2Range) {
        const σ1 = σ1bps / 10000;
        const σ2 = σ2bps / 10000;

        const error = normalized.reduce((sum, obs) => {
          const modeled = cumulativeGMM(obs.logRet, { w1, σ1, σ2 });
          const diff = modeled - obs.cumFrac;
          return sum + diff * diff;
        }, 0);

        if (error < bestError) {
          bestError = error;
          bestParams = { w1, σ1, σ2 };
        }
      }
    }
  }

  return bestParams || getDefaultParams();
}

function getDefaultParams() {
  return {
    w1: config.depth.gmmDefaults.weight1,
    σ1: config.depth.gmmDefaults.sigma1_bps / 10000,
    σ2: config.depth.gmmDefaults.sigma2_bps / 10000,
  };
}

/**
 * Generate extrapolated levels using the fitted GMM.
 * Creates levels beyond the price range covered by sampled points.
 *
 * @param {number} midPrice
 * @param {{ w1: number, σ1: number, σ2: number }} gmmParams
 * @param {'ask'|'bid'} side
 * @param {object} bandConfig - band configuration (for bpSpacing, maxImpact)
 * @returns {Array<{price: number, size: number, cumulativeSize: number, modeled: boolean, band: string}>}
 */
function generateGMMLevels(midPrice, gmmParams, side, interpolatedLevels = [], bandConfig = null) {
  // Exponential-decay extrapolation for mid + outer bands.
  // GMM fitting needs 6+ data points to produce meaningful σ across
  // 200-1000 bps; with only inner-band Jupiter samples, it saturates
  // immediately. Instead, take whatever cumulative depth was built in
  // the inner band and decay the remainder exponentially outward.
  const bands = bandConfig || config.bands;
  const sign = side === 'ask' ? 1 : -1;
  const levels = [];

  // Anchor: deepest cumulative size from interpolated inner-band data.
  // Cap at 95% of maxCumulativeSize so there's always room for mid/outer decay,
  // even when Jupiter quotes return large cumulative sizes on the bid side.
  const rawAnchor = interpolatedLevels.length > 0
    ? interpolatedLevels[interpolatedLevels.length - 1].cumulativeSize
    : 0;
  const anchorCum = Math.min(rawAnchor, config.depth.maxCumulativeSize * 0.95);

  // Total depth pool to distribute across mid+outer
  const totalPool = Math.max(0, config.depth.maxCumulativeSize - anchorCum);
  if (totalPool <= 0.01) return levels;

  const startBp = bands.inner.bpSpacing;          // Start right outside spread (~10bp)
  const maxBpAway = bands.outer.maxImpactPct * 100;  // 1000 bps — outer band cap
  const midLimit = bands.mid.maxImpactPct * 100;      // 500 bps — mid/outer boundary

  let remaining = totalPool;
  let prevCumulative = anchorCum;
  let bpAway = startBp;

  while (bpAway <= maxBpAway && remaining > 0.001) {
    // Determine band and spacing for this level
    const isMid = bpAway < midLimit;
    const band = isMid ? 'mid' : 'outer';
    const bpSpacing = isMid ? bands.mid.bpSpacing : bands.outer.bpSpacing;

    // Exponential decay: take a fraction of remaining depth.
    // Mid band decays slowly (15%), outer decays faster (33%) per level.
    const fraction = isMid ? (bands.mid.bpSpacing / 100) : (bands.outer.bpSpacing / 150);
    const incremental = Math.min(remaining * fraction, config.depth.maxSizePerLevel);

    if (incremental >= 0.001) {
      const cumulative = prevCumulative + incremental;
      remaining -= incremental;

      levels.push({
        price: +((midPrice * (1 + sign * bpAway / 10000)).toFixed(4)),
        size: Math.min(+incremental.toFixed(4), config.depth.maxSizePerLevel),
        cumulativeSize: +cumulative.toFixed(4),
        band,
        modeled: true,
        interpolated: true,
      });

      prevCumulative = cumulative;
    }

    bpAway += bpSpacing;
  }

  return levels;
}

module.exports = {
  erf,
  normCdf,
  cumulativeGMM,
  fitGMM,
  generateGMMLevels,
  getDefaultParams,
};
