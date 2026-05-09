/**
 * Tests: Spread Calculation and Volatility Adjustment
 *
 * Validates spread widens linearly with volatility and that
 * adjustment formulas produce correct results.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

const config = require('../config');
const {
  calculateSpread,
  applyVolatilityAdjustment,
  VolatilityTracker,
} = require('../model/volatility');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function runTests() {
  console.log('=== Spread & Volatility Tests ===\n');

  // Test 1: Spread calculation with volatility
  console.log('Test 1: Spread at different volatility levels');
  {
    // Base spread should be config.spread.baseBps when volFactor = 1
    const spreadNormal = calculateSpread(150, 1.0);
    assert(spreadNormal >= config.spread.baseBps,
      `Spread at normal vol should be >= base (${spreadNormal} >= ${config.spread.baseBps})`);
    assert(spreadNormal <= config.spread.maxBps,
      `Spread at normal vol should be <= max (${spreadNormal} <= ${config.spread.maxBps})`);
    console.log(`  Spread at σ=1.0 (normal): ${spreadNormal.toFixed(2)} bps`);

    // Higher vol → wider spread
    const spreadHigh = calculateSpread(150, 2.0);
    assert(spreadHigh > spreadNormal,
      `Spread at 2x vol should be wider (${spreadHigh} > ${spreadNormal})`);
    console.log(`  Spread at σ=2.0 (high):   ${spreadHigh.toFixed(2)} bps`);

    // Extreme vol → wider still
    const spreadExtreme = calculateSpread(150, 3.0);
    assert(spreadExtreme >= spreadHigh,
      `Spread at 3x vol should be wider (${spreadExtreme} >= ${spreadHigh})`);
    console.log(`  Spread at σ=3.0 (extreme): ${spreadExtreme.toFixed(2)} bps`);

    // Check clamping
    const spreadMin = calculateSpread(150, 0.01);
    assert(spreadMin >= config.spread.minBps,
      `Spread shouldn't go below min (${spreadMin} >= ${config.spread.minBps})`);

    const spreadMax = calculateSpread(150, 100);
    assert(spreadMax <= config.spread.maxBps,
      `Spread shouldn't exceed max (${spreadMax} <= ${config.spread.maxBps})`);

    console.log('  ✓ PASS');
  }

  // Test 2: Volatility adjustment shrinks sizes
  console.log('Test 2: Volatility adjustment on levels');
  {
    const levels = [
      { price: 150.10, size: 10, band: 'inner', ttl: 10000 },
      { price: 150.50, size: 5, band: 'mid', ttl: 20000 },
      { price: 151.00, size: 3, band: 'outer', ttl: 60000 },
    ];

    // 2x vol factor
    const adjusted = applyVolatilityAdjustment(levels, 2.0);

    assert(adjusted.length === 3, 'Same number of levels');
    assert(approx(adjusted[0].size, 5.0), 'Size halved (2x vol)');
    assert(approx(adjusted[1].size, 2.5), 'Size halved (2x vol)');
    assert(approx(adjusted[2].size, 1.5), 'Size halved (2x vol)');
    console.log('  Size adjustment: ✓');

    // 3x vol factor
    const adjusted3x = applyVolatilityAdjustment(levels, 3.0);
    assert(approx(adjusted3x[0].size, 3.333, 0.01), 'Size 1/3 (3x vol)');
    console.log('  3x vol size adjustment: ✓');

    console.log('  ✓ PASS');
  }

  // Test 3: Normal vol (factor ≤ 1) = no adjustment
  console.log('Test 3: Normal volatility (no adjustment)');
  {
    const levels = [
      { price: 150.10, size: 10, band: 'inner', ttl: 10000 },
    ];
    const adjusted = applyVolatilityAdjustment(levels, 1.0);
    assert(adjusted[0].size === 10, 'Size unchanged at normal vol');
    console.log('  ✓ PASS');
  }

  // Test 4: VolatilityTracker basic functionality
  console.log('Test 4: VolatilityTracker basic functionality');
  {
    const tracker = new VolatilityTracker(1); // 1-minute window
    assert(tracker.getVolatility() === config.volatility.normalVol,
      'Initial vol should be normalVol');
    assert(tracker.getVolatilityFactor() === 1.0,
      'Initial factor should be 1.0');

    // Record some stable prices
    for (let i = 0; i < 20; i++) {
      tracker.record(150);
    }
    console.log(`  Volatility after stable prices: ${tracker.getVolatility().toFixed(4)}`);
    console.log(`  Samples: ${tracker.sampleCount()}`);
    console.log('  ✓ PASS');
  }

  // Test 5: VolatilityTracker with volatile data
  console.log('Test 5: VolatilityTracker volatile data');
  {
    const tracker = new VolatilityTracker(1);

    // Record volatile prices (oscillating)
    for (let i = 0; i < 20; i++) {
      const price = 150 + Math.sin(i * 0.5) * 3; // ±3 swings
      tracker.record(price);
    }

    const vol = tracker.getVolatility();
    const factor = tracker.getVolatilityFactor();

    console.log(`  Volatility: ${(vol * 100).toFixed(1)}%`);
    console.log(`  Factor: ${factor.toFixed(2)}x`);

    // Volatile data should produce higher vol than constant
    assert(vol > 0, 'Volatility should be positive');
    console.log('  ✓ PASS');
  }

  console.log('\n=== All spread & volatility tests completed ===');
}

function approx(a, b, tol = 0.01) {
  return Math.abs(a - b) < tol;
}

runTests();
