/**
 * PCHIP Interpolator
 *
 * Piecewise Cubic Hermite Interpolating Polynomial for interpolating
 * between sampled Jupiter quote points. PCHIP preserves monotonicity
 * and doesn't overshoot — critical for depth curves where deeper
 * liquidity should always give worse prices.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§5.2)
 */

/**
 * Compute slopes for PCHIP interpolation.
 * PCHIP preserves monotonicity by setting the derivative to zero
 * at points where the slope changes sign.
 *
 * @param {number[]} x - x values (prices), sorted ascending
 * @param {number[]} y - y values (cumulative sizes)
 * @returns {number[]} derivatives at each point
 */
function computePchipSlopes(x, y) {
  const n = x.length;
  if (n < 2) return new Array(n).fill(0);

  const h = [];    // interval lengths
  const delta = []; // slopes of intervals

  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i]);
    delta.push((y[i + 1] - y[i]) / h[i]);
  }

  // Compute slopes at interior points
  const p = new Array(n);
  p[0] = delta[0]; // Non-centered at endpoints (will be adjusted)
  p[n - 1] = delta[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] > 0) {
      // Same sign: weighted harmonic mean
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      p[i] = (w1 * delta[i - 1] + w2 * delta[i]) / (w1 + w2);
    } else {
      // Sign change or zero: force flat derivative to preserve monotonicity
      p[i] = 0;
    }
  }

  // Adjust endpoints for monotonicity
  // If slope at endpoint would cause overshoot, set to zero
  if (n >= 3) {
    if (p[0] * delta[0] < 0) p[0] = 0;
    if (p[n - 1] * delta[n - 2] < 0) p[n - 1] = 0;
  }

  return p;
}

/**
 * Evaluate the PCHIP cubic polynomial at a given x value.
 *
 * @param {number} x0 - start of interval
 * @param {number} x1 - end of interval
 * @param {number} y0 - value at x0
 * @param {number} y1 - value at x1
 * @param {number} p0 - derivative at x0
 * @param {number} p1 - derivative at x1
 * @param {number} x - point to evaluate at
 * @returns {number} interpolated value
 */
function evalCubicHermite(x0, x1, y0, y1, p0, p1, x) {
  const h = x1 - x0;
  if (h === 0) return y0;

  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;

  // Hermite basis functions
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * y0 + h10 * h * p0 + h01 * y1 + h11 * h * p1;
}

/**
 * Interpolate between sampled price points to create a continuous
 * set of levels at the specified basis point spacing.
 *
 * @param {Array<{size: number, price: number}>} sampledPoints
 *   Sampled points from Jupiter ladder. Each has `size` (cumulative or individual)
 *   and `price`. At least 2 points needed.
 * @param {number} targetBpSpacing - spacing between output levels in basis points
 * @returns {Array<{price: number, size: number, cumulativeSize: number, interpolated: boolean}>}
 */
function interpolateLevels(sampledPoints, targetBpSpacing = 10, maxPriceOverride = null) {
  if (sampledPoints.length < 2) {
    // Not enough points to interpolate — return as-is
    return sampledPoints.map(s => ({
      price: s.price,
      size: s.size,
      cumulativeSize: s.size,
      interpolated: false,
    }));
  }

  // Sort by price ascending
  const sorted = [...sampledPoints].sort((a, b) => a.price - b.price);

  // Build cumulative sizes from the ladder
  // (each point's size is the incremental amount at that rung)
  let cum = 0;
  const cumulativePoints = sorted.map(p => {
    cum += p.size;
    return { price: p.price, cumulativeSize: cum, size: p.size };
  });

  const prices = cumulativePoints.map(p => p.price);
  const sizes = cumulativePoints.map(p => p.cumulativeSize);

  // Compute PCHIP slopes
  const slopes = computePchipSlopes(prices, sizes);

  // Mid-price is the first (smallest) ask price or last (smallest) bid price
  const midPrice = cumulativePoints[0].price;
  const maxPrice = maxPriceOverride || cumulativePoints[cumulativePoints.length - 1].price;

  // Build output price ladder at targetBpSpacing intervals
  const levels = [];
  let currentPrice = midPrice * (1 + targetBpSpacing / 10000);
  const bpFraction = targetBpSpacing / 10000;

  let lastCumulative = 0;
  let lastOutputPrice = midPrice;

  while (currentPrice <= maxPrice * 1.001) {
    // Find which interval we're in
    let intervalIdx = -1;
    for (let i = 0; i < prices.length - 1; i++) {
      if (currentPrice >= prices[i] && currentPrice <= prices[i + 1]) {
        intervalIdx = i;
        break;
      }
    }

    if (intervalIdx === -1) {
      // Extrapolate using the last segment's slope
      if (currentPrice > prices[prices.length - 1]) {
        const lastSlope = slopes[slopes.length - 1];
        const extrapolatedSize = sizes[sizes.length - 1] +
          lastSlope * (currentPrice - prices[prices.length - 1]);
        const incremental = Math.max(0, extrapolatedSize - lastCumulative);

        if (incremental > 0.001) {
          levels.push({
            price: +currentPrice.toFixed(4),
            size: +incremental.toFixed(4),
            cumulativeSize: extrapolatedSize,
            interpolated: true,
          });
          lastCumulative = extrapolatedSize;
          lastOutputPrice = currentPrice;
        }
      }
      currentPrice *= (1 + bpFraction);
      continue;
    }

    // Interpolate using cubic Hermite
    const x0 = prices[intervalIdx];
    const x1 = prices[intervalIdx + 1];
    const y0 = sizes[intervalIdx];
    const y1 = sizes[intervalIdx + 1];
    const p0 = slopes[intervalIdx];
    const p1 = slopes[intervalIdx + 1];

    const interpolatedCumulative = evalCubicHermite(x0, x1, y0, y1, p0, p1, currentPrice);
    const incremental = Math.max(0, interpolatedCumulative - lastCumulative);

    if (incremental > 0.001) {
      levels.push({
        price: +currentPrice.toFixed(4),
        size: +incremental.toFixed(4),
        cumulativeSize: interpolatedCumulative,
        interpolated: true,
      });
      lastCumulative = interpolatedCumulative;
      lastOutputPrice = currentPrice;
    }

    currentPrice *= (1 + bpFraction);
  }

  return levels;
}

/**
 * Convenience: interpolate both ask and bid sides.
 *
 * @param {Array} askPoints
 * @param {Array} bidPoints
 * @param {number} bpSpacing
 * @returns {{asks: Array, bids: Array}}
 */
function interpolateBothSides(askPoints, bidPoints, bpSpacing = 10) {
  return {
    asks: interpolateLevels(askPoints, bpSpacing),
    bids: interpolateLevels(bidPoints, bpSpacing),
  };
}

module.exports = {
  computePchipSlopes,
  evalCubicHermite,
  interpolateLevels,
  interpolateBothSides,
};
