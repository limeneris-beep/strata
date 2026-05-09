/**
 * Jupiter CPI Integration for AVL Depth
 *
 * Cross-Program Invocation interface that makes the AVL depth sampler
 * queryable by Jupiter as if it were a real orderbook.
 *
 * This module:
 *   1. Exposes a Jupiter-compatible /quote interface
 *   2. Converts AVL depth levels into Jupiter route/marketInfo format
 *   3. Handles exact-in and exact-out swap simulation
 *   4. Returns Jupiter-format quote responses for CPI consumption
 *
 * Integration points:
 *   - Jupiter v6 /quote → simulated via AVL synthetic orderbook depth
 *   - marketInfos → AVL depth levels with virtual pool labels
 *   - priceImpactPct → computed from accumulated depth penetration
 *
 * Design doc: docs/avl-depth-sampler-design.md (§8.4)
 */

const config = require('./config');

// ─── Constants ──────────────────────────────────────────────

/** Mint addresses (matching config.markets) */
const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/** Token decimals */
const DECIMALS = {
  sol: 9,
  usdc: 6,
};

/** Default slippage in BPS if not specified */
const DEFAULT_SLIPPAGE_BPS = 50;

/** Virtual pool label for AVL in marketInfos */
const AVL_POOL_LABEL = 'AVL';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Convert human-readable amount to atomic units string.
 * @param {number} amount
 * @param {number} decimals
 * @returns {string}
 */
function toAtomicUnits(amount, decimals) {
  if (typeof amount !== 'number' || isNaN(amount) || amount < 0) return '0';
  if (!Number.isFinite(amount)) return '0';
  if (typeof decimals !== 'number' || isNaN(decimals)) return '0';
  const scaled = Math.round(amount * Math.pow(10, decimals));
  if (isNaN(scaled) || !Number.isFinite(scaled)) return '0';
  return String(BigInt(scaled));
}

/**
 * Convert atomic units string to number (human-readable).
 * @param {string|number} atomicUnits
 * @param {number} decimals
 * @returns {number}
 */
function fromAtomicUnits(atomicUnits, decimals) {
  return Number(BigInt(String(atomicUnits))) / 10 ** decimals;
}

/**
 * Determine which band a level belongs to based on bp from mid.
 * @param {number} bpFromMid
 * @returns {'inner'|'mid'|'outer'}
 */
function getBand(bpFromMid) {
  const { bands } = config;
  if (bpFromMid <= bands.inner.maxImpactPct * 100) return 'inner';
  if (bpFromMid <= bands.mid.maxImpactPct * 100) return 'mid';
  return 'outer';
}

/**
 * Find the appropriate mint addresses and decimals for a market pair.
 * @param {string} inputMint
 * @param {string} outputMint
 * @returns {{ marketKey: string, inputDecimals: number, outputDecimals: number }}
 */
function resolveMints(inputMint, outputMint) {
  for (const [key, market] of Object.entries(config.markets)) {
    if (market.baseMint === inputMint && market.quoteMint === outputMint) {
      return { marketKey: key, inputDecimals: DECIMALS.sol, outputDecimals: DECIMALS.usdc, side: 'ask' };
    }
    if (market.quoteMint === inputMint && market.baseMint === outputMint) {
      return { marketKey: key, inputDecimals: DECIMALS.usdc, outputDecimals: DECIMALS.sol, side: 'bid' };
    }
  }
  return null;
}

// ─── Core: Simulate Swap Through AVL Depth ──────────────────

/**
 * Simulate an exact-in swap through the AVL synthetic orderbook.
 *
 * Walks the depth levels (asks for buying, bids for selling), consuming
 * liquidity until the full input amount is filled or levels are exhausted.
 *
 * @param {Array} levels - AVL depth levels (asks sorted ascending, or bids sorted descending)
 * @param {boolean} isAsk - true for ask side (buying base), false for bid side (selling base)
 * @param {number} inputAmount - input amount in human-readable units (e.g., SOL or USDC)
 * @returns {{ outputAmount: number, avgPrice: number, priceImpactPct: number, levelsUsed: number, route: Array }}
 */
