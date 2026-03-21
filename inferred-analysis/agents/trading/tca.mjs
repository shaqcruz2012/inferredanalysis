#!/usr/bin/env node
/**
 * Transaction Cost Analysis (TCA) Module
 *
 * Measures execution quality by decomposing the gap between expected
 * and actual trade performance into actionable cost components:
 * slippage, market impact, timing cost, commissions, and opportunity cost.
 *
 * Usage:
 *   import { analyzeTrade, analyzeStrategy, getTCAReport } from "./tca.mjs";
 *
 *   const metrics = analyzeTrade(trade);
 *   const report  = getTCAReport(trades);
 *
 * Trade shape expected:
 *   {
 *     symbol, side, qty, filledPrice, filledAt,
 *     arrivalPrice,          // mid-price at decision time
 *     expectedPrice?,        // strategy's target fill price
 *     marketPriceAtFill?,    // mid-price at actual fill time
 *     commission?,           // dollar commission
 *     slippage?,             // dollar slippage (from backtest engine)
 *     benchmarkClose?,       // closing price on trade date (for VWAP-style)
 *     strategyId?,           // for multi-strategy comparison
 *   }
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { safeReadJSON, safeWriteJSON } from "../shared/atomic-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = join(__dirname, "..", "outputs");
const TCA_STATE_PATH = join(OUTPUTS_DIR, "tca-state.json");

// ─── Helpers ──────────────────────────────────────────────

/** Convert an absolute price difference to basis points relative to a reference price. */
function toBps(diff, refPrice) {
  if (!refPrice || refPrice === 0) return 0;
  return (diff / refPrice) * 10000;
}

/** Safe division, returns 0 when denominator is 0. */
function safeDivide(num, denom) {
  return denom !== 0 ? num / denom : 0;
}

/** Arithmetic mean of an array. */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Standard deviation of an array. */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Percentile (linear interpolation). */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── analyzeTrade ─────────────────────────────────────────

/**
 * Compute per-trade execution quality metrics.
 *
 * @param {object} trade — trade record (see module header for expected shape)
 * @returns {object} — TCA metrics for this trade
 */
function analyzeTrade(trade) {
  const {
    symbol,
    side,
    qty,
    filledPrice,
    arrivalPrice,
    expectedPrice,
    marketPriceAtFill,
    commission = 0,
    slippage: rawSlippage,
    benchmarkClose,
    filledAt,
  } = trade;

  const sideSign = (side === "BUY" || side === "buy") ? 1 : -1;
  const notional = Math.abs(qty) * filledPrice;
  const arrival = arrivalPrice ?? expectedPrice ?? filledPrice;
  const midAtFill = marketPriceAtFill ?? filledPrice;

  // 1. Slippage: arrival price vs fill price (signed so positive = cost)
  const slippagePx = (filledPrice - arrival) * sideSign;
  const slippageBps = toBps(slippagePx, arrival);
  const slippageDollars = slippagePx * Math.abs(qty);

  // 2. Market impact: price moved between decision and fill
  const impactPx = (midAtFill - arrival) * sideSign;
  const impactBps = toBps(impactPx, arrival);
  const impactDollars = impactPx * Math.abs(qty);

  // 3. Timing cost: difference between fill price and market price at fill
  //    Captures adverse selection / delay between order and execution
  const timingPx = (filledPrice - midAtFill) * sideSign;
  const timingBps = toBps(timingPx, midAtFill);
  const timingDollars = timingPx * Math.abs(qty);

  // 4. Commission cost in bps
  const commissionBps = toBps(commission, notional) * 10000; // commission is already $, normalize
  // Simpler: commission as fraction of notional in bps
  const commBps = notional > 0 ? (commission / notional) * 10000 : 0;

  // 5. Total execution cost = slippage + commission (the two realized costs)
  const totalCostDollars = slippageDollars + commission;
  const totalCostBps = slippageBps + commBps;

  // 6. Benchmark comparison (vs close)
  let benchmarkSlippageBps = 0;
  if (benchmarkClose) {
    const benchDiff = (filledPrice - benchmarkClose) * sideSign;
    benchmarkSlippageBps = toBps(benchDiff, benchmarkClose);
  }

  return {
    symbol,
    side,
    qty: Math.abs(qty),
    filledPrice,
    arrivalPrice: arrival,
    notional,
    filledAt,

    slippage: {
      price: +slippagePx.toFixed(6),
      bps: +slippageBps.toFixed(2),
      dollars: +slippageDollars.toFixed(2),
    },
    marketImpact: {
      price: +impactPx.toFixed(6),
      bps: +impactBps.toFixed(2),
      dollars: +impactDollars.toFixed(2),
    },
    timingCost: {
      price: +timingPx.toFixed(6),
      bps: +timingBps.toFixed(2),
      dollars: +timingDollars.toFixed(2),
    },
    commission: {
      dollars: +commission.toFixed(2),
      bps: +commBps.toFixed(2),
    },
    totalCost: {
      dollars: +totalCostDollars.toFixed(2),
      bps: +totalCostBps.toFixed(2),
    },
    benchmarkSlippageBps: +benchmarkSlippageBps.toFixed(2),
  };
}

