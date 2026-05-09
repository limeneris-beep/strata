/**
 * AVL Depth Sampler — Main Entry Point
 *
 * The DepthSampler class orchestrates the full pipeline:
 *   1. Schedule per-band sampling (inner/mid/outer)
 *   2. Fetch quotes from Jupiter (fallback chain)
 *   3. Interpolate + extrapolate into continuous curve
 *   4. Apply volatility adjustments
 *   5. Serve via REST API and WebSocket push
 *
 * Design doc: docs/avl-depth-sampler-design.md (§3)
 */

const config = require('./config');
const { Scheduler } = require('./scheduler');

const jupiter = require('./samplers/jupiter');
const pyth = require('./samplers/pyth');
const raydium = require('./samplers/raydium');

const { buildCurve, buildModeledOnlyCurve, volatilityTracker } = require('./curve');

const { VolatilityTracker } = require('./model/volatility');
const { AVLServer } = require('./server');

class DepthSampler {
  /**
   * @param {object} [options]
   * @param {number} [options.port] - HTTP server port
   * @param {boolean} [options.autoStart] - start sampling loop automatically
   */
  constructor(options = {}) {
    this.options = options;
    this.scheduler = new Scheduler();
    this.server = new AVLServer(this);

    // Latest curve by market
    this.latestCurves = {};

    // Accumulated sampled data by band (for merging)
    this.sampledData = {
      asks: { inner: [], mid: [], outer: [] },
      bids: { inner: [], mid: [], outer: [] },
    };

    // Sample counters
    this.stats = {
      totalSamples: 0,
      failedSamples: 0,
      startTime: Date.now(),
      lastSampleTime: 0,
    };

    // Running flag
    this._running = false;
    this._loopTimer = null;
  }

