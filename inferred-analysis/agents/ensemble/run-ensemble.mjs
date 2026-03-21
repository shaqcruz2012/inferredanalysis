#!/usr/bin/env node
/**
 * Ensemble Runner — Inferred Analysis
 *
 * Loads all strategy files from agents/strategies/*.js, runs each one to
 * get signals, combines them via signal-aggregator, runs a combined backtest,
 * and outputs a comparison table plus results.tsv logging.
 *
 * Usage:
 *   node agents/ensemble/run-ensemble.mjs --method weighted --symbol SPY
 *   node agents/ensemble/run-ensemble.mjs --method majority
 *   node agents/ensemble/run-ensemble.mjs --method unanimous --symbol QQQ
 */

import { readFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { aggregateSignals, computeWeights, METHODS } from "./signal-aggregator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const STRATEGIES_DIR = join(AGENTS_DIR, "strategies");
const RESULTS_TSV = join(AGENTS_DIR, "results.tsv");

// ─── CLI Args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { method: "weighted", symbol: "SPY" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method" && args[i + 1]) {
      opts.method = args[++i];
    } else if (args[i] === "--symbol" && args[i + 1]) {
      opts.symbol = args[++i];
    }
  }
  if (!METHODS.includes(opts.method)) {
    console.error(`Unknown method "${opts.method}". Available: ${METHODS.join(", ")}`);
    process.exit(1);
  }
  return opts;
}

// ─── Backtest Engine (shared module) ──────────────────────

import { runBacktest, generateSamplePrices } from "../shared/backtest-engine.mjs";

async function loadPrices(symbol) {
  const cachePath = join(AGENTS_DIR, "data", "cache", `${symbol}.json`);

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`# Data: ${symbol} (real) — ${cached.count} days`);
    return cached.prices;
  }

  try {
    const { generateRealisticPrices } = await import("../data/fetch.mjs");
    const prices = generateRealisticPrices(symbol, "2020-01-01", "2024-12-31");
    console.log(`# Data: ${symbol} (synthetic-realistic) — ${prices.length} days`);
    return prices;
  } catch {
    console.log(`# Data: random walk — basic synthetic`);
    return generateSamplePrices("2020-01-01", "2024-12-31");
  }
}

// ─── Strategy Loader ──────────────────────────────────────

/**
 * Extract CONFIG and generateSignals from a strategy .js file.
 * Strategy files are self-contained scripts with their own CONFIG and
 * generateSignals function. We extract these by evaluating the relevant
 * portions in a controlled way.
 */
function loadStrategy(filePath) {
  const code = readFileSync(filePath, "utf-8");
  const name = basename(filePath, ".js");

  // Extract CONFIG object
  const configMatch = code.match(/const\s+CONFIG\s*=\s*(\{[\s\S]*?\n\});\s*\n/);
  if (!configMatch) {
    console.error(`  [WARN] Could not extract CONFIG from ${name}, skipping`);
    return null;
  }

  // Extract generateSignals function
  const sigMatch = code.match(/(function\s+generateSignals\s*\(prices\)\s*\{[\s\S]*?\n\})\s*\n/);
  if (!sigMatch) {
    console.error(`  [WARN] Could not extract generateSignals from ${name}, skipping`);
    return null;
  }

  // Build a module that returns { CONFIG, generateSignals }
  // We use Function constructor to safely evaluate the extracted code
  try {
    const configCode = configMatch[1].replace(/(\d)_(\d)/g, "$1$2"); // remove numeric separators
    const evalConfig = new Function(`return ${configCode}`)();

    const fnBody = sigMatch[1];
    // Wrap the function so it's available to call
    const evalFn = new Function("prices", `
      ${fnBody}
      return generateSignals(prices);
    `);

    return { name, config: evalConfig, generateSignals: evalFn };
  } catch (err) {
    console.error(`  [WARN] Failed to load ${name}: ${err.message}`);
    return null;
  }
}

// ─── Table Formatting ─────────────────────────────────────

function formatTable(rows) {
  // rows: [{ name, metrics }]
  const header = "Agent              | Sharpe | Return | MaxDD  | Trades";
  const sep    = "-------------------+--------+--------+--------+-------";
  const lines = [header, sep];

  for (const row of rows) {
    const m = row.metrics;
    const name = row.name.padEnd(19);
    const sharpe = (m ? m.sharpe.toFixed(2) : "N/A").padStart(6);
    const ret = (m ? `${(m.total_return * 100).toFixed(0)}%` : "N/A").padStart(6);
    const dd = (m ? `${(m.max_drawdown * 100).toFixed(0)}%` : "N/A").padStart(6);
    const trades = (m ? String(m.trades) : "N/A").padStart(6);
    lines.push(`${name}| ${sharpe} | ${ret} | ${dd} | ${trades}`);
  }

  return lines.join("\n");
}

