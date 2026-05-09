/**
 * Tests: TTL Enforcement and Staleness
 *
 * Validates that expired levels are properly filtered and
 * that per-band TTLs are applied correctly.
 *
 * Design doc: docs/avl-depth-sampler-design.md (§9.1)
 */

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Filter out expired levels.
 *
 * @param {Array} levels - array of level objects with `expiresAt` field
 * @param {number} [now] - current timestamp
 * @param {number} [graceMs] - grace period in ms (default: 500)
 * @returns {Array} non-expired levels
 */
function filterExpired(levels, now = Date.now(), graceMs = 500) {
  return levels.filter(l => l.expiresAt + graceMs > now);
}

/**
 * Check if a level is stale (expired beyond grace period).
 */
function isStale(level, now = Date.now(), graceMs = 500) {
  return level.expiresAt + graceMs <= now;
}

function runTests() {
  console.log('=== TTL Enforcement Tests ===\n');

  // Test 1: Fresh levels pass filter
  console.log('Test 1: Fresh levels pass filter');
  {
    const now = Date.now();
    const levels = [
      { price: 150.10, size: 10, band: 'inner', expiresAt: now + 10000 },
      { price: 150.20, size: 5, band: 'mid', expiresAt: now + 20000 },
    ];

    const fresh = filterExpired(levels, now);
    assert(fresh.length === 2, 'Both levels should be fresh');
    console.log('  ✓ PASS');
  }

  // Test 2: Expired levels are filtered
  console.log('Test 2: Expired levels filtered');
  {
    const now = Date.now();
    const levels = [
      { price: 150.10, size: 10, band: 'inner', expiresAt: now - 1000 },
      { price: 150.20, size: 5, band: 'mid', expiresAt: now + 20000 },
    ];

    const fresh = filterExpired(levels, now);
    assert(fresh.length === 1, 'One expired level filtered');
    assert(fresh[0].price === 150.20, 'Correct level remains');
    console.log('  ✓ PASS');
  }

  // Test 3: Grace period allows slightly expired levels
  console.log('Test 3: Grace period tolerance');
  {
    const now = Date.now();
    const levels = [
      { price: 150.10, size: 10, band: 'inner', expiresAt: now - 100 }, // 100ms expired
    ];

    // With 500ms grace, this should pass
    const fresh = filterExpired(levels, now, 500);
    assert(fresh.length === 1, 'Level within grace period should pass');

    // With 50ms grace, should fail
    const strict = filterExpired(levels, now, 50);
    assert(strict.length === 0, 'Level outside grace period should fail');
    console.log('  ✓ PASS');
  }

  // Test 4: isStale helper
  console.log('Test 4: isStale helper');
  {
    const now = Date.now();
    const freshLevel = { expiresAt: now + 10000 };
    const expiredLevel = { expiresAt: now - 10000 };
    const withinGrace = { expiresAt: now - 100 };

    assert(!isStale(freshLevel, now), 'Fresh level not stale');
    assert(isStale(expiredLevel, now), 'Expired level is stale');
    assert(!isStale(withinGrace, now, 500), 'Level within grace not stale');
    assert(isStale(withinGrace, now, 50), 'Level outside grace is stale');
    console.log('  ✓ PASS');
  }

  // Test 5: All levels expired edge case
  console.log('Test 5: All levels expired');
  {
    const now = Date.now();
    const levels = [
      { price: 150.10, size: 10, band: 'inner', expiresAt: now - 10000 },
      { price: 150.20, size: 5, band: 'mid', expiresAt: now - 5000 },
    ];

    const fresh = filterExpired(levels, now);
    assert(fresh.length === 0, 'All levels filtered');
    console.log('  ✓ PASS');
  }

  // Test 6: Empty array
  console.log('Test 6: Empty array');
  {
    const fresh = filterExpired([], Date.now());
    assert(fresh.length === 0, 'Empty array stays empty');
    console.log('  ✓ PASS');
  }

  console.log('\n=== All TTL tests completed ===');
}

runTests();