// ─── analyzeStrategy ──────────────────────────────────────

/**
 * Aggregate TCA across a set of trades for a single strategy.
 *
 * @param {object[]} trades — array of trade records
 * @returns {object} — aggregated TCA metrics
 */
function analyzeStrategy(trades) {
  if (!trades || trades.length === 0) {
    return {
      tradeCount: 0,
      totalNotional: 0,
      totalCostDollars: 0,
      totalCostBps: 0,
      avgCostPerTradeDollars: 0,
      avgCostPerTradeBps: 0,
      costAsPercentOfReturns: 0,
      slippage: { totalDollars: 0, avgBps: 0, medianBps: 0, stdBps: 0 },
      marketImpact: { totalDollars: 0, avgBps: 0 },
      timingCost: { totalDollars: 0, avgBps: 0 },
      commission: { totalDollars: 0, avgBps: 0 },
    };
  }

  const analyzed = trades.map(t => analyzeTrade(t));
  const n = analyzed.length;

  // Aggregate totals
  const totalNotional = analyzed.reduce((s, a) => s + a.notional, 0);
  const totalCostDollars = analyzed.reduce((s, a) => s + a.totalCost.dollars, 0);
  const totalSlippageDollars = analyzed.reduce((s, a) => s + a.slippage.dollars, 0);
  const totalImpactDollars = analyzed.reduce((s, a) => s + a.marketImpact.dollars, 0);
  const totalTimingDollars = analyzed.reduce((s, a) => s + a.timingCost.dollars, 0);
  const totalCommissionDollars = analyzed.reduce((s, a) => s + a.commission.dollars, 0);

  // Weighted average cost in bps (weighted by notional)
  const weightedCostBps = totalNotional > 0
    ? (totalCostDollars / totalNotional) * 10000
    : 0;

  // Per-trade bps arrays for distribution stats
  const slippageBpsArr = analyzed.map(a => a.slippage.bps);
  const sortedSlipBps = [...slippageBpsArr].sort((a, b) => a - b);

  // Gross P&L from trades (sum of (exit - entry) * qty * sideSign)
  // We approximate returns as negative of total cost for cost-as-% calculation
  // The caller should provide actual returns; we estimate from price moves
  const grossReturns = analyzed.reduce((s, a) => {
    // Use arrival-to-close if benchmark is available, otherwise skip
    return s + (a.benchmarkSlippageBps !== 0 ? a.notional * (a.benchmarkSlippageBps / 10000) : 0);
  }, 0);

  const costAsPctOfReturns = grossReturns !== 0
    ? Math.abs(totalCostDollars / grossReturns) * 100
    : 0;

  return {
    tradeCount: n,
    totalNotional: +totalNotional.toFixed(2),
    totalCostDollars: +totalCostDollars.toFixed(2),
    totalCostBps: +weightedCostBps.toFixed(2),
    avgCostPerTradeDollars: +(totalCostDollars / n).toFixed(2),
    avgCostPerTradeBps: +mean(analyzed.map(a => a.totalCost.bps)).toFixed(2),
    costAsPercentOfReturns: +costAsPctOfReturns.toFixed(2),

    slippage: {
      totalDollars: +totalSlippageDollars.toFixed(2),
      avgBps: +mean(slippageBpsArr).toFixed(2),
      medianBps: +percentile(sortedSlipBps, 50).toFixed(2),
      stdBps: +stddev(slippageBpsArr).toFixed(2),
      p95Bps: +percentile(sortedSlipBps, 95).toFixed(2),
    },
    marketImpact: {
      totalDollars: +totalImpactDollars.toFixed(2),
      avgBps: +mean(analyzed.map(a => a.marketImpact.bps)).toFixed(2),
    },
    timingCost: {
      totalDollars: +totalTimingDollars.toFixed(2),
      avgBps: +mean(analyzed.map(a => a.timingCost.bps)).toFixed(2),
    },
    commission: {
      totalDollars: +totalCommissionDollars.toFixed(2),
      avgBps: +mean(analyzed.map(a => a.commission.bps)).toFixed(2),
    },

    // Per-trade detail
    trades: analyzed,
  };
}

