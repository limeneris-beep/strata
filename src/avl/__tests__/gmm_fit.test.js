/**
 * Tests: GMM Fit and Extrapolation
 *
 * Validates that the GMM fitting converges on known parameters
 * and that extrapolated levels are sensible.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

const { cumulativeGMM, fitGMM, generateGMMLevels, normCdf } = require('../model/distributor');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function approx(a, b, tol) {
  return Math.abs(a - b) < tol;
}

function runTests() {
  console.log('=== GMM Tests ===\n');

  // Test 1: Cumulative GMM basic properties
  console.log('Test 1: Cumulative GMM properties');
  {
    const params = { w1: 0.7, σ1: 0.001, σ2: 0.005 };

    // At x=0, CDF should be 0.5 (since both components centered at 0)
    const cdfAtZero = cumulativeGMM(0, params);
    assert(approx(cdfAtZero, 0.5, 0.001), `CDF at 0 should be ~0.5 (got ${cdfAtZero})`);

    // Far negative → 0
    const cdfNeg = cumulativeGMM(-1, params);
    assert(approx(cdfNeg, 0, 0.01), `CDF at -1 should be ~0 (got ${cdfNeg})`);

    // Far positive → 1
    const cdfPos = cumulativeGMM(1, params);
    assert(approx(cdfPos, 1, 0.01), `CDF at 1 should be ~1 (got ${cdfPos})`);

    // Monotonic increasing
    assert(cumulativeGMM(0.001, params) > cdfAtZero, 'CDF increases with x');
    console.log('  ✓ PASS');
  }

  // Test 2: normCdf correctness
  console.log('Test 2: normCdf correctness');
  {
    assert(approx(normCdf(0), 0.5, 0.001), 'normCdf(0) = 0.5');
    assert(approx(normCdf(-1.96), 0.025, 0.01), 'normCdf(-1.96) ≈ 0.025');
    assert(approx(normCdf(1.96), 0.975, 0.01), 'normCdf(1.96) ≈ 0.975');
    console.log('  ✓ PASS');
  }

  // Test 3: fitGMM with known synthetic data
  console.log('Test 3: fitGMM with synthetic data');
  {
    const trueParams = { w1: 0.7, σ1: 0.001, σ2: 0.005 };
    const midPrice = 150;

    // Generate synthetic data from known GMM
    const points = [];
    const testPrices = [150.05, 150.10, 150.20, 150.50, 151.00, 152.00, 154.00];
    let prevCum = 0;
    for (const price of testPrices) {
      const logRet = Math.log(price / midPrice);
      const cumFrac = cumulativeGMM(logRet, trueParams);
      const cumSize = cumFrac * 5000;
      const size = cumSize - prevCum;
      points.push({ size, price });
      prevCum = cumSize;
    }

    const fitted = fitGMM(points, midPrice);
    assert(fitted !== null, 'Should return fitted params');
    assert(fitted.w1 > 0.5 && fitted.w1 < 0.9, `w1 should be in [0.5, 0.9] (got ${fitted.w1})`);
    assert(fitted.σ1 > 0, 'σ1 should be positive');
    assert(fitted.σ2 > fitted.σ1, 'σ2 should be > σ1');
    console.log(`  Params: w1=${fitted.w1.toFixed(3)}, σ1=${fitted.σ1.toFixed(5)}, σ2=${fitted.σ2.toFixed(5)}`);
    console.log('  ✓ PASS');
  }

  // Test 4: fitGMM with insufficient data returns defaults
  console.log('Test 4: fitGMM with insufficient data');
  {
    const points = [{ size: 1, price: 151 }];
    const fitted = fitGMM(points, 150);
    assert(fitted !== null, 'Should return params even with 1 point');
    assert(fitted.w1 === 0.7, 'Should return default w1=0.7');
    console.log('  ✓ PASS');
  }

  // Test 5: generateGMMLevels produces valid output (wide sigmas)
  console.log('Test 5: GMM level generation');
  {
    const params = { w1: 0.7, σ1: 0.005, σ2: 0.05 };
    const levels = generateGMMLevels(150, params, 'ask');

    assert(levels.length > 0, 'Should produce levels');
    assert(levels.every(l => l.price > 150), 'All ask prices > mid');
    assert(levels.every(l => l.size > 0), 'All sizes positive');
    assert(levels.every(l => !isNaN(l.price)), 'No NaN prices');
    assert(levels.every(l => l.modeled === true), 'All marked modeled');

    // Monotonic increasing prices
    for (let i = 1; i < levels.length; i++) {
      assert(levels[i].price > levels[i - 1].price, 'Prices monotonically increasing');
    }
    console.log('  ✓ PASS');
  }

  // Test 6: Bid-side GMM levels (with wider params to ensure coverage)
  console.log('Test 6: Bid-side GMM levels');
  {
    // Use wider sigmas so the distribution covers the extrapolation range
    const params = { w1: 0.7, σ1: 0.005, σ2: 0.05 };
    const levels = generateGMMLevels(150, params, 'bid');

    assert(levels.length > 0, 'Should produce levels');
    assert(levels.every(l => l.price < 150), 'All bid prices < mid');
    assert(levels.every(l => l.size > 0), 'All sizes positive');

    // Monotonic decreasing prices (more negative spread)
    for (let i = 1; i < levels.length; i++) {
      assert(levels[i].price < levels[i - 1].price, 'Bid prices monotonically decreasing');
    }
    console.log('  ✓ PASS');
  }

  // Test 7: Cumulative size should be capped (wider params)
  console.log('Test 7: Cumulative size capping');
  {
    const params = { w1: 0.7, σ1: 0.005, σ2: 0.05 };
    const levels = generateGMMLevels(150, params, 'ask');

    for (const level of levels) {
      assert(level.size <= 10, `Individual size capped at 10 (got ${level.size})`);
    }
    console.log('  ✓ PASS');
  }

  console.log('\n=== All GMM tests completed ===');
}

runTests();
