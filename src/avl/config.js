/**
 * AVL Depth Sampler — Configuration
 *
 * All tunable parameters for the depth sampling pipeline.
 * Exposed via REST endpoint for live tuning.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§6)
 */

const config = {
  // ── Market Configuration ──
  markets: {
    'SOL/USDC': {
      baseMint: 'So11111111111111111111111111111111111111112',
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tickSize: 0.01,
      minSize: 0.01,
      maxVirtualLevels: 100,
    },
    // Additional markets can be added here
  },

  // ── Band Configuration ──
  bands: {
    inner: {
      maxImpactPct: 2.0,       // ≤2% price impact
      bpSpacing: 10,            // 10bp ≈ $0.09 steps
      sampleInterval: 5000,
      ttl: 10000,
    },
    mid: {
      maxImpactPct: 5.0,
      bpSpacing: 10,            // uniform 10bp for continuous coverage
      sampleInterval: 15000,
      ttl: 20000,
    },
    outer: {
      maxImpactPct: 10.0,
      bpSpacing: 10,            // uniform 10bp
      sampleInterval: 45000,
      ttl: 60000,
    },
  },

  // ── Size Ladders ──
  // Log-spaced sizes for depth curve building
  askLadder: [
    0.5, 1.0, 2.0, 5.0, 10, 25, 50, 100,
  ],

  // Bid sizes (USDC): equivalent SOL value at ~$90 SOL
  bidLadder: [
    50, 100, 200, 500, 1000, 2500, 5000, 10000,
  ],

  // ── Spread Configuration ──
  spread: {
    baseBps: 3,               // Base spread: 0.03% (tight for SOL/USDC)
    minBps: 1,                // Never below 0.01%
    maxBps: 50,               // Never above 0.5%
    volatilityMultiplier: 2.5, // spread = base + σ * multiplier
  },

  // ── Depth Curve ──
  depth: {
    maxSizePerLevel: Infinity,  // No cap — exponential decay provides natural taper
    maxCumulativeSize: 800,    // Total virtual depth cap (SOL per side)

    // GMM calibration defaults (used when no live data available)
    gmmDefaults: {
      weight1: 0.7,
      sigma1_bps: 10,
      sigma2_bps: 50,
    },

    // Curve smoothing
    smoothingWindow: 3,       // Rolling average window for level sizes
  },

  // ── Volatility ──
  volatility: {
    windowMinutes: 5,         // Calculate vol over 5-min window
    sampleSource: 'jupiter',  // Use Jupiter quote changes as proxy
    fallbackSource: 'binance',// Fallback to Binance ticker
    extremeThreshold: 3.0,    // 3x normal vol = "extreme" → max spread
    normalVol: 0.5,           // 50% annualized vol = "normal"
  },

  // ── Rate Limiting ──
  rateLimit: {
    maxRps: 0.4,              // Jupiter free tier: 1 req per 2.5s
    burstSize: 1,             // No bursting
    retryDelay: 2000,         // Base retry delay
    maxRetries: 3,
  },

  // ── Fallback ──
  fallback: {
    binanceBase: 'https://api.binance.us/api/v3',
    pythPriceFeed: 'https://hermes.pyth.network/v2/updates/price/latest',
    maxStaleAge: 60000,       // Accept 60s old data in fallback mode
  },

  // ── Jupiter API ──
  jupiter: {
    baseUrl: 'https://api.jup.ag/swap/v1',
    slippageBps: 50,
  },

  // ── Server ──
  server: {
    port: 4001,
    wsHeartbeatInterval: 15000,
    corsOrigin: '*',
  },
};

module.exports = config;
