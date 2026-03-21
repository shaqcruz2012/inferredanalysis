#!/usr/bin/env node
/**
 * End-to-end integration tests for shared modules.
 * Run: node tests/integration-test.mjs
 */

import { validatePriceData, sanitizePrices } from '../shared/data-validation.mjs';
import { runBacktest, computeMetrics, computeDrawdown, generateSamplePrices } from '../shared/backtest-engine.mjs';
import { clampWeight, normalizeWeights, applyPositionLimits } from '../shared/constraints.mjs';
import { alignSignals } from '../shared/signal-aligner.mjs';
import { atomicWriteFile, safeWriteJSON, safeReadJSON } from '../shared/atomic-writer.mjs';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

function cleanup(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
  // Clean up lock and backup files
  for (const suffix of ['.lock', '.bak.1', '.bak.2', '.bak.3']) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════
// 1. Data Validation
// ═══════════════════════════════════════════════════════════
console.log('\n=== 1. Data Validation ===');

// validatePriceData catches NaN
{
  const result = validatePriceData([{ close: NaN }]);
  assert(!result.valid, 'validatePriceData rejects NaN close');
  assert(result.errors.length > 0, 'validatePriceData reports error for NaN');
}

// validatePriceData catches negative prices
{
  const result = validatePriceData([{ close: -5 }]);
  assert(!result.valid, 'validatePriceData rejects negative close');
}

// validatePriceData catches empty arrays
{
  const result = validatePriceData([]);
  assert(!result.valid, 'validatePriceData rejects empty array');
}

// validatePriceData accepts valid data
{
  const result = validatePriceData([{ close: 100 }, { close: 101 }]);
  assert(result.valid, 'validatePriceData accepts valid prices');
  assert(result.cleanCount === 2, 'validatePriceData cleanCount is correct');
}

// sanitizePrices removes bad bars and fixes remaining
{
  const input = [
    { close: 100 },
    { close: NaN },
    { close: -10 },
    { close: 50, high: NaN, low: 40 },
  ];
  const sanitized = sanitizePrices(input);
  assert(sanitized.length === 2, 'sanitizePrices drops NaN and negative bars');
  assert(sanitized[0].close === 100, 'sanitizePrices preserves valid bar');
  assert(Number.isFinite(sanitized[1].high), 'sanitizePrices fixes NaN high');
}

// sanitizePrices handles non-array input
{
  const result = sanitizePrices(null);
  assert(Array.isArray(result) && result.length === 0, 'sanitizePrices returns [] for null');
}

// ═══════════════════════════════════════════════════════════
// 2. Backtest Engine
// ═══════════════════════════════════════════════════════════
console.log('\n=== 2. Backtest Engine ===');

{
  // Generate sample signals with alternating buy/sell
  const signals = [];
  let price = 100;
  for (let i = 0; i < 100; i++) {
    price *= 1 + (Math.random() - 0.48) * 0.02;
    const day = new Date(2023, 0, 2 + i);
    signals.push({
      date: day.toISOString().split('T')[0],
      signal: i % 10 < 5 ? 1 : -1,
      price,
    });
  }

  const result = runBacktest(signals);
  assert(result !== null, 'runBacktest returns a result');
  assert(Number.isFinite(result.sharpe), 'Sharpe is a valid number');
  assert(Number.isFinite(result.sortino), 'Sortino is a valid number');
  assert(Number.isFinite(result.max_drawdown), 'max_drawdown is a valid number');
  assert(result.max_drawdown >= 0 && result.max_drawdown <= 1, 'max_drawdown is in [0,1]');
  assert(result.trades > 0, 'trades > 0');
  assert(Number.isFinite(result.total_return), 'total_return is a valid number');
}

// runBacktest handles empty input
{
  const result = runBacktest([]);
  assert(result === null, 'runBacktest returns null for empty signals');
}

// computeDrawdown
{
  const curve = [
    { date: '2023-01-01', equity: 100 },
    { date: '2023-01-02', equity: 110 },
    { date: '2023-01-03', equity: 90 },
    { date: '2023-01-04', equity: 105 },
  ];
  const dd = computeDrawdown(curve);
  assert(dd.maxDrawdown > 0, 'computeDrawdown finds a drawdown');
  const expected = (110 - 90) / 110;
  assert(Math.abs(dd.maxDrawdown - expected) < 1e-10, 'computeDrawdown max is correct');
}

// ═══════════════════════════════════════════════════════════
// 3. Constraints
// ═══════════════════════════════════════════════════════════
console.log('\n=== 3. Constraints ===');

// clampWeight
{
  assert(clampWeight(1.5) === 1.0, 'clampWeight caps at 1.0');
  assert(clampWeight(-1.5) === -1.0, 'clampWeight floors at -1.0');
  assert(clampWeight(0.5) === 0.5, 'clampWeight passes through valid weight');
  assert(clampWeight(NaN) === 0, 'clampWeight converts NaN to 0');
  assert(clampWeight(Infinity) === 0, 'clampWeight converts Infinity to 0');
}

// normalizeWeights
{
  const w = normalizeWeights([2, 3, 5]);
  const sum = w.reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1.0) < 1e-10, 'normalizeWeights sums to 1.0');
  assert(w.length === 3, 'normalizeWeights preserves array length');
}

// normalizeWeights with NaN
{
  const w = normalizeWeights([NaN, 1, NaN]);
  assert(w.every(v => Number.isFinite(v)), 'normalizeWeights handles NaN inputs');
}

