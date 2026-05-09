#!/usr/bin/env node
/**
 * AVL Depth Sampler — Test Runner
 *
 * Runs all unit tests and reports results.
 * Usage: node src/avl/__tests__/run.js
 */

const path = require('path');
const fs = require('fs');

const testDir = __dirname;
const results = { passed: 0, failed: 0, total: 0 };

console.log('╔════════════════════════════════════════╗');
console.log('║   AVL Depth Sampler — Test Suite      ║');
console.log('╚════════════════════════════════════════╝\n');

const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js') && f !== 'run.js')
  .sort();

async function runAll() {
  let exitCode = 0;

  for (const file of testFiles) {
    console.log(`\n📋 Running: ${file}`);
    console.log('─'.repeat(50));

    try {
      // Capture the process exit code behavior
      const originalExit = process.exit;
      const originalExitCode = process.exitCode;

      // Reset exit code for this test
      process.exitCode = 0;

      require(path.join(testDir, file));

      if (process.exitCode !== 0) {
        exitCode = 1;
        results.failed++;
        console.log(`❌ ${file} — FAILED`);
      } else {
        results.passed++;
        console.log(`✅ ${file} — PASSED`);
      }

      results.total++;
    } catch (e) {
      console.error(`❌ ${file} — CRASHED: ${e.message}`);
      console.error(e.stack);
      results.failed++;
      results.total++;
      exitCode = 1;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 Summary: ${results.passed}/${results.total} passed`);

  if (results.failed > 0) {
    console.log(`❌ ${results.failed} test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('✅ All tests passed!');
    process.exitCode = 0;
  }
}

runAll();