// ─── compareStrategies ────────────────────────────────────

/**
 * Rank strategies by execution efficiency.
 *
 * @param {object} strategyTrades — { strategyId: trades[] }
 * @returns {object[]} — strategies ranked by total cost (lowest = best)
 */
function compareStrategies(strategyTrades) {
  const results = [];

  for (const [strategyId, trades] of Object.entries(strategyTrades)) {
    const analysis = analyzeStrategy(trades);
    results.push({
      strategyId,
      tradeCount: analysis.tradeCount,
      totalNotional: analysis.totalNotional,
      totalCostBps: analysis.totalCostBps,
      totalCostDollars: analysis.totalCostDollars,
      avgSlippageBps: analysis.slippage.avgBps,
      avgImpactBps: analysis.marketImpact.avgBps,
      avgTimingBps: analysis.timingCost.avgBps,
      avgCommissionBps: analysis.commission.avgBps,
      costAsPercentOfReturns: analysis.costAsPercentOfReturns,
    });
  }

  // Rank by total cost in bps (ascending — lowest cost = rank 1)
  results.sort((a, b) => a.totalCostBps - b.totalCostBps);
  results.forEach((r, i) => { r.rank = i + 1; });

  return results;
}

// ─── getImplementationShortfall ───────────────────────────

/**
 * Implementation Shortfall decomposition.
 *
 * Breaks the gap between paper (expected) and actual returns into
 * three components:
 *   - delay:       cost of waiting between decision and order submission
 *   - trading:     cost of market movement during execution
 *   - opportunity: cost of trades not executed (unfilled qty)
 *
 * @param {object} expectedReturns — { grossReturn, trades: [{ symbol, side, qty, decisionPrice, orderPrice, filledPrice, filledQty, benchmarkClose }] }
 * @param {object} actualReturns   — { grossReturn, totalCommission }
 * @returns {object} — IS decomposition
 */
function getImplementationShortfall(expectedReturns, actualReturns) {
  const expectedGross = expectedReturns.grossReturn ?? 0;
  const actualGross = actualReturns.grossReturn ?? 0;
  const totalIS = expectedGross - actualGross;

  const trades = expectedReturns.trades ?? [];
  let delayComponent = 0;
  let tradingComponent = 0;
  let opportunityComponent = 0;

  for (const t of trades) {
    const {
      side,
      qty = 0,
      decisionPrice = 0,  // price when strategy decided to trade
      orderPrice = 0,     // price when order was submitted
      filledPrice = 0,    // actual fill price
      filledQty = 0,      // qty actually filled
      benchmarkClose = 0, // end-of-period benchmark
    } = t;

    const sideSign = (side === "BUY" || side === "buy") ? 1 : -1;
    const unfilledQty = Math.abs(qty) - Math.abs(filledQty);

    // Delay cost: price moved between decision and order submission
    // (orderPrice - decisionPrice) * filledQty * sideSign
    if (decisionPrice && orderPrice) {
      delayComponent += (orderPrice - decisionPrice) * Math.abs(filledQty) * sideSign;
    }

    // Trading cost: price moved between order submission and fill
    // (filledPrice - orderPrice) * filledQty * sideSign
    if (orderPrice && filledPrice) {
      tradingComponent += (filledPrice - orderPrice) * Math.abs(filledQty) * sideSign;
    } else if (decisionPrice && filledPrice) {
      // If no orderPrice, attribute all execution cost to trading
      tradingComponent += (filledPrice - decisionPrice) * Math.abs(filledQty) * sideSign;
    }

    // Opportunity cost: return foregone on unfilled shares
    // (benchmarkClose - decisionPrice) * unfilledQty * sideSign
    if (unfilledQty > 0 && decisionPrice && benchmarkClose) {
      opportunityComponent += (benchmarkClose - decisionPrice) * unfilledQty * sideSign;
    }
  }

  // Add commissions to trading component
  const commissions = actualReturns.totalCommission ?? 0;

  return {
    totalIS: +totalIS.toFixed(2),
    expectedReturn: +expectedGross.toFixed(2),
    actualReturn: +actualGross.toFixed(2),
    components: {
      delay: +delayComponent.toFixed(2),
      trading: +(tradingComponent + commissions).toFixed(2),
      opportunity: +opportunityComponent.toFixed(2),
      commission: +commissions.toFixed(2),
    },
    componentPct: {
      delay: +safeDivide(Math.abs(delayComponent), Math.abs(totalIS) || 1).toFixed(4) * 100,
      trading: +safeDivide(Math.abs(tradingComponent + commissions), Math.abs(totalIS) || 1).toFixed(4) * 100,
      opportunity: +safeDivide(Math.abs(opportunityComponent), Math.abs(totalIS) || 1).toFixed(4) * 100,
    },
  };
}

