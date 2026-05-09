/**
 * Tests: Curve Building and Merge Logic
 *
 * Validates the full curve building pipeline including level merging,
 * smoothing, and the final CurveSnapshot output format.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

const { buildCurve, mergeLevels, smoothLevels, estimateMidPrice } = require('../curve');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function runTests() {
  console.log('=== Curve Building Tests ===\n');

  // Test 1: Full curve from sampled data
  console.log('Test 1: Full curve from sampled data');
  {
    const askSamples = [
      { size: 1, price: 150.10, band: 'inner', impact: 0.1 },
      { size: 5, price: 150.50, band: 'inner', impact: 0.5 },
      { size: 20, price: 151.50, band: 'mid', impact: 1.5 },
      { size: 100, price: 153.00, band: 'mid', impact: 3.0 },
      { size: 500, price: 157.50, band: 'outer', impact: 6.0 },
    ];

    const bidSamples = [
      { size: 1, price: 149.90, band: 'inner', impact: 0.1 },
      { size: 5, price: 149.50, band: 'inner', impact: 0.5 },
      { size: 20, price: 148.50, band: 'mid', impact: 1.5 },
      { size: 100, price: 147.00, band: 'mid', impact: 3.0 },
      { size: 500, price: 142.50, band: 'outer', impact: 6.0 },
    ];

    const curve = buildCurve(askSamples, bidSamples);

    assert(curve !== null, 'Curve should be built');
    assert(curve.asks.length > 0, 'Should have asks');
    assert(curve.bids.length > 0, 'Should have bids');
    assert(curve.midPrice > 0, 'Mid price should be positive');
    assert(curve.spreadBps > 0, 'Spread should be positive');

    // Check structure
    assert(typeof curve.ts === 'number', 'Has timestamp');
    assert(typeof curve.askCount === 'number', 'Has askCount');
    assert(typeof curve.bidCount === 'number', 'Has bidCount');
    assert(typeof curve.volatility === 'number', 'Has volatility');
    assert(typeof curve.volatilityFactor === 'number', 'Has vol factor');

    // Check each level
    for (const ask of curve.asks) {
      assert(typeof ask.price === 'number', `Ask price is number (got ${typeof ask.price})`);
      assert(typeof ask.size === 'number', `Ask size is number (got ${typeof ask.size})`);
      assert(ask.price > curve.midPrice, `Ask ${ask.price} > mid ${curve.midPrice}`);
      assert(['inner', 'mid', 'outer'].includes(ask.band), `Ask has valid band: ${ask.band}`);
      assert(typeof ask.expiresAt === 'number', 'Ask has expiresAt');
      assert(typeof ask.ttl === 'number', 'Ask has ttl');
      assert(ask.type === 'virtual', 'Type is virtual');
    }

    for (const bid of curve.bids) {
      assert(typeof bid.price === 'number', 'Bid price is number');
      assert(typeof bid.size === 'number', 'Bid size is number');
      assert(bid.price < curve.midPrice, `Bid ${bid.price} < mid ${curve.midPrice}`);
      assert(['inner', 'mid', 'outer'].includes(bid.band), 'Bid has valid band');
      assert(typeof bid.expiresAt === 'number', 'Bid has expiresAt');
    }

    console.log(`  Asks: ${curve.askCount}, Bids: ${curve.bidCount}`);
    console.log(`  Mid: $${curve.midPrice}, Spread: ${curve.spreadBps} bps`);
    console.log('  ✓ PASS');
  }

  // Test 2: Merging interpolated + extrapolated levels
  console.log('Test 2: mergeLevels');
  {
    const interpolated = [
      { price: 150.10, size: 1, cumulativeSize: 1, interpolated: true },
      { price: 150.50, size: 5, cumulativeSize: 6, interpolated: true },
    ];
    const extrapolated = [
      { price: 155.00, size: 20, cumulativeSize: 26, modeled: true },
      { price: 160.00, size: 50, cumulativeSize: 76, modeled: true },
      { price: 170.00, size: 100, cumulativeSize: 176, modeled: true },
    ];

    const merged = mergeLevels(interpolated, extrapolated, 5);
    assert(merged.length === 5, 'Should have 5 merged levels');
    assert(merged[0].interpolated === true, 'Interpolated first');
    assert(merged[2].modeled === true, 'Modeled after interpolated');
    console.log('  ✓ PASS');
  }

  // Test 3: Merging with empty interpolated
  console.log('Test 3: mergeLevels with empty interpolated');
  {
    const extrapolated = [
      { price: 155.00, size: 20, modeled: true },
      { price: 160.00, size: 50, modeled: true },
    ];

    const merged = mergeLevels([], extrapolated, 5);
    assert(merged.length === 2, 'Should use all extrapolated');
    assert(merged.every(l => l.modeled === true), 'All modeled');
    console.log('  ✓ PASS');
  }

  // Test 4: Level smoothing
  console.log('Test 4: smoothLevels');
  {
    const levels = [
      { price: 150.10, size: 1.0 },
      { price: 150.20, size: 5.0 },
      { price: 150.30, size: 10.0 },
      { price: 150.40, size: 15.0 },
      { price: 150.50, size: 20.0 },
    ];

    const smoothed = smoothLevels(levels, 3);
    assert(smoothed.length === 5, 'Same number of levels');

    // First and last should be unchanged (edge preservation)
    assert(smoothed[0].size === levels[0].size, 'First level unchanged');
    assert(smoothed[4].size === levels[4].size, 'Last level unchanged');

    // Middle index 2: windowSize=3, j=1 and j=2
    // j=1: i-1(idx1,5), i+1(idx3,15)
    // j=2: i-2(idx0,1), i+2(idx4,20) [all within bounds since 0..4]
    // sum = 10 + 5 + 15 + 1 + 20 = 51, count=5
    const expectedMid = (1 + 5 + 10 + 15 + 20) / 5;
    assert(Math.abs(smoothed[2].size - expectedMid) < 0.01,
      `Center level smoothed (expected ${expectedMid}, got ${smoothed[2].size})`);
    console.log('  ✓ PASS');
  }

  // Test 5: Estimate mid-price correctly
  console.log('Test 5: estimateMidPrice');
  {
    const asks = [{ price: 150.10 }, { price: 150.50 }];
    const bids = [{ price: 149.90 }, { price: 149.50 }];

    const mid = estimateMidPrice(asks, bids);
    assert(Math.abs(mid - 150.0) < 0.01, `Mid should be ~150.00 (got ${mid})`);
    console.log('  ✓ PASS');
  }

  // Test 6: Estimate mid-price with only asks
  console.log('Test 6: estimateMidPrice (asks only)');
  {
    const mid = estimateMidPrice([{ price: 150.10 }], []);
    assert(Math.abs(mid - 150.10) < 0.01, 'Mid from lowest ask');
    console.log('  ✓ PASS');
  }

  // Test 7: Ensure sorted output
  console.log('Test 7: Sorted output');
  {
    const askSamples = [
      { size: 10, price: 152.00, band: 'mid', impact: 3.0 },
      { size: 1, price: 150.10, band: 'inner', impact: 0.1 },
    ];
    const bidSamples = [
      { size: 10, price: 148.00, band: 'mid', impact: 3.0 },
      { size: 1, price: 149.90, band: 'inner', impact: 0.1 },
    ];

    const curve = buildCurve(askSamples, bidSamples);

    // Asks should be ascending
    for (let i = 1; i < curve.asks.length; i++) {
      assert(curve.asks[i].price > curve.asks[i - 1].price, 'Asks ascending');
    }
    // Bids should be descending
    for (let i = 1; i < curve.bids.length; i++) {
      assert(curve.bids[i].price < curve.bids[i - 1].price, 'Bids descending');
    }
    console.log('  ✓ PASS');
  }

  console.log('\n=== All curve building tests completed ===');
}

runTests();
