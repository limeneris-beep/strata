/**
 * Adaptive Sampling Scheduler
 *
 * Manages per-band sampling cadence with exponential backoff on errors
 * and volatility-triggered interval tightening.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§4.3–4.4)
 */

const config = require('./config');

class Scheduler {
  constructor() {
    this.bands = {
      inner: {
        interval: config.bands.inner.sampleInterval,
        lastRun: 0,
        errors: 0,
        successes: 0,
        consecutiveErrors: 0,
      },
      mid: {
        interval: config.bands.mid.sampleInterval,
        lastRun: 0,
        errors: 0,
        successes: 0,
        consecutiveErrors: 0,
      },
      outer: {
        interval: config.bands.outer.sampleInterval,
        lastRun: 0,
        errors: 0,
        successes: 0,
        consecutiveErrors: 0,
      },
    };

    this.maxInterval = 300000; // 5 min max backoff
    this.minInterval = 2000;   // 2s minimum
    this.defaultIntervals = {
      inner: config.bands.inner.sampleInterval,
      mid: config.bands.mid.sampleInterval,
      outer: config.bands.outer.sampleInterval,
    };
  }

  /**
   * Called when a sample succeeds.
   * Resets error count and optionally tightens interval.
   *
   * @param {'inner'|'mid'|'outer'} band
   */
  onSuccess(band) {
    const b = this.bands[band];
    b.errors = 0;
    b.consecutiveErrors = 0;
    b.successes++;
    b.lastRun = Date.now();

    // Gradually restore default interval after recovery
    if (b.interval > this.defaultIntervals[band]) {
      // Reduce interval by 50% each success (faster recovery)
      b.interval = Math.max(
        this.defaultIntervals[band],
        Math.floor(b.interval * 0.5)
      );
    }
  }

  /**
   * Called when a sample fails.
   * Implements exponential backoff.
   *
   * @param {'inner'|'mid'|'outer'} band
   * @param {Error} [error]
   * @returns {number} backoff interval in ms
   */
  onError(band, error = null) {
    const b = this.bands[band];
    b.errors++;
    b.consecutiveErrors++;

    const backoff = Math.min(
      this.defaultIntervals[band] * Math.pow(2, b.consecutiveErrors),
      this.maxInterval
    );

    b.interval = backoff;
    console.warn(
      `[Scheduler] ${band} error #${b.consecutiveErrors}: backing off to ${backoff}ms` +
      (error ? ` (${error.message})` : '')
    );

    return backoff;
  }

  /**
   * When was the last successful run for a band?
   *
   * @param {'inner'|'mid'|'outer'} band
   * @returns {number} timestamp
   */
  lastRun(band) {
    return this.bands[band].lastRun;
  }

  /**
   * When is the next scheduled run for a band?
   *
   * @param {'inner'|'mid'|'outer'} band
   * @returns {number} timestamp
   */
  nextRun(band) {
    return this.bands[band].lastRun + this.bands[band].interval;
  }

  /**
   * Is a band due for sampling now?
   *
   * @param {'inner'|'mid'|'outer'} band
   * @param {number} [now] - current timestamp (default: Date.now())
   * @returns {boolean}
   */
  isDue(band, now = Date.now()) {
    return now >= this.nextRun(band);
  }

  /**
   * Get the current interval for a band.
   *
   * @param {'inner'|'mid'|'outer'} band
   * @returns {number} interval in ms
   */
  getInterval(band) {
    return this.bands[band].interval;
  }

  /**
   * Get all bands' status.
   *
   * @returns {object}
   */
  getStatus() {
    const now = Date.now();
    const status = {};
    for (const [band, b] of Object.entries(this.bands)) {
      status[band] = {
        interval: b.interval,
        lastRun: b.lastRun,
        nextRun: b.lastRun + b.interval,
        dueIn: Math.max(0, b.lastRun + b.interval - now),
        errors: b.errors,
        successes: b.successes,
        consecutiveErrors: b.consecutiveErrors,
        healthy: b.consecutiveErrors < 3,
      };
    }
    return status;
  }

  /**
   * Volatility-triggered: tighten intervals when market is moving fast.
   *
   * @param {number} factor - volatility factor (2.0 = 2x normal vol)
   */
  onVolatilitySpike(factor) {
    if (factor > 1.5) {
      for (const [band, b] of Object.entries(this.bands)) {
        // Halve all intervals proportionally to the spike
        const reduced = Math.max(
          this.minInterval,
          Math.floor(b.interval / factor)
        );
        b.interval = reduced;
      }
      console.log(`[Scheduler] Volatility spike (${factor.toFixed(1)}x): tightened intervals`);
    }
  }

  /**
   * Volatility-triggered: restore default intervals when market calms down.
   *
   * @param {number} factor - current volatility factor
   */
  onVolatilityRecover(factor) {
    if (factor <= 1.5) {
      for (const [band, b] of Object.entries(this.bands)) {
        if (b.interval < this.defaultIntervals[band]) {
          // Gradually restore
          b.interval = Math.min(
            this.defaultIntervals[band],
            Math.floor(b.interval * 1.5)
          );
        }
      }
    }
  }

  /**
   * Reset the scheduler to default intervals.
   */
  reset() {
    for (const [band, b] of Object.entries(this.bands)) {
      b.interval = this.defaultIntervals[band];
      b.errors = 0;
      b.successes = 0;
      b.consecutiveErrors = 0;
      b.lastRun = 0;
    }
  }
}

module.exports = { Scheduler };
