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
  // Data parameters
  symbol: "SPY",            // ticker symbol (uses real data if cached, else synthetic)

  // Strategy parameters — agents change these
  lookback: 36,           // signal lookback period
  threshold: 0.0200,        // signal threshold for entry
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
  const signals = [];
  const lookback = 36;
  for (let i = lookback; i < prices.length; i++) {
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (prices[j].high > highest) highest = prices[j].high;
      if (prices[j].low < lowest) lowest = prices[j].low;
    }
    let signal = 0;
    if (prices[i].close > highest) signal = 1;
    if (prices[i].close < lowest) signal = -1;
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}

// ─── Backtest Engine (shared module) ─────────────────────

import {
  runBacktest as _runBacktest,
  computeMetrics,
  computeDrawdown,
  generateSamplePrices,
} from "../shared/backtest-engine.mjs";

function runBacktest(prices, signals) {
  return _runBacktest(signals, CONFIG);
}

// ─── Data Loading ─────────────────────────────────────────

async function loadPrices() {
  const symbol = process.env.SYMBOL || CONFIG.symbol || "SPY";

  // Try loading cached real data first
  const { readFileSync, existsSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cachePath = join(__dirname, "..", "data", "cache", `${symbol}.json`);

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`# Data: ${symbol} (real) — ${cached.count} days`);
    return cached.prices;
  }

  // Try realistic synthetic data
  try {
    const { generateRealisticPrices } = await import("../data/fetch.mjs");
    const prices = generateRealisticPrices(symbol, CONFIG.startDate, CONFIG.endDate);
    console.log(`# Data: ${symbol} (synthetic-realistic) — ${prices.length} days`);
    return prices;
  } catch {
    // Fallback to basic random walk
    console.log(`# Data: random walk — basic synthetic`);
    return generateSamplePrices(CONFIG.startDate, CONFIG.endDate);
  }
}

// ─── Main ────────────────────────────────────────────────

const prices = await loadPrices();
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
