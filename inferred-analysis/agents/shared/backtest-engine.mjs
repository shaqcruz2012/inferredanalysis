/**
 * Shared Backtest Engine — Inferred Analysis
 *
 * Unified backtest runner and metrics computation used by:
 *   - agents/backtests/template.js
 *   - agents/ensemble/run-ensemble.mjs
 *   - agents/strategies/*.js / *.mjs
 *
 * Exports:
 *   runBacktest(signals, config)       — portfolio simulation with transaction costs
 *   computeMetrics(equityCurve, returns, trades, config) — Sharpe, Sortino, Calmar, etc.
 *   computeDrawdown(equityCurve)       — peak-to-trough drawdown series
 *   generateSamplePrices(startDate, endDate, initialPrice) — random-walk price generator
 */

// ─── Default Configuration ───────────────────────────────

const DEFAULT_CONFIG = {
  initialCapital: 1_000_000,
  transactionCostBps: 10,
  slippageBps: 5,
  positionSize: 0.10,
};

// ─── Drawdown Calculation ────────────────────────────────

/**
 * Compute drawdown series from an equity curve.
 *
 * @param {Array<{date: string, equity: number}>} equityCurve
 * @returns {{ maxDrawdown: number, drawdownSeries: Array<{date: string, drawdown: number}> }}
 */
export function computeDrawdown(equityCurve) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return { maxDrawdown: 0, drawdownSeries: [] };
  }

  let peakEquity = -Infinity;
  let maxDrawdown = 0;
  const drawdownSeries = [];

  for (const point of equityCurve) {
    const equity = point.equity;
    if (!Number.isFinite(equity)) continue;

    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    drawdownSeries.push({ date: point.date, drawdown });
  }

  return { maxDrawdown, drawdownSeries };
}

// ─── Metrics Computation ─────────────────────────────────

/**
 * Compute standard performance metrics from backtest results.
 *
 * @param {number} finalCapital       — ending portfolio value
 * @param {number[]} dailyReturns     — array of daily return fractions
 * @param {number} maxDrawdown        — maximum peak-to-trough drawdown (fraction)
 * @param {number} trades             — total number of trades executed
 * @param {Array<{date: string, equity: number}>} equityCurve
 * @param {object} config             — must include initialCapital
 * @returns {object|null}             — metrics object or null if no data
 */
export function computeMetrics(finalCapital, dailyReturns, maxDrawdown, trades, equityCurve, config = DEFAULT_CONFIG) {
  if (!Array.isArray(dailyReturns)) return null;

  // Filter out any NaN/Infinity values
  const cleanReturns = dailyReturns.filter(r => Number.isFinite(r));
  const n = cleanReturns.length;
  if (n === 0) return null;

  const initialCapital = config.initialCapital || DEFAULT_CONFIG.initialCapital;
  const totalReturn = (finalCapital - initialCapital) / initialCapital;
  const annualizedReturn = Math.pow(1 + totalReturn, 252 / n) - 1;

  // Sharpe ratio (annualized)
  const meanReturn = cleanReturns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1
    ? cleanReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (n - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  // Sortino ratio (downside deviation only)
  const downsideReturns = cleanReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + r ** 2, 0) / downsideReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (meanReturn / downsideDev) * Math.sqrt(252) : 0;

  // Calmar ratio
  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  // Win rate
  const wins = cleanReturns.filter(r => r > 0).length;
  const winRate = n > 0 ? wins / n : 0;

  return {
    total_return: totalReturn,
    annualized_return: annualizedReturn,
    sharpe,
    sortino,
    calmar,
    max_drawdown: maxDrawdown,
    win_rate: winRate,
    trades,
    days: n,
    final_capital: finalCapital,
  };
}

// ─── Backtest Runner ─────────────────────────────────────

/**
 * Run a portfolio backtest on trading signals.
 *
 * @param {Array<{date: string, signal: number, price: number, confidence?: number}>} signals
 *   signal: -1 (short), 0 (flat), 1 (long)
 *   confidence: optional 0-1 multiplier for position sizing
 * @param {object} [config] — backtest parameters (initialCapital, transactionCostBps, slippageBps, positionSize)
 * @returns {object|null} — metrics object or null if no valid signals
 */
export function runBacktest(signals, config = DEFAULT_CONFIG) {
  // Edge case: empty or invalid input
  if (!Array.isArray(signals) || signals.length === 0) return null;

  // Merge with defaults so callers can pass partial config
  const cfg = { ...DEFAULT_CONFIG, ...config };

  let capital = cfg.initialCapital;
  let position = 0;
  let trades = 0;
  const equityCurve = [];
  let peakEquity = capital;
  let maxDrawdown = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    // Guard against NaN/undefined prices
    if (!Number.isFinite(sig.price) || sig.price <= 0) continue;

    const targetPosition = sig.signal;
    const currentPosition = position > 0 ? 1 : position < 0 ? -1 : 0;

    if (targetPosition !== currentPosition) {
      // Close existing position
      if (position !== 0) {
        const proceeds = position * sig.price;
        const costBps = (cfg.transactionCostBps + cfg.slippageBps) / 10000;
        const cost = Math.abs(proceeds) * costBps;
        capital += proceeds - cost;
        position = 0;
        trades++;
      }

      // Open new position
      if (targetPosition !== 0) {
        const sizeMultiplier = (sig.confidence !== undefined && Number.isFinite(sig.confidence))
          ? sig.confidence
          : 1.0;
        const tradeCapital = capital * cfg.positionSize * sizeMultiplier;
        const costBps = (cfg.transactionCostBps + cfg.slippageBps) / 10000;
        const cost = tradeCapital * costBps;
        position = (targetPosition * (tradeCapital - cost)) / sig.price;
        capital -= tradeCapital;
        trades++;
      }
    }

    // Mark to market
    const equity = capital + position * sig.price;
    equityCurve.push({ date: sig.date, equity });

    // Track daily returns
    const dailyReturn = prevEquity !== 0 ? (equity - prevEquity) / prevEquity : 0;
    dailyReturns.push(dailyReturn);
    prevEquity = equity;

    // Track drawdown
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Close final position at last price
  if (position !== 0 && signals.length > 0) {
    const lastPrice = signals[signals.length - 1].price;
    if (Number.isFinite(lastPrice) && lastPrice > 0) {
      capital += position * lastPrice;
    }
    position = 0;
  }

  return computeMetrics(capital, dailyReturns, maxDrawdown, trades, equityCurve, cfg);
}

// ─── Sample Price Generator ──────────────────────────────

/**
 * Generate synthetic price data using a random walk with slight upward drift.
 * Useful for testing when real data is unavailable.
 *
 * @param {string} startDate — ISO date string (e.g., "2020-01-01")
 * @param {string} endDate   — ISO date string (e.g., "2024-12-31")
 * @param {number} [initialPrice=100] — starting price
 * @returns {Array<{date: string, open: number, high: number, low: number, close: number, volume: number}>}
 */
export function generateSamplePrices(startDate, endDate, initialPrice = 100) {
  if (!startDate || !endDate) return [];

  const prices = [];
  let price = initialPrice;
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends

    // Random walk with slight upward drift (equity-like)
    const dailyReturn = (Math.random() - 0.48) * 0.02;
    price *= (1 + dailyReturn);

    prices.push({
      date: d.toISOString().split("T")[0],
      open: price * (1 + (Math.random() - 0.5) * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: Math.floor(Math.random() * 1_000_000) + 100_000,
    });
  }

  return prices;
}