// ─── getCostBreakdown ─────────────────────────────────────

/**
 * Break total execution costs into commission, slippage, and market impact.
 *
 * Reads persisted TCA state for historical trend data.
 *
 * @returns {object} — cost breakdown with current and historical data
 */
function getCostBreakdown() {
  const state = loadState();
  const history = state.history ?? [];

  if (history.length === 0) {
    return {
      current: null,
      trend: [],
      message: "No TCA data persisted yet. Run getTCAReport() with trades to populate.",
    };
  }

  const latest = history[history.length - 1];
  const { slippage, marketImpact, commission, totalCostDollars } = latest;

  const totalComponents = (slippage?.totalDollars ?? 0)
    + (marketImpact?.totalDollars ?? 0)
    + (commission?.totalDollars ?? 0);

  return {
    current: {
      totalCostDollars: totalCostDollars ?? 0,
      commission: {
        dollars: commission?.totalDollars ?? 0,
        pctOfTotal: +safeDivide(commission?.totalDollars ?? 0, totalComponents).toFixed(4) * 100,
      },
      slippage: {
        dollars: slippage?.totalDollars ?? 0,
        pctOfTotal: +safeDivide(slippage?.totalDollars ?? 0, totalComponents).toFixed(4) * 100,
      },
      marketImpact: {
        dollars: marketImpact?.totalDollars ?? 0,
        pctOfTotal: +safeDivide(marketImpact?.totalDollars ?? 0, totalComponents).toFixed(4) * 100,
      },
    },
    trend: history.map(h => ({
      timestamp: h.timestamp,
      totalCostBps: h.totalCostBps ?? 0,
      slippageBps: h.slippage?.avgBps ?? 0,
      impactBps: h.marketImpact?.avgBps ?? 0,
      commissionBps: h.commission?.avgBps ?? 0,
      tradeCount: h.tradeCount ?? 0,
    })),
  };
}

// ─── getTCAReport ─────────────────────────────────────────

/**
 * Generate a formatted TCA report and persist results to state.
 *
 * @param {object[]} trades — array of trade records
 * @returns {string} — ASCII-formatted TCA report
 */
