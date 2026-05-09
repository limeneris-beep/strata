/**
 * Tests: PCHIP Interpolation
 *
 * Validates that interpolation produces monotonically increasing
 * prices with no NaN values and sensible depth distribution.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

const { interpolateLevels, computePchipSlopes, evalCubicHermite } = require('../model/interpolator');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function assertApprox(a, b, tolerance, message) {
  if (Math.abs(a - b) > tolerance) {
    console.error(`  ✗ FAIL: ${message} — expected ${b} ± ${tolerance}, got ${a}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function runTests() {
  console.log('=== Interpolation Tests ===\n');

  // Test 1: Basic interpolation with 2 points (linear case)
  console.log('Test 1: Basic 2-point interpolation');
  {
    const points = [
      { size: 1, price: 150.10 },
      { size: 5, price: 150.50 },
    ];
    const levels = interpolateLevels(points, 10);

    assert(levels.length > 0, 'Should produce at least 1 interpolated level');
    assert(levels.every(l => !isNaN(l.price)), 'No NaN prices');
    assert(levels.every(l => !isNaN(l.size) && l.size > 0), 'All sizes positive');
    assert(levels.every(l => l.interpolated === true), 'All levels marked interpolated');

    // Check monotonicity
    for (let i = 1; i < levels.length; i++) {
      assert(levels[i].price > levels[i - 1].price, 'Prices monotonically increasing');
    }
    console.log('  ✓ PASS');
  }

  // Test 2: Interpolation with 5 sampled points
  console.log('Test 2: 5-point interpolation');
  {
    const points = [
      { size: 0.5, price: 150.05 },
      { size: 1.0, price: 150.15 },
      { size: 2.0, price: 150.35 },
      { size: 5.0, price: 150.80 },
      { size: 10.0, price: 151.50 },
    ];
    const levels = interpolateLevels(points, 10);

    assert(levels.length >= 5, `Should produce multiple levels (got ${levels.length})`);
    assert(levels.every(l => !isNaN(l.price)), 'No NaN prices');
    assert(levels.every(l => !isNaN(l.size) && l.size > 0), 'All sizes positive');

    // Monotonicity
    for (let i = 1; i < levels.length; i++) {
      assert(levels[i].price > levels[i - 1].price, 'Prices monotonically increasing');
    }

    // Should not exceed max sampled price range
    const maxSampledPrice = Math.max(...points.map(p => p.price));
    assert(levels[levels.length - 1].price <= maxSampledPrice * 1.01,
      'Last level should be near max sampled price');
    console.log('  ✓ PASS');
  }

  // Test 3: Single point (edge case)
  console.log('Test 3: Single point (edge case)');
  {
    const points = [
      { size: 1, price: 150.00 },
    ];
    const levels = interpolateLevels(points, 10);

    assert(levels.length === 1, 'Should return 1 level (pass-through)');
    assert(levels[0].interpolated === false, 'Should not be marked interpolated');
    console.log('  ✓ PASS');
  }

  // Test 4: Empty array (edge case)
  console.log('Test 4: Empty array (edge case)');
  {
    const levels = interpolateLevels([], 10);
    assert(levels.length === 0, 'Should return empty array');
    console.log('  ✓ PASS');
  }

  // Test 5: PCHIP slopes computation
  console.log('Test 5: PCHIP slopes computation');
  {
    const x = [150.0, 150.5, 151.0, 152.0];
    const y = [0, 10, 30, 100];
    const slopes = computePchipSlopes(x, y);

    assert(slopes.length === 4, 'Should return slope for each point');
    assert(!slopes.some(isNaN), 'No NaN slopes');
    assert(slopes.every(s => !isNaN(s)), 'All slopes are finite');

    // For monotonic increasing data, interior slopes should be positive
    for (let i = 1; i < slopes.length - 1; i++) {
      assert(slopes[i] >= 0, `Interior slopes should be >= 0 (got ${slopes[i]})`);
    }
    console.log('  ✓ PASS');
  }

  // Test 6: Cubic Hermite evaluation
  console.log('Test 6: Cubic Hermite evaluation');
  {
    // Linear case: p0 = p1 = interval_slope = 10
    const result = evalCubicHermite(0, 1, 0, 10, 10, 10, 0.5);
    assertApprox(result, 5, 0.001, 'Midpoint of linear with matching slopes');
    console.log('  ✓ PASS');
  }

  // Test 7: Large gap interpolation
  console.log('Test 7: Large gap interpolation');
  {
    const points = [
      { size: 0.1, price: 150.01 },
      { size: 100, price: 160.00 },
    ];
    const levels = interpolateLevels(points, 10);

    assert(levels.length > 5, `Should produce many levels across large gap (got ${levels.length})`);
    assert(levels.every(l => !isNaN(l.price) && l.size > 0), 'All levels valid');
    for (let i = 1; i < levels.length; i++) {
      assert(levels[i].price > levels[i - 1].price, 'Monotonic prices');
    }
    console.log('  ✓ PASS');
  }

  // Test 8: Verify no duplicate prices
  console.log('Test 8: No duplicate prices');
  {
    const points = [
      { size: 1, price: 150.10 },
      { size: 5, price: 150.50 },
      { size: 20, price: 151.50 },
    ];
    const levels = interpolateLevels(points, 10);
    const prices = levels.map(l => l.price);

    for (let i = 1; i < prices.length; i++) {
      assert(prices[i] > prices[i - 1], `No duplicate prices: ${prices[i-1]} vs ${prices[i]}`);
    }
    console.log('  ✓ PASS');
  }

  console.log('\n=== All interpolation tests completed ===');
}

runTests();