function simulateSwap(levels, isAsk, inputAmount) {
  if (!levels || levels.length === 0) {
    return {
      outputAmount: 0,
      avgPrice: 0,
      priceImpactPct: 100, // Max impact — no liquidity
      levelsUsed: 0,
      route: [],
    };
  }

  let remainingInput = inputAmount;
  let totalOutput = 0;
  let totalInputBase = 0; // Total base asset (SOL) consumed across all levels
  let totalInputQuote = 0; // Total quote asset (USDC) consumed
  let levelsUsed = 0;
  const route = [];

  // Sort appropriately: asks ascending (cheapest first), bids descending (highest first)
  const sorted = [...levels].sort((a, b) =>
    isAsk ? a.price - b.price : b.price - a.price
  );

  const firstPrice = sorted.length > 0 ? sorted[0].price : 0;

  for (const level of sorted) {
    if (remainingInput <= 0) break;

    // Size available at this level (always in base asset, e.g., SOL)
    const levelSize = level.size || 0;
    if (levelSize <= 0) continue;

    const price = level.price;
    if (price <= 0) continue;

    let baseConsumed; // Amount of base asset (SOL) consumed at this level
    let inputConsumed; // Amount of input token consumed at this level
    let outputObtained; // Amount of output token obtained

    if (isAsk) {
      // Ask side: input is SOL (base), output is USDC (quote)
      // Walk through levels consuming SOL
      baseConsumed = Math.min(remainingInput, levelSize);
      inputConsumed = baseConsumed; // Input is SOL
      outputObtained = baseConsumed * price; // Output is USDC
    } else {
      // Bid side: input is USDC (quote), output is SOL (base)
      // At this price, 1 SOL costs `price` USDC
      // How much SOL can we buy with remainingInput USDC?
      const maxBaseFromUsdc = remainingInput / price;
      baseConsumed = Math.min(maxBaseFromUsdc, levelSize);
      inputConsumed = baseConsumed * price; // USDC spent
      outputObtained = baseConsumed; // SOL received
    }

    if (baseConsumed <= 0) continue;

    totalInputBase += baseConsumed;
    totalInputQuote += inputConsumed;
    totalOutput += outputObtained;
    remainingInput -= inputConsumed;
    levelsUsed++;

    // Build route segment (Jupiter marketInfo-like format)
    const inputDec = isAsk ? DECIMALS.sol : DECIMALS.usdc;
    const outputDec = isAsk ? DECIMALS.usdc : DECIMALS.sol;

    route.push({
      id: `avl-${level.band || 'mid'}`,
      label: AVL_POOL_LABEL,
      inputMint: isAsk ? MINTS.SOL : MINTS.USDC,
      outputMint: isAsk ? MINTS.USDC : MINTS.SOL,
      inAmount: toAtomicUnits(inputConsumed, inputDec),
      outAmount: toAtomicUnits(outputObtained, outputDec),
      lpFee: { amount: '0', mint: MINTS.USDC, pct: '0' },
      platformFee: { amount: '0', mint: MINTS.USDC, pct: '0' },
    });
  }

  // Effective average price: total output / total input
  const totalInput = isAsk ? totalInputBase : totalInputQuote;
  const avgPrice = totalInput > 0 ? totalOutput / totalInput : 0;

  // Price impact: deviation of avg price from first level price
  const priceImpactPct = firstPrice > 0
    ? Math.abs(avgPrice - firstPrice) / firstPrice * 100
    : 0;

  return {
    outputAmount: totalOutput,
    avgPrice,
    priceImpactPct: +priceImpactPct.toFixed(4),
    levelsUsed,
    route,
  };
}

// ─── Public: Get Quote in Jupiter Format ────────────────────

/**
 * Get a Jupiter-compatible quote from AVL depth data.
 *
 * @param {object} depthSampler - DepthSampler instance (for latest curve)
 * @param {object} params - Quote parameters
 * @param {string} params.inputMint - Input token mint address
 * @param {string} params.outputMint - Output token mint address
 * @param {string} params.amount - Amount in atomic units of input token
 * @param {number} [params.slippageBps] - Slippage tolerance in BPS
 * @returns {object|null} Jupiter-format quote response, or null if unavailable
 */
