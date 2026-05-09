/**
 * Tests: Scheduler (Adaptive Sampling Cadence)
 *
 * Validates scheduler timing, exponential backoff, and
 * volatility-triggered interval tightening.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

const { Scheduler } = require('../scheduler');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function runTests() {
  console.log('=== Scheduler Tests ===\n');

  // Test 1: Initial state
  console.log('Test 1: Initial state');
  {
    const s = new Scheduler();
    const status = s.getStatus();

    assert(status.inner.interval === 5000, `Inner interval = 5000ms (got ${status.inner.interval})`);
    assert(status.mid.interval === 15000, `Mid interval = 15000ms (got ${status.mid.interval})`);
    assert(status.outer.interval === 45000, `Outer interval = 45000ms (got ${status.outer.interval})`);
    assert(status.inner.errors === 0, 'Initial errors = 0');
    assert(status.inner.successes === 0, 'Initial successes = 0');
    assert(status.inner.healthy === true, 'Initial healthy = true');
    console.log('  ✓ PASS');
  }

  // Test 2: isDue checks
  console.log('Test 2: isDue checks');
  {
    const s = new Scheduler();
    const now = Date.now();

    // Initially lastRun=0 so it should be due
    assert(s.isDue('inner', now) === true, 'Initially due');
    assert(s.isDue('mid', now) === true, 'Mid initially due');
    assert(s.isDue('outer', now) === true, 'Outer initially due');

    // After onSuccess, should not be due immediately
    s.onSuccess('inner');
    // Need to wait a tiny bit or use old timestamp
    // onSuccess sets lastRun, so nextRun = lastRun + interval = now + 5000
    const after = s.nextRun('inner');
    assert(after > now, `Next run should be in the future (${after} > ${now})`);
    console.log('  ✓ PASS');
  }

  // Test 3: Exponential backoff on errors
  console.log('Test 3: Exponential backoff');
  {
    const s = new Scheduler();

    const interval1 = s.onError('inner');
    assert(interval1 > 5000, `First backoff > 5s (got ${interval1}ms)`);
    assert(s.bands.inner.consecutiveErrors === 1, '1 consecutive error');

    const interval2 = s.onError('inner');
    assert(interval2 > interval1, `Second backoff > first (${interval2} > ${interval1})`);
    assert(s.bands.inner.consecutiveErrors === 2, '2 consecutive errors');

    const interval3 = s.onError('inner');
    assert(interval3 > interval2, `Third backoff > second (${interval3} > ${interval2})`);

    console.log(`  Backoffs: ${interval1} → ${interval2} → ${interval3}ms`);
    console.log('  ✓ PASS');
  }

  // Test 4: Error recovery resets backoff
  console.log('Test 4: Error recovery');
  {
    const s = new Scheduler();
    s.onError('inner');
    s.onError('inner');
    assert(s.bands.inner.consecutiveErrors === 2, '2 errors before recovery');

    s.onSuccess('inner');
    assert(s.bands.inner.consecutiveErrors === 0, 'Errors reset after success');
    assert(s.bands.inner.errors === 0, 'Total errors reset');
    console.log('  ✓ PASS');
  }

  // Test 5: Max backoff ceiling
  console.log('Test 5: Max backoff ceiling');
  {
    const s = new Scheduler();
    let interval = s.bands.inner.interval;

    // Simulate many errors
    for (let i = 0; i < 10; i++) {
      interval = s.onError('inner');
    }

    assert(interval <= s.maxInterval, `Backoff capped at ${s.maxInterval}ms (got ${interval})`);
    console.log('  ✓ PASS');
  }

  // Test 6: Volatility spike tightens intervals
  console.log('Test 6: Volatility spike');
  {
    const s = new Scheduler();
    // Simulate a stable state first
    s.onSuccess('inner');
    s.onSuccess('mid');
    s.onSuccess('outer');

    const beforeInner = s.getInterval('inner');
    const beforeMid = s.getInterval('mid');
    const beforeOuter = s.getInterval('outer');

    s.onVolatilitySpike(2.0);

    assert(s.getInterval('inner') < beforeInner, `Inner interval tightened (${s.getInterval('inner')} < ${beforeInner})`);
    assert(s.getInterval('mid') < beforeMid, `Mid interval tightened (${s.getInterval('mid')} < ${beforeMid})`);
    assert(s.getInterval('outer') < beforeOuter, `Outer interval tightened`);

    console.log(`  Inner: ${beforeInner} → ${s.getInterval('inner')}ms`);
    console.log(`  Mid: ${beforeMid} → ${s.getInterval('mid')}ms`);
    console.log('  ✓ PASS');
  }

  // Test 7: Volatility recovery restores intervals
  console.log('Test 7: Volatility recovery');
  {
    const s = new Scheduler();
    s.onVolatilitySpike(2.0);
    assert(s.getInterval('inner') < 5000, 'Inner tightened by spike');

    s.onVolatilityRecover(1.0);
    assert(s.getInterval('inner') >= 5000, `Inner restored after recovery (got ${s.getInterval('inner')}ms)`);
    console.log('  ✓ PASS');
  }

  // Test 8: Reset
  console.log('Test 8: Reset');
  {
    const s = new Scheduler();
    s.onError('inner');
    s.onError('inner');
    s.onSuccess('mid');
    s.onVolatilitySpike(2.0);

    s.reset();

    const status = s.getStatus();
    assert(status.inner.interval === 5000, 'Inner interval restored to default');
    assert(status.inner.errors === 0, 'Errors cleared');
    assert(status.inner.successes === 0, 'Successes cleared');
    console.log('  ✓ PASS');
  }

  console.log('\n=== All scheduler tests completed ===');
}

runTests();