function getTCAReport(trades) {
  const analysis = analyzeStrategy(trades);

  // Persist to state for trend analysis
  persistAnalysis(analysis);

  // Format report
  const line = "\u2500".repeat(56);
  const dline = "\u2550".repeat(56);

  const pad = (label, value, width = 54) => {
    const valStr = String(value);
    const gap = width - label.length - valStr.length;
    return `  ${label}${" ".repeat(Math.max(1, gap))}${valStr}`;
  };

  const bps = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + " bps";
  const usd = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const lines = [
    "",
    `  ${dline}`,
    `  TRANSACTION COST ANALYSIS`,
    `  ${dline}`,
    "",
    pad("Total Trades", analysis.tradeCount),
    pad("Total Notional", usd(analysis.totalNotional)),
    pad("Total Execution Cost", usd(analysis.totalCostDollars)),
    pad("Total Cost (bps)", bps(analysis.totalCostBps)),
    pad("Avg Cost per Trade", usd(analysis.avgCostPerTradeDollars)),
    pad("Avg Cost per Trade (bps)", bps(analysis.avgCostPerTradeBps)),
    "",
    `  ${line}`,
    `  SLIPPAGE ANALYSIS`,
    `  ${line}`,
    "",
    pad("Total Slippage", usd(analysis.slippage.totalDollars)),
    pad("Avg Slippage", bps(analysis.slippage.avgBps)),
    pad("Median Slippage", bps(analysis.slippage.medianBps)),
    pad("Slippage StdDev", analysis.slippage.stdBps.toFixed(2) + " bps"),
    pad("95th Percentile", bps(analysis.slippage.p95Bps)),
    "",
    `  ${line}`,
    `  MARKET IMPACT`,
    `  ${line}`,
    "",
    pad("Total Impact", usd(analysis.marketImpact.totalDollars)),
    pad("Avg Impact", bps(analysis.marketImpact.avgBps)),
    "",
    `  ${line}`,
    `  TIMING COST`,
    `  ${line}`,
    "",
    pad("Total Timing Cost", usd(analysis.timingCost.totalDollars)),
    pad("Avg Timing Cost", bps(analysis.timingCost.avgBps)),
    "",
    `  ${line}`,
    `  COMMISSION`,
    `  ${line}`,
    "",
    pad("Total Commission", usd(analysis.commission.totalDollars)),
    pad("Avg Commission", bps(analysis.commission.avgBps)),
    "",
    `  ${line}`,
    `  COST ATTRIBUTION`,
    `  ${line}`,
    "",
  ];

  // Cost attribution breakdown
  const totalComponents = Math.abs(analysis.slippage.totalDollars)
    + Math.abs(analysis.marketImpact.totalDollars)
    + Math.abs(analysis.commission.totalDollars);

  if (totalComponents > 0) {
    const slipPct = (Math.abs(analysis.slippage.totalDollars) / totalComponents * 100).toFixed(1);
    const impactPct = (Math.abs(analysis.marketImpact.totalDollars) / totalComponents * 100).toFixed(1);
    const commPct = (Math.abs(analysis.commission.totalDollars) / totalComponents * 100).toFixed(1);

    lines.push(pad("Slippage", `${slipPct}%`));
    lines.push(pad("Market Impact", `${impactPct}%`));
    lines.push(pad("Commission", `${commPct}%`));
  } else {
    lines.push("  No cost components to attribute.");
  }

  if (analysis.costAsPercentOfReturns > 0) {
    lines.push("");
    lines.push(pad("Cost as % of Returns", analysis.costAsPercentOfReturns.toFixed(2) + "%"));
  }

  lines.push("");
  lines.push(`  ${dline}`);
  lines.push("");

  return lines.join("\n");
}

// ─── State Persistence ────────────────────────────────────

/**
 * Load persisted TCA state from disk.
 */
function loadState() {
  return safeReadJSON(TCA_STATE_PATH, { history: [], lastUpdated: null });
}

/**
 * Save TCA state to disk.
 */
function saveState(state) {
  safeWriteJSON(TCA_STATE_PATH, state);
}

/**
 * Persist a strategy analysis snapshot to state for trend analysis.
 */
function persistAnalysis(analysis) {
  const state = loadState();
  const snapshot = {
    timestamp: new Date().toISOString(),
    tradeCount: analysis.tradeCount,
    totalNotional: analysis.totalNotional,
    totalCostDollars: analysis.totalCostDollars,
    totalCostBps: analysis.totalCostBps,
    avgCostPerTradeBps: analysis.avgCostPerTradeBps,
    slippage: analysis.slippage,
    marketImpact: analysis.marketImpact,
    timingCost: analysis.timingCost,
    commission: analysis.commission,
  };

  state.history.push(snapshot);

  // Keep last 200 snapshots to bound storage
  if (state.history.length > 200) {
    state.history = state.history.slice(-200);
  }

  state.lastUpdated = snapshot.timestamp;
  saveState(state);
}

// ─── Exports ──────────────────────────────────────────────

export {
  analyzeTrade,
  analyzeStrategy,
  compareStrategies,
  getImplementationShortfall,
  getCostBreakdown,
  getTCAReport,
  // Internals exposed for testing
  toBps,
  loadState,
  saveState,
};