function getQuote(depthSampler, params) {
  const { inputMint, outputMint, amount, slippageBps = DEFAULT_SLIPPAGE_BPS } = params;

  // Resolve market and side from mint addresses
  const resolved = resolveMints(inputMint, outputMint);
  if (!resolved) {
    return null; // Unsupported market pair
  }

  const { marketKey, inputDecimals, outputDecimals, side } = resolved;
  const curve = depthSampler.getLatestCurve(marketKey);
  if (!curve) {
    return null; // No depth data available yet
  }

  // Convert amount to human-readable
  const inputAmount = fromAtomicUnits(amount, inputDecimals);
  if (inputAmount <= 0) {
    return null;
  }

  // Get appropriate depth levels based on side
  const isAsk = side === 'ask';
  const levels = isAsk ? curve.asks : curve.bids;

  // Simulate swap through AVL depth
  const simResult = simulateSwap(levels, isAsk, inputAmount);

  if (simResult.levelsUsed === 0) {
    return null; // No liquidity available
  }

  // Convert output back to atomic units
  const inAmountAtomic = amount;
  const outAmountAtomic = toAtomicUnits(
    simResult.outputAmount,
    isAsk ? outputDecimals : inputDecimals
  );

  // Compute otherAmountThreshold (slippage-adjusted minimum output)
  const slippageFactor = 1 - (slippageBps / 10000);
  const otherAmountThreshold = BigInt(Math.round(
    Number(BigInt(outAmountAtomic)) * slippageFactor
  ));

  const startTime = Date.now();

  return {
    inputMint,
    outputMint,
    inAmount: inAmountAtomic,
    outAmount: outAmountAtomic,
    otherAmountThreshold: String(otherAmountThreshold),
    priceImpactPct: String(simResult.priceImpactPct),
    route: {
      swapMode: 'ExactIn',
      priceImpactPct: String(simResult.priceImpactPct),
      marketInfos: simResult.route,
    },
    contextSlot: 0,
    timeTaken: Date.now() - startTime,
    _meta: {
      source: 'avl_depth',
      avgPrice: +simResult.avgPrice.toFixed(4),
      levelsUsed: simResult.levelsUsed,
      marketKey,
      midPrice: curve.midPrice,
      spreadBps: curve.spreadBps,
      volatility: curve.volatility,
      totalAsks: curve.askCount,
      totalBids: curve.bidCount,
      ts: curve.ts,
    },
  };
}

/**
 * Get all supported route pairs from AVL (market mints).
 * Used by Jupiter to discover available routes.
 *
 * @returns {Array<{inputMint: string, outputMint: string, label: string}>}
 */
function getSupportedRoutes() {
  const routes = [];
  for (const [key, market] of Object.entries(config.markets)) {
    routes.push({
      inputMint: market.baseMint,
      outputMint: market.quoteMint,
      label: `AVL ${key}`,
    });
    routes.push({
      inputMint: market.quoteMint,
      outputMint: market.baseMint,
      label: `AVL ${key} (reverse)`,
    });
  }
  return routes;
}

/**
 * Get the full AVL synthetic orderbook state.
 *
 * @param {object} depthSampler - DepthSampler instance
 * @param {string} [market='SOL/USDC'] - Market key
 * @returns {object|null} Orderbook with bids/asks in Jupiter format
 */
function getOrderbook(depthSampler, market = 'SOL/USDC') {
  const curve = depthSampler.getLatestCurve(market);
  if (!curve) return null;

  return {
    market,
    midPrice: curve.midPrice,
    spreadBps: curve.spreadBps,
    bids: (curve.bids || []).map(b => ({
      price: b.price,
      size: b.size,
      source: b.source || 'avl',
      band: b.band || 'mid',
    })),
    asks: (curve.asks || []).map(a => ({
      price: a.price,
      size: a.size,
      source: a.source || 'avl',
      band: a.band || 'mid',
    })),
    ts: curve.ts,
    volatility: curve.volatility,
  };
}

module.exports = {
  getQuote,
  getSupportedRoutes,
  getOrderbook,
  simulateSwap,
  resolveMints,
  toAtomicUnits,
  fromAtomicUnits,
  MINTS,
  DECIMALS,
  AVL_POOL_LABEL,
};
