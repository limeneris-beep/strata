/**
 * Jupiter Quote Fetcher
 *
 * Fetches quotes from Jupiter API at multiple sizes to build
 * a liquidity curve. Implements rate limiting with burst support.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§4.1–4.2)
 */

const config = require('../config');

// Mint addresses
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Convert SOL to lamports (string for URL param)
 */
function solToLamports(n) {
  return String(BigInt(Math.round(n * 1e9)));
}

/**
 * Convert USDC to micro-units (string for URL param)
 */
function usdcToMicro(n) {
  return String(BigInt(Math.round(n * 1e6)));
}

/**
 * Simple rate limiter that ensures at most `maxRps` calls per second.
 * Allows small bursts via `burstSize`.
 */
class RateLimiter {
  constructor(maxRps = 1, burstSize = 3) {
    this.maxRps = maxRps;
    this.burstSize = burstSize;
    this.tokens = burstSize;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume one.
   */
  async acquire() {
    this._refill();
    while (this.tokens <= 0) {
      const waitMs = Math.ceil(1000 / this.maxRps);
      await new Promise(r => setTimeout(r, waitMs));
      this._refill();
    }
    this.tokens--;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / 1000) * this.maxRps;
    this.tokens = Math.min(this.burstSize, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

// Singleton rate limiter
const limiter = new RateLimiter(
  config.rateLimit.maxRps,
  config.rateLimit.burstSize
);

/**
 * Group ladder rungs by band for staggered sampling.
 * Returns { inner: number[], mid: number[], outer: number[] }
 */
function groupRungsByBand(ladder) {
  // Distribute ladder rungs across inner/mid/outer bands.
  // Inner: tight sizes (first ~third) — sampled every 5s
  // Mid:   medium sizes (middle ~third) — sampled every 15s
  // Outer: large sizes (last ~third) — sampled every 45s
  const n = ladder.length;
  const innerCount = Math.ceil(n * 0.375);  // ~3 of 8
  const midCount = Math.ceil(n * 0.375);    // ~3 of 8
  // rest goes to outer

  return {
    inner: ladder.slice(0, innerCount),
    mid:   ladder.slice(innerCount, innerCount + midCount),
    outer: ladder.slice(innerCount + midCount),
  };
}

/**
 * Fetch a single quote from Jupiter.
 *
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {number} amount - in base asset units (SOL or USDC)
 * @param {function} toUnits - conversion function (solToLamports or usdcToMicro)
 * @returns {Promise<object|null>} parsed quote response or null
 */
async function fetchSingleQuote(inputMint, outputMint, amount, toUnits) {
  const { baseUrl, slippageBps } = config.jupiter;
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${toUnits(amount)}&slippageBps=${slippageBps}`;

  try {
    await limiter.acquire();
    const res = await fetch(url);

    if (!res.ok) {
      console.warn(`[Jupiter] HTTP ${res.status} for size ${amount}`);
      return null;
    }

    const data = await res.json();
    if (!data || !data.inAmount || !data.outAmount) {
      console.warn(`[Jupiter] Invalid response for size ${amount}`);
      return null;
    }

    return data;
  } catch (e) {
    console.warn(`[Jupiter] Fetch error for size ${amount}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch one side of the order book (asks or bids).
 *
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {number[]} ladder - size ladder in base units
 * @param {function} toUnits - conversion function
 * @param {number[]} rungIndices - specific indices to fetch (for staggered sampling)
 * @returns {Promise<Array<{size: number, price: number, impact: number, band: string}>>}
 */
async function fetchSide(inputMint, outputMint, ladder, toUnits, rungIndices = null) {
  const indices = rungIndices || ladder.map((_, i) => i);
  const quotes = [];

  for (const idx of indices) {
    const amount = ladder[idx];
    const result = await fetchSingleQuote(inputMint, outputMint, amount, toUnits);
    if (result) {
      quotes.push({ raw: result, ladderIndex: idx, amount });
    }
  }

  // Fetch Pyth reference price for sanity checking
  let referencePrice = null;
  try {
    const { getSOLPrice } = require('./pyth');
    const pyth = await getSOLPrice();
    if (pyth && pyth.price > 0) referencePrice = pyth.price;
  } catch (_) { /* Pyth unavailable, skip validation */ }

  // Convert raw quotes to structured points
  const isBid = inputMint === USDC;
  const MAX_DEVIATION = 0.15; // reject quotes >15% from reference

  return quotes
    .map(q => {
      const { raw, amount } = q;
      const impact = parseFloat(raw.priceImpactPct) || 0;
      let band;
      if (impact <= config.bands.inner.maxImpactPct) band = 'inner';
      else if (impact <= config.bands.mid.maxImpactPct) band = 'mid';
      else band = 'outer';

      const price = isBid
        ? (Number(raw.inAmount) / Number(raw.outAmount)) * 1000
        : (Number(raw.outAmount) / Number(raw.inAmount)) * 1000;

      return {
        size: amount,
        price: +price.toFixed(4),
        impact,
        band,
        inAmount: BigInt(raw.inAmount),
        outAmount: BigInt(raw.outAmount),
      };
    })
    .filter(q => {
      if (!referencePrice) return true; // no reference, accept everything
      const deviation = Math.abs(q.price - referencePrice) / referencePrice;
      if (deviation > MAX_DEVIATION) {
        console.warn(`[Jupiter] Rejected ${isBid ? 'bid' : 'ask'} size=${q.size}: price=\$${q.price.toFixed(2)} deviates ${(deviation*100).toFixed(0)}% from Pyth ref=\$${referencePrice.toFixed(2)}`);
        return false;
      }
      return true;
    });
}

/**
 * Fetch a full curve sample (all rungs, both sides).
 * Used for initial bootstrapping or full refresh.
 *
 * @returns {Promise<{asks: Array, bids: Array}>}
 */
async function fetchFullCurve() {
  // Interleave asks and bids at the rate limiter so both sides get tokens.
  // With sequential asks-then-bids, the bid side starves after 8 asks
  // exhaust the rate-limit budget. Promise.all + singleton limiter means
  // acquisitions alternate: ask→bid→ask→bid…
  const [askQuotes, bidQuotes] = await Promise.all([
    fetchSide(SOL, USDC, config.askLadder, solToLamports),
    fetchSide(USDC, SOL, config.bidLadder, usdcToMicro),
  ]);

  return { asks: askQuotes, bids: bidQuotes };
}

/**
 * Fetch only inner band rungs for both sides.
 * Used for high-frequency refresh.
 *
 * @returns {Promise<{asks: Array, bids: Array}>}
 */
async function fetchInnerBand() {
  const askGroup = groupRungsByBand(config.askLadder);
  const bidGroup = groupRungsByBand(config.bidLadder);

  // Map amounts back to ladder indices
  const askIndices = askGroup.inner.map(a => config.askLadder.indexOf(a));
  const bidIndices = bidGroup.inner.map(b => config.bidLadder.indexOf(b));

  const [askQuotes, bidQuotes] = await Promise.all([
    fetchSide(SOL, USDC, config.askLadder, solToLamports, askIndices),
    fetchSide(USDC, SOL, config.bidLadder, usdcToMicro, bidIndices),
  ]);

  return { asks: askQuotes, bids: bidQuotes };
}

/**
 * Fetch mid band rungs.
 */
async function fetchMidBand() {
  const askGroup = groupRungsByBand(config.askLadder);
  const bidGroup = groupRungsByBand(config.bidLadder);

  const askIndices = askGroup.mid.map(a => config.askLadder.indexOf(a));
  const bidIndices = bidGroup.mid.map(b => config.bidLadder.indexOf(b));

  const [askQuotes, bidQuotes] = await Promise.all([
    fetchSide(SOL, USDC, config.askLadder, solToLamports, askIndices),
    fetchSide(USDC, SOL, config.bidLadder, usdcToMicro, bidIndices),
  ]);

  return { asks: askQuotes, bids: bidQuotes };
}

/**
 * Fetch outer band rungs.
 */
async function fetchOuterBand() {
  const askGroup = groupRungsByBand(config.askLadder);
  const bidGroup = groupRungsByBand(config.bidLadder);

  const askIndices = askGroup.outer.map(a => config.askLadder.indexOf(a));
  const bidIndices = bidGroup.outer.map(b => config.bidLadder.indexOf(b));

  const [askQuotes, bidQuotes] = await Promise.all([
    fetchSide(SOL, USDC, config.askLadder, solToLamports, askIndices),
    fetchSide(USDC, SOL, config.bidLadder, usdcToMicro, bidIndices),
  ]);

  return { asks: askQuotes, bids: bidQuotes };
}

/**
 * Fetch a fresh execution quote at a specific size.
 * Used by the matching engine for settlement-time pricing.
 *
 * @param {string} market - e.g., 'SOL/USDC'
 * @param {'ask'|'bid'} side
 * @param {number} size - in base asset units
 * @returns {Promise<object>} quote result
 */
async function getExecutionQuote(market, side, size) {
  const marketConfig = config.markets[market];
  if (!marketConfig) throw new Error(`Unknown market: ${market}`);

  const { baseMint, quoteMint } = marketConfig;
  const inputMint = side === 'ask' ? baseMint : quoteMint;
  const outputMint = side === 'ask' ? quoteMint : baseMint;
  const convert = side === 'ask' ? solToLamports : usdcToMicro;

  const result = await fetchSingleQuote(inputMint, outputMint, size, convert);
  if (!result) {
    throw new Error(`Failed to fetch execution quote for ${market} ${side} ${size}`);
  }

  const effectivePrice = side === 'ask'
    ? (Number(result.outAmount) / Number(result.inAmount)) * 1000
    : (Number(result.inAmount) / Number(result.outAmount)) * 1000;

  return {
    price: +effectivePrice.toFixed(4),
    outputAmount: result.outAmount,
    priceImpactPct: parseFloat(result.priceImpactPct) || 0,
    route: result.route || 'jupiter',
    source: 'jupiter_live',
    ts: Date.now(),
    slippageBps: config.jupiter.slippageBps,
  };
}

module.exports = {
  fetchFullCurve,
  fetchInnerBand,
  fetchMidBand,
  fetchOuterBand,
  fetchSide,
  getExecutionQuote,
  groupRungsByBand,
  RateLimiter,
};
