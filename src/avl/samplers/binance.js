/**
 * Binance Fallback Sampler
 *
 * Fetches top-of-book and depth data from Binance.US REST API.
 * Used as first fallback when Jupiter is unavailable.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§4.5)
 */

const config = require('../config');

/**
 * Map our market notation to Binance symbol.
 */
function toBinanceSymbol(market) {
  const map = {
    'SOL/USDC': 'SOLUSDC',
    'SOL/USDT': 'SOLUSDT',
  };
  return map[market] || market.replace('/', '');
}

/**
 * Fetch top-of-book ticker from Binance.
 *
 * @param {string} market - e.g., 'SOL/USDC'
 * @returns {Promise<{bidPrice: number, askPrice: number, midPrice: number}>}
 */
async function fetchTicker(market) {
  const symbol = toBinanceSymbol(market);
  const url = `${config.fallback.binanceBase}/ticker/bookTicker?symbol=${symbol}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance ticker HTTP ${res.status}`);
  }

  const data = await res.json();
  const bidPrice = parseFloat(data.bidPrice);
  const askPrice = parseFloat(data.askPrice);

  return {
    bidPrice,
    askPrice,
    midPrice: (bidPrice + askPrice) / 2,
    spread: askPrice - bidPrice,
    spreadBps: ((askPrice - bidPrice) / ((bidPrice + askPrice) / 2)) * 10000,
  };
}

/**
 * Fetch depth snapshot from Binance.
 *
 * @param {string} market - e.g., 'SOL/USDC'
 * @param {number} limit - depth levels (max 1000, default 100)
 * @returns {Promise<{bids: Array, asks: Array}>}
 */
async function fetchDepth(market, limit = 100) {
  const symbol = toBinanceSymbol(market);
  const url = `${config.fallback.binanceBase}/depth?symbol=${symbol}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance depth HTTP ${res.status}`);
  }

  const data = await res.json();

  // Convert to our format: [{ price, size, band }]
  const bids = data.bids.map(([price, size]) => ({
    price: parseFloat(price),
    size: parseFloat(size),
    band: 'mid', // Binance depth is used as mid-band fallback
    source: 'binance',
  }));

  const asks = data.asks.map(([price, size]) => ({
    price: parseFloat(price),
    size: parseFloat(size),
    band: 'mid',
    source: 'binance',
  }));

  return { bids, asks };
}

/**
 * Infer a depth curve from Binance data.
 * Converts CEX depth into our virtual order format.
 *
 * @param {string} market
 * @returns {Promise<{asks: Array, bids: Array, midPrice: number, source: string}>}
 */
async function inferCurveFromCEX(market) {
  const ticker = await fetchTicker(market);
  const depth = await fetchDepth(market, 20);

  // Scale down CEX sizes to approximate Solana AMM liquidity
  const scaleFactor = 0.01; // 1% of CEX depth (conservative)
  const scaledBids = depth.bids.map(b => ({
    ...b,
    size: b.size * scaleFactor,
    price: b.price,
    band: b.size > 100 ? 'outer' : 'mid',
    source: 'binance',
  }));

  const scaledAsks = depth.asks.map(a => ({
    ...a,
    size: a.size * scaleFactor,
    price: a.price,
    band: a.size > 100 ? 'outer' : 'mid',
    source: 'binance',
  }));

  return {
    asks: scaledAsks,
    bids: scaledBids,
    midPrice: ticker.midPrice,
    spread: ticker.spread,
    spreadBps: ticker.spreadBps,
    source: 'binance',
  };
}

module.exports = {
  fetchTicker,
  fetchDepth,
  inferCurveFromCEX,
};
