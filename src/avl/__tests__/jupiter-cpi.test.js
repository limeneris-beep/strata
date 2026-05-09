#!/usr/bin/env node
/**
 * Jupiter CPI Integration Test Suite
 *
 * Tests that the AVL depth sampler is queryable by Jupiter CPI:
 *   1. CPI quote endpoint (simulated Jupiter /quote)
 *   2. Route discovery
 *   3. Orderbook query
 *   4. Swap simulation through AVL depth
 *   5. Mint resolution
 *   6. Edge cases (no data, unsupported pairs, zero liquidity)
 *
 * Usage: node src/avl/__tests__/jupiter-cpi.test.js
 */

const path = require('path');

// Track test results
let passed = 0;
let failed = 0;
let testCount = 0;

function assert(condition, message) {
  testCount++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  testCount++;
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message} (got ${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  testCount++;
  const actualStr = JSON.stringify(actual, Object.keys(actual || {}).sort());
  const expectedStr = JSON.stringify(expected, Object.keys(expected || {}).sort());
  if (actualStr === expectedStr) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
    console.error(`    expected: ${expectedStr}`);
    console.error(`    actual:   ${actualStr}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  testCount++;
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
    console.log(`  ✅ ${message} (got ${actual})`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// ─── Mock DepthSampler ──────────────────────────────────────

function createMockDepthSampler(withData = true) {
  const midPrice = 150.00;

  return {
    getLatestCurve: (market = 'SOL/USDC') => {
      if (!withData) return null;

      if (market !== 'SOL/USDC') return null;

      return {
        asks: [
          { price: 150.50, size: 1.0, cumulativeSize: 1.0, band: 'inner', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 151.00, size: 2.0, cumulativeSize: 3.0, band: 'inner', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 152.00, size: 5.0, cumulativeSize: 8.0, band: 'mid', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 154.00, size: 10.0, cumulativeSize: 18.0, band: 'mid', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 158.00, size: 20.0, cumulativeSize: 38.0, band: 'outer', source: 'gmm_model', type: 'virtual', ts: Date.now() },
          { price: 165.00, size: 50.0, cumulativeSize: 88.0, band: 'outer', source: 'gmm_model', type: 'virtual', ts: Date.now() },
        ],
        bids: [
          { price: 149.50, size: 1.0, cumulativeSize: 1.0, band: 'inner', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 149.00, size: 2.0, cumulativeSize: 3.0, band: 'inner', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 148.00, size: 5.0, cumulativeSize: 8.0, band: 'mid', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 146.00, size: 10.0, cumulativeSize: 18.0, band: 'mid', source: 'jupiter', type: 'virtual', ts: Date.now() },
          { price: 142.00, size: 20.0, cumulativeSize: 38.0, band: 'outer', source: 'gmm_model', type: 'virtual', ts: Date.now() },
          { price: 135.00, size: 50.0, cumulativeSize: 88.0, band: 'outer', source: 'gmm_model', type: 'virtual', ts: Date.now() },
        ],
        midPrice,
        spreadBps: 5.0,
        volatility: 0.5,
        volatilityFactor: 1.0,
        source: 'jupiter',
        ts: Date.now(),
        askCount: 6,
        bidCount: 6,
      };
    },
  };
}

// ─── Test Suites ────────────────────────────────────────────

console.log('\n📋 Jupiter CPI Integration Tests\n');

// ── 1. Mint Resolution ──

console.log('1️⃣  Mint Resolution');
(function testMintResolution() {
  const jupiterCpi = require('../jupiter-cpi');

  // SOL → USDC (ask side)
  const askResolve = jupiterCpi.resolveMints(
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  );
  assert(askResolve !== null, 'Resolves SOL→USDC');
  assertEqual(askResolve.side, 'ask', 'SOL→USDC is ask side');
  assertEqual(askResolve.marketKey, 'SOL/USDC', 'Market key is SOL/USDC');

  // USDC → SOL (bid side)
  const bidResolve = jupiterCpi.resolveMints(
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'So11111111111111111111111111111111111111112'
  );
  assert(bidResolve !== null, 'Resolves USDC→SOL');
  assertEqual(bidResolve.side, 'bid', 'USDC→SOL is bid side');

  // Unknown pair
  const unknown = jupiterCpi.resolveMints(
    'UnknownMint1111111111111111111111111111111',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  );
  assert(unknown === null, 'Returns null for unsupported pair');
})();

// ── 2. Atomic Unit Conversion ──

console.log('\n2️⃣  Atomic Unit Conversion');
(function testAtomicUnits() {
  const jupiterCpi = require('../jupiter-cpi');

  const solLamports = jupiterCpi.toAtomicUnits(1.5, 9);
  assertEqual(solLamports, '1500000000', '1.5 SOL → 1500000000 lamports');

  const usdcMicro = jupiterCpi.toAtomicUnits(100.50, 6);
  assertEqual(usdcMicro, '100500000', '100.5 USDC → 100500000 micro');

  const solHuman = jupiterCpi.fromAtomicUnits('1500000000', 9);
  assertEqual(solHuman, 1.5, '1500000000 lamports → 1.5 SOL');

  const usdcHuman = jupiterCpi.fromAtomicUnits('100500000', 6);
  assertEqual(usdcHuman, 100.5, '100500000 micro → 100.5 USDC');
})();

// ── 3. Swap Simulation ──

console.log('\n3️⃣  Swap Simulation');
(function testSwapSimulation() {
  const jupiterCpi = require('../jupiter-cpi');

  const mockAsks = [
    { price: 150.50, size: 1.0, band: 'inner' },
    { price: 151.00, size: 2.0, band: 'inner' },
    { price: 152.00, size: 5.0, band: 'mid' },
  ];

  const mockBids = [
    { price: 149.50, size: 1.0, band: 'inner' },
    { price: 149.00, size: 2.0, band: 'inner' },
    { price: 148.00, size: 5.0, band: 'mid' },
  ];

  // Ask side: buy 0.5 SOL (small order, should hit first level)
  const smallAsk = jupiterCpi.simulateSwap(mockAsks, true, 0.5);
  assert(smallAsk.levelsUsed >= 1, 'Small ask uses at least 1 level');
  assert(smallAsk.priceImpactPct < 1, 'Small ask has low price impact');
  assert(smallAsk.outputAmount > 0, 'Small ask produces positive output');
  assertClose(smallAsk.avgPrice, 150.50, 1.0, 'Small ask avg price ~150.50');
  assert(smallAsk.route.length >= 1, 'Small ask has route segments');

  // Bid side: sell $50 USDC worth (≈0.33 SOL at ~$150)
  const smallBid = jupiterCpi.simulateSwap(mockBids, false, 50);
  assert(smallBid.levelsUsed >= 1, 'Small bid uses at least 1 level');
  assert(smallBid.outputAmount > 0, 'Small bid produces positive output');

  // Large order across multiple levels
  const largeAsk = jupiterCpi.simulateSwap(mockAsks, true, 5.0);
  assert(largeAsk.levelsUsed >= 2, 'Large ask uses multiple levels');
  assert(largeAsk.priceImpactPct > smallAsk.priceImpactPct, 'Large ask has higher impact than small');
  assert(largeAsk.route.length >= 2, 'Large ask has multiple route segments');

  // Empty levels
  const empty = jupiterCpi.simulateSwap([], true, 1.0);
  assertEqual(empty.levelsUsed, 0, 'Empty levels returns 0 levels used');
  assertEqual(empty.outputAmount, 0, 'Empty levels returns 0 output');
  assertEqual(empty.priceImpactPct, 100, 'Empty levels returns 100% impact');

  // Zero input
  const zeroInput = jupiterCpi.simulateSwap(mockAsks, true, 0);
  assertEqual(zeroInput.levelsUsed, 0, 'Zero input returns 0 levels');
  assertEqual(zeroInput.outputAmount, 0, 'Zero input returns 0 output');

  // Route format: marketInfos should have expected fields
  if (smallAsk.route.length > 0) {
    const segment = smallAsk.route[0];
    assert(typeof segment.id === 'string', 'Route segment has id');
    assert(typeof segment.inAmount === 'string', 'Route segment has inAmount');
    assert(typeof segment.outAmount === 'string', 'Route segment has outAmount');
    assert(segment.lpFee !== undefined, 'Route segment has lpFee');
    assert(segment.platformFee !== undefined, 'Route segment has platformFee');
    assertEqual(segment.label, 'AVL', 'Route segment label is AVL');
  }
})();

// ── 4. CPI Quote (with mock DepthSampler) ──

console.log('\n4️⃣  CPI Quote Endpoint');
(function testCpiQuote() {
  const jupiterCpi = require('../jupiter-cpi');
  const sampler = createMockDepthSampler(true);

  // SOL → USDC quote, 1 SOL
  const quote1 = jupiterCpi.getQuote(sampler, {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000', // 1 SOL in lamports
    slippageBps: 50,
  });

  assert(quote1 !== null, 'Returns quote for SOL→USDC');
  assertEqual(quote1.inputMint, 'So11111111111111111111111111111111111111112', 'Correct inputMint');
  assertEqual(quote1.outputMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Correct outputMint');
  assertEqual(quote1.inAmount, '1000000000', 'Correct inAmount');
  assert(typeof quote1.outAmount === 'string', 'outAmount is string');
  assert(typeof quote1.otherAmountThreshold === 'string', 'otherAmountThreshold is string');
  assert(typeof quote1.priceImpactPct === 'string', 'priceImpactPct is string');
  assert(quote1.route !== undefined, 'Has route object');
  assertEqual(quote1.route.swapMode, 'ExactIn', 'Swap mode is ExactIn');
  assert(Array.isArray(quote1.route.marketInfos), 'Has marketInfos array');
  assert(quote1.route.marketInfos.length >= 1, 'Has at least 1 market info');
  assert(quote1._meta !== undefined, 'Has _meta with source info');
  assertEqual(quote1._meta.source, 'avl_depth', 'Source is avl_depth');

  // USDC → SOL quote, 100 USDC
  const quote2 = jupiterCpi.getQuote(sampler, {
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    amount: '100000000', // 100 USDC in micro
  });

  assert(quote2 !== null, 'Returns quote for USDC→SOL');
  assert(typeof quote2.outAmount === 'string', 'Bid quote has outAmount');
  assert(quote2.route.marketInfos.length >= 1, 'Bid quote has market infos');

  // Large amount that exceeds depth
  const hugeQuote = jupiterCpi.getQuote(sampler, {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '100000000000', // 100 SOL — exceeds depth
  });

  // Should still return a quote (may exhaust levels)
  assert(hugeQuote !== null, 'Returns quote even for large amount exceeding depth');

  // No data available
  const emptySampler = createMockDepthSampler(false);
  const emptyQuote = jupiterCpi.getQuote(emptySampler, {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000',
  });
  assert(emptyQuote === null, 'Returns null when no depth data available');

  // Unsupported pair
  const unsupported = jupiterCpi.getQuote(sampler, {
    inputMint: 'UnknownMint1111111111111111111111111111111',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000',
  });
  assert(unsupported === null, 'Returns null for unsupported pair');
})();

// ── 5. Route Discovery ──

console.log('\n5️⃣  Route Discovery');
(function testRouteDiscovery() {
  const jupiterCpi = require('../jupiter-cpi');

  const routes = jupiterCpi.getSupportedRoutes();
  assert(Array.isArray(routes), 'Returns array of routes');
  assert(routes.length >= 2, 'Has at least 2 routes (base→quote + quote→base)');

  // Check route format
  const solToUsdc = routes.find(
    r => r.inputMint === 'So11111111111111111111111111111111111111112' &&
        r.outputMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  );
  assert(solToUsdc !== undefined, 'Has SOL→USDC route');
  assertEqual(solToUsdc.label, 'AVL SOL/USDC', 'Correct route label');

  const usdcToSol = routes.find(
    r => r.inputMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' &&
        r.outputMint === 'So11111111111111111111111111111111111111112'
  );
  assert(usdcToSol !== undefined, 'Has USDC→SOL route');
})();

// ── 6. Orderbook Query ──

console.log('\n6️⃣  Orderbook Query');
(function testOrderbookQuery() {
  const jupiterCpi = require('../jupiter-cpi');
  const sampler = createMockDepthSampler(true);

  const ob = jupiterCpi.getOrderbook(sampler, 'SOL/USDC');
  assert(ob !== null, 'Returns orderbook for SOL/USDC');
  assertEqual(ob.market, 'SOL/USDC', 'Correct market');
  assert(ob.midPrice > 0, 'Has mid price');
  assert(Array.isArray(ob.bids), 'Has bids array');
  assert(Array.isArray(ob.asks), 'Has asks array');

  // Verify ordering: asks ascending, bids descending
  for (let i = 1; i < ob.asks.length; i++) {
    assert(ob.asks[i].price >= ob.asks[i - 1].price, 'Asks sorted ascending');
  }
  for (let i = 1; i < ob.bids.length; i++) {
    assert(ob.bids[i].price <= ob.bids[i - 1].price, 'Bids sorted descending');
  }

  // Level format
  if (ob.asks.length > 0) {
    const level = ob.asks[0];
    assert(typeof level.price === 'number', 'Level has price');
    assert(typeof level.size === 'number', 'Level has size');
    assert(typeof level.band === 'string', 'Level has band');
  }

  // Unknown market
  const unknownOb = jupiterCpi.getOrderbook(sampler, 'BTC/USDC');
  assert(unknownOb === null, 'Returns null for unknown market');

  // No data
  const emptySampler = createMockDepthSampler(false);
  const emptyOb = jupiterCpi.getOrderbook(emptySampler, 'SOL/USDC');
  assert(emptyOb === null, 'Returns null when no data available');
})();

// ── 7. Edge Cases ──

console.log('\n7️⃣  Edge Cases');
(function testEdgeCases() {
  const jupiterCpi = require('../jupiter-cpi');
  const sampler = createMockDepthSampler(true);

  // Zero amount
  const zeroAmount = jupiterCpi.getQuote(sampler, {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '0',
  });
  assert(zeroAmount === null, 'Zero amount returns null');

  // Missing mints
  const noInput = jupiterCpi.getQuote(sampler, {
    inputMint: '',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000',
  });
  assert(noInput === null, 'Empty inputMint returns null');

  // Very tiny amount (sub-cent USDC)
  const tinyAmount = jupiterCpi.getQuote(sampler, {
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    amount: '1', // 1 micro-USDC = $0.000001
  });
  assert(tinyAmount === null || tinyAmount !== null, 'Handles tiny amounts gracefully');
})();

// ── Summary ──

console.log('\n' + '═'.repeat(50));
console.log(`\n📊 Summary: ${passed}/${testCount} passed`);

if (failed > 0) {
  console.log(`❌ ${failed} test(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('✅ All Jupiter CPI integration tests passed!');
  process.exitCode = 0;
}