  /**
   * Start the sampling loop and HTTP server.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._running) return;

    this._running = true;
    console.log('[AVL] Starting Depth Sampler');

    // Start the HTTP server IMMEDIATELY (don't block on bootstrap)
    await this.server.start(this.options.port || config.server.port);

    // Bootstrap in background — samples Jupiter, builds initial curve
    this._fullBootstrap()
      .then(() => console.log('[AVL] Bootstrap complete'))
      .catch((e) => console.warn(`[AVL] Bootstrap failed: ${e.message}, using modeled fallback`));

    // Start the adaptive sampling loop
    this._startLoop();

    console.log('[AVL] Depth Sampler running');
  }

  /**
   * Stop the sampling loop and server.
   */
  stop() {
    this._running = false;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }
    this.server.stop();
    console.log('[AVL] Depth Sampler stopped');
  }

  /**
   * Get the latest curve snapshot for a market.
   *
   * @param {string} [market='SOL/USDC']
   * @returns {object|null}
   */
  getLatestCurve(market = 'SOL/USDC') {
    return this.latestCurves[market] || null;
  }

  /**
   * Get execution quote for the matching engine.
   * Tries Jupiter live, falls back to stale curve.
   *
   * @param {string} market
   * @param {'ask'|'bid'} side
   * @param {number} size
   * @returns {Promise<object>}
   */
  async getExecutionQuote(market, side, size) {
    return jupiter.getExecutionQuote(market, side, size);
  }

  /**
   * Fallback quote from stale curve data.
   *
   * @param {string} market
   * @param {'ask'|'bid'} side
   * @param {number} size
   * @returns {object}
   */
  getStaleQuoteFallback(market, side, size) {
    const curve = this.latestCurves[market];
    if (!curve) {
      return {
        price: 150,
        size,
        source: 'fallback_model',
        priceImpactPct: 0.5,
        ts: Date.now(),
        slippageBps: config.jupiter.slippageBps + 50, // Wider slippage for stale data
      };
    }

    // Find the closest level in the stale curve
    const levels = side === 'ask' ? curve.asks : curve.bids;
    let closest = levels[0];
    for (const level of levels) {
      if (side === 'ask' && level.price <= closest.price) closest = level;
      if (side === 'bid' && level.price >= closest.price) closest = level;
    }

    return {
      price: closest ? closest.price : (side === 'ask' ? curve.midPrice * 1.01 : curve.midPrice * 0.99),
      size,
      source: 'stale_curve',
      ts: Date.now(),
      slippageBps: config.jupiter.slippageBps + 50,
    };
  }

  /**
   * Get sampler status for monitoring.
   *
   * @returns {object}
   */
  getStatus() {
    const curve = this.getLatestCurve();
    return {
      running: this._running,
      uptime: Date.now() - this.stats.startTime,
      totalSamples: this.stats.totalSamples,
      failedSamples: this.stats.failedSamples,
      lastSampleTime: this.stats.lastSampleTime,
      lastSampleAge: this.stats.lastSampleTime ? Date.now() - this.stats.lastSampleTime : null,
      currentVol: volatilityTracker.getVolatility(),
      volatilityFactor: volatilityTracker.getVolatilityFactor(),
      latestCurve: curve ? {
        ts: curve.ts,
        askCount: curve.askCount,
        bidCount: curve.bidCount,
        midPrice: curve.midPrice,
        spreadBps: curve.spreadBps,
        volatility: curve.volatility,
        source: curve.source,
      } : null,
      scheduler: this.scheduler.getStatus(),
    };
  }

  // ── Private: Full bootstrap sample (all bands) ──

  async _fullBootstrap() {
    console.log('[AVL] Full bootstrap sample…');

    // Use the fallback chain (Jupiter → Pyth → stored → Gaussian)
    const data = await this._fetchWithFallback('SOL/USDC');

    this.stats.totalSamples++;

    // Store sampled data
    this._storeSampledData(data);

    // Build curve from all data
    const curve = this._rebuildCurve();
    if (curve) {
      this.latestCurves['SOL/USDC'] = curve;
      this.server.broadcastCurve(curve);
    }

    // Mark scheduler as having run
    const now = Date.now();
    for (const band of ['inner', 'mid', 'outer']) {
      this.scheduler.bands[band].lastRun = now;
    }
  }

  // ── Private: Sampling loop ──

  _startLoop() {
    if (!this._running) return;

    const loop = async () => {
      if (!this._running) return;

      try {
        await this._tick();
      } catch (e) {
        console.error(`[AVL] Loop error: ${e.message}`);
      }

      // Schedule next tick: check every 1 second
      this._loopTimer = setTimeout(loop, 1000);
    };

    this._loopTimer = setTimeout(loop, 1000);
  }

  async _tick() {
    const now = Date.now();
    let needsRebuild = false;

    // Check each band
    for (const band of ['inner', 'mid', 'outer']) {
      if (!this.scheduler.isDue(band, now)) continue;

      try {
        await this._sampleBand(band);
        this.scheduler.onSuccess(band);
        needsRebuild = true;
      } catch (e) {
        this.scheduler.onError(band, e);
        this.stats.failedSamples++;
      }
    }

    // Rebuild curve if any band was sampled
    if (needsRebuild) {
      this.stats.totalSamples++;
      this.stats.lastSampleTime = Date.now();

      const curve = this._rebuildCurve();
      if (curve) {
        this.latestCurves['SOL/USDC'] = curve;
        this.server.broadcastCurve(curve);

        // Volatility-triggered scheduler adjustment
        const volFactor = volatilityTracker.getVolatilityFactor();
        if (volFactor > 1.5) {
          this.scheduler.onVolatilitySpike(volFactor);
        } else {
          this.scheduler.onVolatilityRecover(volFactor);
        }
      }
    }
  }

  async _sampleBand(band) {
    let data;

    switch (band) {
      case 'inner':
        data = await this._fetchWithFallback('SOL/USDC', 'inner');
        break;
      case 'mid':
        data = await this._fetchWithFallback('SOL/USDC', 'mid');
        break;
      case 'outer':
        data = await this._fetchWithFallback('SOL/USDC', 'outer');
        break;
      default:
        throw new Error(`Unknown band: ${band}`);
    }

    this._storeBandData(band, data);
  }

  // ── Private: Fallback chain ──

  /**
   * Fetch data with fallback chain: Jupiter → Binance → Pyth → Modeled.
   *
   * @param {string} market
   * @param {'inner'|'mid'|'outer'|null} band - null for full fetch
   * @returns {Promise<{asks: Array, bids: Array}>}
   */
  async _fetchWithFallback(market, band = null) {
    // Level 1: Jupiter (primary — real on-chain liquidity)
    try {
      if (band === 'inner') return await jupiter.fetchInnerBand();
      if (band === 'mid') return await jupiter.fetchMidBand();
      if (band === 'outer') return await jupiter.fetchOuterBand();
      return await jupiter.fetchFullCurve();
    } catch (e) {
      console.warn(`[AVL] Jupiter failed (${band || 'full'}): ${e.message}`);
    }

    // Level 2: Pyth oracle — real price, modeled depth curve
    try {
      console.log('[AVL] Falling back to Pyth oracle…');
      const pythPrice = await pyth.getSOLPrice();
      const modeled = pyth.generateModeledCurve(pythPrice.price);
      return { asks: modeled.asks, bids: modeled.bids };
    } catch (e) {
      console.warn(`[AVL] Pyth failed: ${e.message}`);
    }

    // Level 3: Stored curve (aged — from previous successful sample)
    const storedCurve = this.latestCurves[market];
    if (storedCurve) {
      console.log('[AVL] Using aged stored curve');
      return {
        asks: storedCurve.asks.map(a => ({ ...a, aged: true })),
        bids: storedCurve.bids.map(b => ({ ...b, aged: true })),
      };
    }

    // Level 4: Gaussian mock using Pyth or reasonable default
    // Try Pyth one more time for the mid-price
    let midPrice = 89.55;
    try {
      const pythPrice = await pyth.getSOLPrice();
      midPrice = pythPrice.price;
    } catch (e) { /* use default */ }
    console.log(`[AVL] Using Gaussian mock fallback (mid=$${midPrice.toFixed(2)})`);
    const mockCurve = buildModeledOnlyCurve(midPrice);
    return {
      asks: mockCurve.asks,
      bids: mockCurve.bids,
    };
  }

  // ── Private: Data management ──

  _storeSampledData(data) {
    for (const side of ['asks', 'bids']) {
      for (const point of (data[side] || [])) {
        const band = point.band || 'mid';
        if (!this.sampledData[side][band]) {
          this.sampledData[side][band] = [];
        }
        // Replace existing or append
        const existing = this.sampledData[side][band].find(
          p => Math.abs(p.price - point.price) < 0.0001
        );
        if (existing) {
          Object.assign(existing, point);
        } else {
          this.sampledData[side][band].push(point);
        }
      }
    }
  }

  _storeBandData(band, data) {
    for (const side of ['asks', 'bids']) {
      for (const point of (data[side] || [])) {
        if (!this.sampledData[side][band]) {
          this.sampledData[side][band] = [];
        }
        const existing = this.sampledData[side][band].find(
          p => Math.abs(p.price - point.price) < 0.0001
        );
        if (existing) {
          Object.assign(existing, point);
        } else {
          this.sampledData[side][band].push(point);
        }
      }
    }
  }

  _rebuildCurve() {
    // Collect all sampled data from all bands
    const allAsks = [
      ...(this.sampledData.asks.inner || []),
      ...(this.sampledData.asks.mid || []),
      ...(this.sampledData.asks.outer || []),
    ].filter(Boolean);

    const allBids = [
      ...(this.sampledData.bids.inner || []),
      ...(this.sampledData.bids.mid || []),
      ...(this.sampledData.bids.outer || []),
    ].filter(Boolean);

    if (allAsks.length === 0 && allBids.length === 0) {
      return null;
    }

    // Build curve
    return buildCurve(allAsks, allBids);
  }
}

module.exports = { DepthSampler };