// ─── Results Logging ──────────────────────────────────────

function logResult(symbol, method, metrics) {
  const ts = new Date().toISOString();
  const line = [
    ts,
    `ensemble_${method}`,
    symbol,
    metrics.sharpe.toFixed(4),
    (metrics.total_return * 100).toFixed(2) + "%",
    (metrics.max_drawdown * 100).toFixed(2) + "%",
    metrics.trades,
    metrics.days,
    metrics.final_capital.toFixed(2),
  ].join("\t");

  appendFileSync(RESULTS_TSV, line + "\n");
  console.log(`\n# Result appended to results.tsv`);
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`# Ensemble Runner`);
  console.log(`# Method: ${opts.method} | Symbol: ${opts.symbol}\n`);

  // 1. Load price data
  const prices = await loadPrices(opts.symbol);
  if (!prices || prices.length === 0) {
    console.error("FAIL: No price data available");
    process.exit(1);
  }

  // 2. Discover and load strategy files
  const strategyFiles = readdirSync(STRATEGIES_DIR)
    .filter(f => f.endsWith(".js") && f !== ".gitkeep")
    .map(f => join(STRATEGIES_DIR, f));

  if (strategyFiles.length === 0) {
    console.error("FAIL: No strategy files found in agents/strategies/");
    process.exit(1);
  }

  console.log(`# Found ${strategyFiles.length} strategies\n`);

  // 3. Run each strategy individually
  const agentResults = [];

  for (const file of strategyFiles) {
    const strategy = loadStrategy(file);
    if (!strategy) continue;

    console.log(`  Running: ${strategy.name}`);
    try {
      const signals = strategy.generateSignals(prices);
      if (!signals || signals.length === 0) {
        console.log(`    -> No signals generated, skipping`);
        continue;
      }

      const metrics = runBacktest(signals);
      agentResults.push({
        name: strategy.name,
        signals,
        metrics,
      });
      console.log(`    -> Sharpe: ${metrics.sharpe.toFixed(4)}, Return: ${(metrics.total_return * 100).toFixed(1)}%, Trades: ${metrics.trades}`);
    } catch (err) {
      console.error(`    -> ERROR: ${err.message}`);
    }
  }

  if (agentResults.length === 0) {
    console.error("\nFAIL: No strategies produced valid results");
    process.exit(1);
  }

  // 4. Compute weights from individual agent performance
  const weights = computeWeights(
    agentResults.map(a => ({ name: a.name, metrics: a.metrics }))
  );
  console.log(`\n# Weights: ${JSON.stringify(weights)}`);

  // 5. Aggregate signals using the chosen method
  const agentSignals = agentResults.map(a => ({
    name: a.name,
    signals: a.signals,
    weight: weights[a.name],
  }));

  const ensembleSignals = aggregateSignals(agentSignals, { method: opts.method });
  console.log(`# Ensemble signals: ${ensembleSignals.length} dates\n`);

  if (ensembleSignals.length === 0) {
    console.error("FAIL: No ensemble signals produced (strategies may not overlap on dates)");
    process.exit(1);
  }

  // 6. Run ensemble backtest
  const ensembleMetrics = runBacktest(ensembleSignals);

  if (!ensembleMetrics) {
    console.error("FAIL: Ensemble backtest produced no metrics");
    process.exit(1);
  }

  // 7. Build comparison table
  const tableRows = [
    ...agentResults.map(a => ({ name: a.name, metrics: a.metrics })),
    { name: `ENSEMBLE (${opts.method})`, metrics: ensembleMetrics },
  ];

  console.log("");
  console.log(formatTable(tableRows));

  // 8. Detailed ensemble metrics
  console.log(`\n--- ENSEMBLE (${opts.method}) ---`);
  console.log(`sharpe:           ${ensembleMetrics.sharpe.toFixed(4)}`);
  console.log(`sortino:          ${ensembleMetrics.sortino.toFixed(4)}`);
  console.log(`calmar:           ${ensembleMetrics.calmar.toFixed(4)}`);
  console.log(`total_return:     ${(ensembleMetrics.total_return * 100).toFixed(2)}%`);
  console.log(`annual_return:    ${(ensembleMetrics.annualized_return * 100).toFixed(2)}%`);
  console.log(`max_drawdown:     ${(ensembleMetrics.max_drawdown * 100).toFixed(2)}%`);
  console.log(`win_rate:         ${(ensembleMetrics.win_rate * 100).toFixed(1)}%`);
  console.log(`trades:           ${ensembleMetrics.trades}`);
  console.log(`days:             ${ensembleMetrics.days}`);
  console.log(`final_capital:    ${ensembleMetrics.final_capital.toFixed(2)}`);

  // 9. Log to results.tsv
  logResult(opts.symbol, opts.method, ensembleMetrics);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