// applyPositionLimits
{
  const w = applyPositionLimits([0.5, 0.3, 0.2], 0.25);
  assert(w.every(v => Math.abs(v) <= 0.25 + 1e-10), 'applyPositionLimits caps positions');
  assert(w.every(v => Number.isFinite(v)), 'applyPositionLimits produces finite values');
}

// applyPositionLimits empty input
{
  const w = applyPositionLimits([]);
  assert(w.length === 0, 'applyPositionLimits handles empty array');
}

// ═══════════════════════════════════════════════════════════
// 4. Signal Aligner
// ═══════════════════════════════════════════════════════════
console.log('\n=== 4. Signal Aligner ===');

{
  const setA = {
    name: 'stratA',
    signals: [
      { date: '2023-01-02', signal: 1, price: 100 },
      { date: '2023-01-03', signal: -1, price: 101 },
      { date: '2023-01-04', signal: 1, price: 102 },
    ],
  };
  const setB = {
    name: 'stratB',
    signals: [
      { date: '2023-01-03', signal: 1, price: 101 },
      { date: '2023-01-05', signal: -1, price: 103 },
    ],
  };

  // Intersection alignment: only common dates
  const intersected = alignSignals([setA, setB], 'intersection');
  assert(intersected.length === 2, 'alignSignals intersection returns 2 sets');
  const datesA = intersected[0].signals.map(s => s.date);
  const datesB = intersected[1].signals.map(s => s.date);
  assert(datesA.length === 1 && datesA[0] === '2023-01-03', 'intersection keeps only shared date');
  assert(datesB.length === 1 && datesB[0] === '2023-01-03', 'intersection aligns both to shared date');

  // Union alignment: all dates, with fill
  const unioned = alignSignals([setA, setB], 'union');
  const unionDatesA = unioned[0].signals.map(s => s.date);
  const unionDatesB = unioned[1].signals.map(s => s.date);
  assert(unionDatesA.length === unionDatesB.length, 'union aligns both sets to same length');
  assert(unionDatesA.length >= 3, 'union includes dates from both sets');
}

// ═══════════════════════════════════════════════════════════
// 5. Atomic Writer
// ═══════════════════════════════════════════════════════════
console.log('\n=== 5. Atomic Writer ===');

{
  const testPath = join(__dirname, '_test_atomic_write.txt');
  cleanup(testPath);
  try {
    atomicWriteFile(testPath, 'hello world');
    const content = readFileSync(testPath, 'utf-8');
    assert(content === 'hello world', 'atomicWriteFile writes and reads back correctly');
  } finally {
    cleanup(testPath);
  }
}

{
  const testPath = join(__dirname, '_test_safe_json.json');
  cleanup(testPath);
  try {
    const data = { strategy: 'momentum', sharpe: 1.5, weights: [0.3, 0.7] };
    safeWriteJSON(testPath, data);
    const read = safeReadJSON(testPath, null);
    assert(read !== null, 'safeReadJSON reads back written data');
    assert(read.strategy === 'momentum', 'safeReadJSON preserves string fields');
    assert(read.sharpe === 1.5, 'safeReadJSON preserves numeric fields');
    assert(Array.isArray(read.weights) && read.weights.length === 2, 'safeReadJSON preserves arrays');
  } finally {
    cleanup(testPath);
  }
}

// safeReadJSON returns default for missing file
{
  const missing = join(__dirname, '_nonexistent_file.json');
  const result = safeReadJSON(missing, { fallback: true });
  assert(result.fallback === true, 'safeReadJSON returns default for missing file');
}

// ═══════════════════════════════════════════════════════════
// 6. Full Pipeline
// ═══════════════════════════════════════════════════════════
console.log('\n=== 6. Full Pipeline ===');

{
  // Step 1: Generate sample prices
  const prices = generateSamplePrices('2023-01-01', '2023-12-31', 100);
  assert(prices.length > 100, 'generateSamplePrices produces sufficient bars');

  // Step 2: Validate
  const validation = validatePriceData(prices);
  assert(validation.valid, 'generated prices pass validation');

  // Step 3: Generate a simple momentum signal
  const signals = [];
  for (let i = 5; i < prices.length; i++) {
    const momentum = prices[i].close - prices[i - 5].close;
    signals.push({
      date: prices[i].date,
      signal: momentum > 0 ? 1 : -1,
      price: prices[i].close,
    });
  }

  // Step 4: Run backtest
  const result = runBacktest(signals);
  assert(result !== null, 'pipeline: backtest produces result');
  assert(Number.isFinite(result.sharpe), 'pipeline: sharpe is finite');
  assert(Number.isFinite(result.sortino), 'pipeline: sortino is finite');
  assert(Number.isFinite(result.max_drawdown), 'pipeline: max_drawdown is finite');
  assert(Number.isFinite(result.total_return), 'pipeline: total_return is finite');
  assert(result.days > 50, 'pipeline: sufficient trading days');
  assert(result.trades > 0, 'pipeline: trades were executed');

  // Step 5: Verify scored result structure
  const scored = {
    strategy: 'momentum_5d',
    ...result,
    timestamp: new Date().toISOString(),
  };
  assert(typeof scored.strategy === 'string', 'pipeline: scored result has strategy name');
  assert(Number.isFinite(scored.sharpe), 'pipeline: scored result has valid sharpe');
  assert(Number.isFinite(scored.final_capital), 'pipeline: scored result has final_capital');
}

// ═══════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