// ─── CLI Demo ─────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, "/").includes("tca");
if (isMain) {
  // Generate sample trades to demonstrate TCA output
  const sampleTrades = [
    {
      symbol: "SPY", side: "BUY", qty: 100, filledPrice: 450.25,
      arrivalPrice: 450.00, marketPriceAtFill: 450.10,
      commission: 2.25, benchmarkClose: 451.00, filledAt: "2025-03-01",
    },
    {
      symbol: "SPY", side: "SELL", qty: 100, filledPrice: 452.80,
      arrivalPrice: 453.00, marketPriceAtFill: 452.90,
      commission: 2.26, benchmarkClose: 452.50, filledAt: "2025-03-05",
    },
    {
      symbol: "QQQ", side: "BUY", qty: 200, filledPrice: 380.50,
      arrivalPrice: 380.00, marketPriceAtFill: 380.20,
      commission: 3.81, benchmarkClose: 381.00, filledAt: "2025-03-02",
    },
    {
      symbol: "QQQ", side: "SELL", qty: 200, filledPrice: 383.10,
      arrivalPrice: 383.50, marketPriceAtFill: 383.30,
      commission: 3.83, benchmarkClose: 383.00, filledAt: "2025-03-06",
    },
    {
      symbol: "AAPL", side: "BUY", qty: 50, filledPrice: 175.30,
      arrivalPrice: 175.00, marketPriceAtFill: 175.15,
      commission: 0.88, benchmarkClose: 176.00, filledAt: "2025-03-03",
    },
    {
      symbol: "AAPL", side: "SELL", qty: 50, filledPrice: 177.80,
      arrivalPrice: 178.00, marketPriceAtFill: 177.90,
      commission: 0.89, benchmarkClose: 177.50, filledAt: "2025-03-07",
    },
  ];

  console.log(getTCAReport(sampleTrades));

  // Demonstrate strategy comparison
  console.log("\n  Strategy Comparison:");
  console.log("  " + "\u2500".repeat(56));
  const comparison = compareStrategies({
    momentum: sampleTrades.slice(0, 4),
    meanReversion: sampleTrades.slice(2, 6),
  });
  for (const s of comparison) {
    console.log(`  #${s.rank} ${s.strategyId}: ${s.totalCostBps.toFixed(2)} bps total cost ` +
      `(${s.tradeCount} trades, slippage=${s.avgSlippageBps.toFixed(2)} bps)`);
  }

  // Demonstrate IS decomposition
  console.log("\n  Implementation Shortfall:");
  console.log("  " + "\u2500".repeat(56));
  const is = getImplementationShortfall(
    {
      grossReturn: 5000,
      trades: [
        { side: "BUY", qty: 100, decisionPrice: 450.00, orderPrice: 450.10,
          filledPrice: 450.25, filledQty: 100, benchmarkClose: 451.00 },
        { side: "BUY", qty: 200, decisionPrice: 380.00, orderPrice: 380.15,
          filledPrice: 380.50, filledQty: 150, benchmarkClose: 381.00 },
      ],
    },
    { grossReturn: 4800, totalCommission: 12.50 }
  );
  console.log(`  Total IS: $${is.totalIS}`);
  console.log(`  Delay:       $${is.components.delay} (${is.componentPct.delay.toFixed(1)}%)`);
  console.log(`  Trading:     $${is.components.trading} (${is.componentPct.trading.toFixed(1)}%)`);
  console.log(`  Opportunity: $${is.components.opportunity} (${is.componentPct.opportunity.toFixed(1)}%)`);

  // Cost breakdown from persisted state
  console.log("\n  Cost Breakdown (from state):");
  console.log("  " + "\u2500".repeat(56));
  const breakdown = getCostBreakdown();
  if (breakdown.current) {
    console.log(`  Commission:    ${breakdown.current.commission.pctOfTotal.toFixed(1)}% of cost`);
    console.log(`  Slippage:      ${breakdown.current.slippage.pctOfTotal.toFixed(1)}% of cost`);
    console.log(`  Market Impact: ${breakdown.current.marketImpact.pctOfTotal.toFixed(1)}% of cost`);
  }

  console.log("");
}
