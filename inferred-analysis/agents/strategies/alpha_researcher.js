#!/usr/bin/env node
/**
 * Backtest Template — Inferred Analysis
 *
 * This is the equivalent of train.py in Karpathy's autoresearch.
 * Agents modify THIS FILE (or copies of it) to test trading strategies.
 *
 * The framework provides:
 * - Price data loading (CSV or API)
 * - Signal generation interface
 * - Portfolio simulation with transaction costs
 * - Standard metrics (Sharpe, drawdown, Sortino, Calmar)
 * - Fixed evaluation output format
 *
 * Usage:
 *   node agents/backtests/template.js
 *   node agents/backtests/template.js --data path/to/prices.csv
 */

// ─── Configuration (AGENT MODIFIES THESE) ──────────────────

const CONFIG = {
  // Strategy parameters — agents change these
  lookback: 11,           // signal lookback period
  threshold: 0.0343,        // signal threshold for entry
  stopLoss: -0.05,        // stop loss as fraction
  takeProfit: 0.10,       // take profit as fraction
  positionSize: 0.10,     // fraction of portfolio per position

  // Backtest parameters
  initialCapital: 1_000_000,
  transactionCostBps: 10, // 10 bps round-trip
  slippageBps: 5,         // 5 bps per trade
  startDate: "2020-01-01",
  endDate: "2024-12-31",
};

// ─── Signal Generation (AGENT MODIFIES THIS) ─────────────

/**
 * Generate trading signals from price data.
 * Returns array of { date, signal } where signal is -1 (short), 0 (flat), or 1 (long).
 *
 * THIS IS THE FUNCTION AGENTS MODIFY TO TEST DIFFERENT STRATEGIES.
 */
function generateSignals(prices) {
  try {
  const v = validatePriceData(prices);
  if (!v.valid) { console.error("[generateSignals] Invalid price data: " + v.errors.join("; ")); return []; }
  const signals = [];
  const lookback = 11;
  const threshold = 0.0343;
  for (let i = lookback; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += prices[j].close;
    const ma = sum / lookback;
    const deviation = (prices[i].close - ma) / ma;
    let signal = 0;
    if (deviation < -threshold) signal = 1;   // buy dip
    if (deviation > threshold) signal = -1;    // sell rally
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
  } catch (err) { console.error(`[generateSignals] Failed: ${err.message}`); return []; }
}

// ─── Backtest Engine (shared module) ─────────────────────

import {
  runBacktest as _runBacktest,
  computeMetrics,
  computeDrawdown,
  generateSamplePrices,
} from "../shared/backtest-engine.mjs";
import { validatePriceData } from "../shared/data-validation.mjs";

function runBacktest(prices, signals) {
  return _runBacktest(signals, CONFIG);
}

// ─── Main ────────────────────────────────────────────────

const prices = generateSamplePrices(CONFIG.startDate, CONFIG.endDate);
const signals = generateSignals(prices);
const metrics = runBacktest(prices, signals);

if (!metrics) {
  console.log("FAIL: No trading signals generated");
  process.exit(1);
}

// Output in autoresearch format (grep-friendly)
console.log("---");
console.log(`sharpe:           ${metrics.sharpe.toFixed(4)}`);
console.log(`sortino:          ${metrics.sortino.toFixed(4)}`);
console.log(`calmar:           ${metrics.calmar.toFixed(4)}`);
console.log(`total_return:     ${(metrics.total_return * 100).toFixed(2)}%`);
console.log(`annual_return:    ${(metrics.annualized_return * 100).toFixed(2)}%`);
console.log(`max_drawdown:     ${(metrics.max_drawdown * 100).toFixed(2)}%`);
console.log(`win_rate:         ${(metrics.win_rate * 100).toFixed(1)}%`);
console.log(`trades:           ${metrics.trades}`);
console.log(`days:             ${metrics.days}`);
console.log(`final_capital:    ${metrics.final_capital.toFixed(2)}`);
