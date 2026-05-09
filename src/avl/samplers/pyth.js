/**
 * Pyth Oracle Price Fetcher
 *
 * Fetches mid-price from Pyth oracle via Hermes API.
 * Used as second fallback when Jupiter and Binance are unavailable.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§4.5)
 */

const config = require('../config');

// Pyth price feed IDs for common assets
const PRICE_FEED_IDS = {
  'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};

/**
 * Fetch the latest price from Pyth Hermes API.
 *
 * @param {string} feedId - Pyth price feed ID (hex)
 * @returns {Promise<{price: number, conf: number, timestamp: number}>}
 */
async function fetchPriceFeed(feedId) {
  const url = `${config.fallback.pythPriceFeed}?ids[]=${feedId}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pyth HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.parsed || data.parsed.length === 0) {
    throw new Error('Pyth: no price data returned');
  }

  const feed = data.parsed[0];
  const priceData = feed.price;

  // Pyth prices are in fixed-point format
  const price = Number(priceData.price) * Math.pow(10, priceData.expo);
  const conf = Number(priceData.conf) * Math.pow(10, priceData.expo);

  return {
    price,
    conf,
    timestamp: priceData.publish_time * 1000,
  };
}

/**
 * Get mid-price for SOL/USDC from Pyth.
 *
 * @returns {Promise<{price: number, conf: number, ts: number}>}
 */
async function getSOLPrice() {
  const result = await fetchPriceFeed(PRICE_FEED_IDS['SOL/USD']);
  return {
    price: result.price,
    conf: result.conf,
    ts: result.timestamp,
    source: 'pyth',
  };
}

/**
 * Generate a modeled curve around the Pyth oracle price.
 * Used when we have no exchange data at all.
 *
 * @param {number} midPrice - from Pyth oracle
 * @returns {object} curve with modeled asks/bids
 */
function generateModeledCurve(midPrice) {
  const { gmmDefaults } = config.depth;
  const w1 = gmmDefaults.weight1;
  const σ1 = gmmDefaults.sigma1_bps / 10000;
  const σ2 = gmmDefaults.sigma2_bps / 10000;

  const asks = [];
  const bids = [];
  const maxLevels = 30;
  const bpStep = 10; // 10 bps between levels

  // Generate cumulative distribution using GMM
  for (let i = 1; i <= maxLevels; i++) {
    const bpAway = i * bpStep;
    const logRet = bpAway / 10000;

    // CDF of zero-mean normals
    const cdf1 = 0.5 * (1 + erf(logRet / (σ1 * Math.SQRT2)));
    const cdf2 = 0.5 * (1 + erf(logRet / (σ2 * Math.SQRT2)));
    const cumulative = w1 * cdf1 + (1 - w1) * cdf2;

    const cumulativeSize = cumulative * config.depth.maxCumulativeSize;
    const prevCumulative = ((i - 1) / maxLevels) * config.depth.maxCumulativeSize * 0.5;
    const incremental = Math.max(0, cumulativeSize - prevCumulative);

    if (incremental > 0.01) {
      asks.push({
        price: +((midPrice * (1 + bpAway / 10000)).toFixed(3)),
        size: Math.min(incremental, config.depth.maxSizePerLevel),
        cumulativeSize,
        band: bpAway <= config.bands.inner.maxImpactPct * 100 ? 'inner' : 'mid',
        source: 'pyth_modeled',
        interpolated: true,
        modeled: true,
      });

      bids.push({
        price: +((midPrice * (1 - bpAway / 10000)).toFixed(3)),
        size: Math.min(incremental, config.depth.maxSizePerLevel),
        cumulativeSize,
        band: bpAway <= config.bands.inner.maxImpactPct * 100 ? 'inner' : 'mid',
        source: 'pyth_modeled',
        interpolated: true,
        modeled: true,
      });
    }
  }

  return {
    asks: asks.sort((a, b) => a.price - b.price),
    bids: bids.sort((a, b) => b.price - a.price),
    midPrice,
    source: 'pyth_modeled',
    ts: Date.now(),
  };
}

/**
 * Error function approximation (Abramowitz and Stegun).
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

module.exports = {
  fetchPriceFeed,
  getSOLPrice,
  generateModeledCurve,
};
