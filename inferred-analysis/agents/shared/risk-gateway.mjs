#!/usr/bin/env node
/**
 * Risk Gateway — Unified Risk Decision Layer
 *
 * Aggregates signals from all risk modules into a single enforcement point
 * that trading systems must consult before executing. This is the missing
 * link: risk-monitor.mjs computes Greeks/stress/correlation, but nothing
 * previously gated actual order flow. Now it does.
 *
 * Exported API:
 *   assessTradeRisk(trade, portfolioState)  — gate individual trades
 *   getPortfolioRiskScore()                 — 0-100 composite risk score
 *   getRiskLimits()                         — current active limits
 *
 * Usage (import):
 *   import { assessTradeRisk, getPortfolioRiskScore, getRiskLimits } from '../shared/risk-gateway.mjs'
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { checkPortfolioRisk, computeCorrelationMatrix, computeGreeksEquivalent } from "../risk/risk-monitor.mjs";
import { DrawdownAnalyzer, painIndex, ulcerIndex } from "../risk/drawdown-analyzer.mjs";
import { componentVaR, concentrationRisk, diversificationRatio } from "../risk/risk-attribution.mjs";
import { shouldTrade, getBreakerStatus } from "../risk/circuit-breaker.mjs";
import { kellySize, volTargetSize, maxDrawdownSize } from "../risk/position-sizer.mjs";
import { TailHedger, getHedgeRecommendation } from "../risk/tail-hedger.mjs";
import { BayesianRiskModel, bayesianSharpe } from "../risk/bayesian-risk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────

const RISK_CONFIG = {
  // Position-level limits
  maxPositionPctOfPortfolio: 0.25,  // 25% max single position
  maxPositionLossPct: 0.02,         // 2% max loss per position
  varLimitPct: 0.05,                // 5% portfolio VaR limit (95% confidence)

  // Portfolio-level limits
  maxGrossExposure: 1.0,            // 100% — no leverage
  maxNetExposure: 0.80,             // 80% max net directional
  drawdownHaltPct: 0.10,            // 10% drawdown halts new entries
  drawdownReducePct: 0.05,          // 5% drawdown triggers size reduction
  maxCorrelation: 0.80,             // correlation above this triggers warning
  minDiversificationRatio: 1.05,    // below this means poor diversification

  // Auto-scaling thresholds (risk score → position scale)
  riskScaleThresholds: [
    { score: 80, scale: 0.25 },     // extreme risk: 25% of normal size
    { score: 60, scale: 0.50 },     // high risk: 50%
    { score: 40, scale: 0.75 },     // elevated: 75%
    { score: 20, scale: 1.00 },     // normal: full size
  ],

  // VaR computation
  varConfidence: 0.95,
  varHorizon: 1,

  // ─── Opt-in module flags ───────────────────────────────
  // Enable tail-hedger: triggers hedge recommendations when drawdown exceeds threshold
  enableTailHedger: false,
  tailHedgeDrawdownThreshold: 0.03, // 3% portfolio drawdown triggers tail hedge evaluation

  // Enable bayesian-risk: uses Bayesian posterior for confidence-weighted position sizing
  enableBayesianRisk: false,
  bayesianPriorSharpe: 0.4,       // skeptical prior for Sharpe (shrinkage toward 0.4)
  bayesianPriorWeight: 0.3,       // weight given to prior vs sample
};

// ─── Internal State Cache ─────────────────────────────────

let _cachedRiskState = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // refresh risk state every 30s

/**
 * Refresh the internal risk state from all risk modules.
 * Cached to avoid redundant computation within the TTL window.
 */
function refreshRiskState(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedRiskState && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cachedRiskState;
  }

  const portfolioRisk = checkPortfolioRisk();
  const breakerStatus = safeGetBreakerStatus();

  // Extract key data from portfolio risk check
  const { alerts, metrics, profiles } = portfolioRisk;

  const criticalAlerts = alerts.filter(a => a.level === "critical");
  const warningAlerts = alerts.filter(a => a.level === "warning");

  // Compute drawdown metrics from available profiles
  const drawdownMetrics = computeDrawdownMetrics(profiles);

  // Compute concentration from profiles if we have return series
  const concentrationMetrics = computeConcentrationMetrics(profiles);

  // ─── Tail Hedger integration (opt-in) ──────────────────
  let tailHedgeRecommendation = null;
  if (RISK_CONFIG.enableTailHedger) {
    tailHedgeRecommendation = computeTailHedgeIfNeeded(profiles, drawdownMetrics);
  }

  // ─── Bayesian Risk integration (opt-in) ───────────────
  let bayesianRiskAssessment = null;
  if (RISK_CONFIG.enableBayesianRisk) {
    bayesianRiskAssessment = computeBayesianRiskAssessment(profiles);
  }

  _cachedRiskState = {
    timestamp: now,
    portfolioRisk,
    breakerStatus,
    criticalAlerts,
    warningAlerts,
    metrics,
    profiles,
    drawdownMetrics,
    concentrationMetrics,
    tailHedgeRecommendation,
    bayesianRiskAssessment,
  };
  _cacheTimestamp = now;

  return _cachedRiskState;
}

function safeGetBreakerStatus() {
  try {
    return getBreakerStatus();
  } catch {
    return { breakers: {}, trippedCount: 0, allClear: true };
  }
}

/**
 * Compute aggregate drawdown metrics from strategy profiles.
 */
function computeDrawdownMetrics(profiles) {
  const names = Object.keys(profiles);
  if (names.length === 0) {
    return { maxDrawdown: 0, avgDrawdown: 0, painIdx: 0, ulcerIdx: 0, currentDrawdown: 0 };
  }

  const drawdowns = names.map(n => profiles[n].maxDrawdown || 0);
  const maxDD = Math.max(...drawdowns);
  const avgDD = drawdowns.reduce((s, d) => s + d, 0) / drawdowns.length;

  // Compute pain/ulcer from first available return series
  let painIdx = 0;
  let ulcerIdx = 0;
  for (const name of names) {
    const returns = profiles[name].returnSeries;
    if (returns && returns.length > 3) {
      painIdx = Math.max(painIdx, painIndex(returns));
      ulcerIdx = Math.max(ulcerIdx, ulcerIndex(returns));
    }
  }

  // Estimate current drawdown from recent returns
  let currentDD = 0;
  for (const name of names) {
    const p = profiles[name];
    if (p.recentMeanReturn < 0) {
      currentDD += Math.abs(p.recentMeanReturn) / names.length;
    }
  }

  return { maxDrawdown: maxDD, avgDrawdown: avgDD, painIdx, ulcerIdx, currentDrawdown: currentDD };
}

/**
 * Compute concentration metrics from strategy profiles.
 */
function computeConcentrationMetrics(profiles) {
  const names = Object.keys(profiles);
  if (names.length === 0) {
    return { hhi: 1, normalizedHHI: 0, effectiveN: 0, diversificationRatio: 1 };
  }

  // Equal weights by default
  const n = names.length;
  const weights = names.map(() => 1 / n);

  // Build return series for covariance computation
  const returnSeries = names.map(name => profiles[name].returnSeries || []);
  const hasData = returnSeries.every(s => s.length >= 3);

  if (!hasData) {
    return { hhi: 1 / n, normalizedHHI: 0, effectiveN: n, diversificationRatio: 1 };
  }

  try {
    const concRisk = concentrationRisk(weights, computeCovMatrix(returnSeries));
    const divRatio = diversificationRatio(weights, computeCovMatrix(returnSeries));
    return {
      hhi: concRisk.hhi,
      normalizedHHI: concRisk.normalizedHHI,
      effectiveN: concRisk.effectiveN,
      diversificationRatio: divRatio.ratio,
    };
  } catch {
    return { hhi: 1 / n, normalizedHHI: 0, effectiveN: n, diversificationRatio: 1 };
  }
}

/**
 * Minimal covariance matrix computation from return series arrays.
 */
function computeCovMatrix(returnSeries) {
  const n = returnSeries.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  const minLen = Math.min(...returnSeries.map(s => s.length));
  if (minLen < 2) return matrix;

  const trimmed = returnSeries.map(s => s.slice(-minLen));
  const means = trimmed.map(s => s.reduce((a, b) => a + b, 0) / s.length);

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let cov = 0;
      for (let k = 0; k < minLen; k++) {
        cov += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      cov /= (minLen - 1);
      matrix[i][j] = cov;
      matrix[j][i] = cov;
    }
  }
  return matrix;
}

// ─── Tail Hedger Integration ──────────────────────────────

/**
 * Compute tail hedge recommendation when portfolio drawdown exceeds the
 * configured threshold. Only runs when enableTailHedger is true.
 *
 * @param {Object} profiles - Strategy profiles from risk-monitor
 * @param {Object} drawdownMetrics - Computed drawdown metrics
 * @returns {Object|null} Hedge recommendation or null if not triggered
 */
function computeTailHedgeIfNeeded(profiles, drawdownMetrics) {
  const currentDD = drawdownMetrics.currentDrawdown || 0;
  const maxDD = drawdownMetrics.maxDrawdown || 0;
  const effectiveDD = Math.max(currentDD, maxDD);

  // Only compute tail hedge when drawdown exceeds threshold
  if (effectiveDD < RISK_CONFIG.tailHedgeDrawdownThreshold) {
    return { triggered: false, drawdown: effectiveDD, threshold: RISK_CONFIG.tailHedgeDrawdownThreshold };
  }

  // Aggregate return series across all strategy profiles
  const names = Object.keys(profiles);
  const allReturns = [];
  const allPrices = [];
  let latestPrice = 100; // fallback

  for (const name of names) {
    const p = profiles[name];
    if (p.returnSeries && p.returnSeries.length > 0) {
      allReturns.push(...p.returnSeries);
    }
  }

  if (allReturns.length < 10) {
    return { triggered: true, drawdown: effectiveDD, error: "Insufficient return data for tail hedge analysis" };
  }

  try {
    const recommendation = getHedgeRecommendation({
      returns: allReturns,
      prices: null,
      spotPrice: latestPrice,
      portfolioValue: 1_000_000, // normalized; actual sizing is done per-trade
    });

    return {
      triggered: true,
      drawdown: effectiveDD,
      threshold: RISK_CONFIG.tailHedgeDrawdownThreshold,
      regime: recommendation.summary.regime,
      riskLevel: recommendation.summary.riskLevel,
      hedgeRatio: recommendation.summary.hedgeRatio,
      recommendedOTM: recommendation.summary.recommendedOTM,
      estimatedCostPct: recommendation.summary.costAsPercentOfPortfolio,
      hedgeEfficiency: recommendation.efficiency.verdict,
      adjustmentReasons: recommendation.hedgeRatio.reasons,
    };
  } catch (err) {
    return { triggered: true, drawdown: effectiveDD, error: `Tail hedge computation failed: ${err.message}` };
  }
}

// ─── Bayesian Risk Integration ────────────────────────────

/**
 * Compute Bayesian risk assessment from strategy profiles.
 * Provides posterior-weighted confidence in position sizing and
 * regime probabilities from the Bayesian model.
 *
 * @param {Object} profiles - Strategy profiles from risk-monitor
 * @returns {Object|null} Bayesian risk assessment
 */
function computeBayesianRiskAssessment(profiles) {
  const names = Object.keys(profiles);
  if (names.length === 0) return null;

  // Build asset returns map from strategy profiles
  const assetReturns = {};
  let hasData = false;

  for (const name of names) {
    const p = profiles[name];
    if (p.returnSeries && p.returnSeries.length >= 10) {
      assetReturns[name] = [...p.returnSeries];
      hasData = true;
    }
  }

  if (!hasData) return null;

  try {
    const model = new BayesianRiskModel(assetReturns);
    model.fitPriors(252); // 1-year lookback for prior estimation

    const regimeProbs = model.regimeProbabilities();
    const predictive = model.predictiveDistribution();
    const marginalContribs = model.getMarginalContributions();

    // Compute Bayesian Sharpe for each strategy
    const bayesianSharpes = {};
    for (const name of Object.keys(assetReturns)) {
      bayesianSharpes[name] = bayesianSharpe(
        assetReturns[name],
        RISK_CONFIG.bayesianPriorSharpe,
        RISK_CONFIG.bayesianPriorWeight,
      );
    }

    // Compute confidence-weighted position scale factor:
    // If Bayesian Sharpe credible interval includes zero, reduce confidence
    // If crisis regime probability is high, reduce further
    let bayesianScaleFactor = 1.0;
    const crisisProb = regimeProbs.crisis || 0;
    const bearProb = regimeProbs.bear || 0;

    // Regime-based scaling: reduce position size under adverse regimes
    if (crisisProb > 0.3) {
      bayesianScaleFactor *= (1 - crisisProb * 0.6); // crisis = heavy reduction
    }
    if (bearProb > 0.5) {
      bayesianScaleFactor *= (1 - (bearProb - 0.5) * 0.4);
    }

    // Sharpe credible interval check: if avg lower bound < 0, reduce confidence
    const sharpeValues = Object.values(bayesianSharpes);
    if (sharpeValues.length > 0) {
      const avgLowerCI = sharpeValues.reduce((s, bs) => s + bs.credibleInterval[0], 0) / sharpeValues.length;
      if (avgLowerCI < 0) {
        bayesianScaleFactor *= Math.max(0.3, 1 + avgLowerCI * 0.5); // negative CI = less confidence
      }
    }

    bayesianScaleFactor = Math.max(0.1, Math.min(1.0, bayesianScaleFactor));

    return {
      regimeProbabilities: regimeProbs,
      dominantRegime: Object.entries(regimeProbs).reduce((a, b) => a[1] > b[1] ? a : b)[0],
      predictive,
      marginalContributions: marginalContribs,
      bayesianSharpes,
      scaleFactor: round4(bayesianScaleFactor),
    };
  } catch (err) {
    return { error: `Bayesian risk computation failed: ${err.message}` };
  }
}

// ─── Exported: assessTradeRisk ────────────────────────────

/**
 * Gate an individual trade through the risk framework.
 *
 * @param {Object} trade - Proposed trade
 * @param {string} trade.symbol - Ticker symbol
 * @param {string} trade.side - "buy" or "sell"
 * @param {number} trade.qty - Number of shares/units
 * @param {number} trade.price - Estimated execution price
 * @param {string} trade.agent - Agent/strategy name placing the trade
 * @param {number} [trade.positionSize] - Fraction of capital (0-1)
 *
 * @param {Object} portfolioState - Current portfolio snapshot
 * @param {number} portfolioState.equity - Total portfolio equity
 * @param {number} portfolioState.cash - Available cash
 * @param {Array}  portfolioState.positions - Current open positions [{symbol, qty, value, unrealizedPnl}]
 * @param {number} [portfolioState.dailyPnl] - Today's realized + unrealized P&L
 *
 * @returns {{ allowed: boolean, reason: string, adjustedSize: number, riskScore: number, checks: Object }}
 */
export function assessTradeRisk(trade, portfolioState) {
  const state = refreshRiskState();
  const checks = {};
  const reasons = [];
  let adjustedSize = trade.qty;

  // ── Check 1: Circuit breakers ──────────────────────────
  const agentBreaker = safeCheckBreaker(trade.agent);
  checks.circuitBreaker = agentBreaker;
  if (!agentBreaker.allowed) {
    return {
      allowed: false,
      reason: `Circuit breaker tripped: ${agentBreaker.reason}`,
      adjustedSize: 0,
      riskScore: 100,
      checks,
    };
  }

  // ── Check 2: Portfolio-level drawdown gate ─────────────
  const drawdown = state.drawdownMetrics.maxDrawdown;
  const currentDD = state.drawdownMetrics.currentDrawdown;
  checks.drawdown = { maxDrawdown: drawdown, currentDrawdown: currentDD };

  if (drawdown >= RISK_CONFIG.drawdownHaltPct || currentDD >= RISK_CONFIG.drawdownHaltPct) {
    return {
      allowed: false,
      reason: `Drawdown halt: max=${(drawdown * 100).toFixed(1)}% current=${(currentDD * 100).toFixed(1)}% (limit ${(RISK_CONFIG.drawdownHaltPct * 100).toFixed(0)}%)`,
      adjustedSize: 0,
      riskScore: 95,
      checks,
    };
  }

  // ── Check 3: Critical risk alerts ──────────────────────
  checks.criticalAlerts = state.criticalAlerts.length;
  if (state.criticalAlerts.length > 0) {
    // Don't block, but reduce size significantly
    const alertScale = Math.max(0.25, 1 - state.criticalAlerts.length * 0.25);
    adjustedSize = Math.floor(adjustedSize * alertScale);
    reasons.push(`${state.criticalAlerts.length} critical alert(s) — size reduced to ${(alertScale * 100).toFixed(0)}%`);
  }

  // ── Check 4: Position concentration check ──────────────
  const equity = portfolioState.equity || 1;
  const tradeNotional = trade.price * adjustedSize;
  const positionPct = tradeNotional / equity;
  checks.concentration = { positionPct, limit: RISK_CONFIG.maxPositionPctOfPortfolio };

  if (positionPct > RISK_CONFIG.maxPositionPctOfPortfolio) {
    const maxQty = Math.floor((equity * RISK_CONFIG.maxPositionPctOfPortfolio) / trade.price);
    adjustedSize = Math.min(adjustedSize, maxQty);
    reasons.push(`Position concentration ${(positionPct * 100).toFixed(1)}% exceeds ${(RISK_CONFIG.maxPositionPctOfPortfolio * 100).toFixed(0)}% limit — capped at ${adjustedSize} units`);
  }

  // ── Check 5: Gross exposure check ──────────────────────
  const currentExposure = computeGrossExposure(portfolioState);
  const newExposure = currentExposure + (tradeNotional / equity);
  checks.grossExposure = { current: currentExposure, afterTrade: newExposure, limit: RISK_CONFIG.maxGrossExposure };

  if (newExposure > RISK_CONFIG.maxGrossExposure) {
    const availableExposure = Math.max(0, RISK_CONFIG.maxGrossExposure - currentExposure);
    const maxQty = Math.floor((availableExposure * equity) / trade.price);
    if (maxQty <= 0) {
      return {
        allowed: false,
        reason: `Gross exposure ${(newExposure * 100).toFixed(1)}% would exceed ${(RISK_CONFIG.maxGrossExposure * 100).toFixed(0)}% limit`,
        adjustedSize: 0,
        riskScore: getPortfolioRiskScore(),
        checks,
      };
    }
    adjustedSize = Math.min(adjustedSize, maxQty);
    reasons.push(`Gross exposure capped — reduced to ${adjustedSize} units`);
  }

  // ── Check 6: Per-position max loss check ───────────────
  // Estimate worst-case loss based on strategy's historical max drawdown
  const strategyProfile = state.profiles[trade.agent];
  if (strategyProfile) {
    const strategyDD = strategyProfile.maxDrawdown || 0.10;
    const estimatedLoss = (trade.price * adjustedSize * strategyDD) / equity;
    checks.positionMaxLoss = { estimatedLossPct: estimatedLoss, limit: RISK_CONFIG.maxPositionLossPct };

    if (estimatedLoss > RISK_CONFIG.maxPositionLossPct) {
      const safeSize = Math.floor((equity * RISK_CONFIG.maxPositionLossPct) / (trade.price * strategyDD));
      adjustedSize = Math.min(adjustedSize, Math.max(safeSize, 1));
      reasons.push(`Max loss limit: estimated ${(estimatedLoss * 100).toFixed(1)}% loss exceeds ${(RISK_CONFIG.maxPositionLossPct * 100).toFixed(0)}% limit`);
    }
  }

  // ── Check 7: Correlation check ─────────────────────────
  const correlationWarnings = state.warningAlerts.filter(a => a.type === "correlation");
  const agentCorrelated = correlationWarnings.some(
    a => a.pair && (a.pair[0] === trade.agent || a.pair[1] === trade.agent)
  );
  checks.correlation = { correlated: agentCorrelated, warnings: correlationWarnings.length };

  if (agentCorrelated) {
    adjustedSize = Math.floor(adjustedSize * 0.70);
    reasons.push(`Correlated with existing strategy — size reduced 30%`);
  }

  // ── Check 8: Auto-scale based on composite risk score ──
  const riskScore = getPortfolioRiskScore();
  const scaleEntry = RISK_CONFIG.riskScaleThresholds.find(t => riskScore >= t.score);
  const riskScale = scaleEntry ? scaleEntry.scale : 1.0;
  checks.riskScale = { riskScore, scale: riskScale };

  if (riskScale < 1.0) {
    adjustedSize = Math.max(1, Math.floor(adjustedSize * riskScale));
    reasons.push(`Risk score ${riskScore}/100 — position scaled to ${(riskScale * 100).toFixed(0)}%`);
  }

  // ── Check 9: Drawdown-based size reduction (soft) ──────
  if (drawdown >= RISK_CONFIG.drawdownReducePct && drawdown < RISK_CONFIG.drawdownHaltPct) {
    const ddScale = 1 - ((drawdown - RISK_CONFIG.drawdownReducePct) /
      (RISK_CONFIG.drawdownHaltPct - RISK_CONFIG.drawdownReducePct));
    const clampedScale = Math.max(0.30, Math.min(1.0, ddScale));
    adjustedSize = Math.max(1, Math.floor(adjustedSize * clampedScale));
    reasons.push(`Drawdown ${(drawdown * 100).toFixed(1)}% in reduction zone — scale ${(clampedScale * 100).toFixed(0)}%`);
  }

  // ── Check 10: Tail hedge size reduction (opt-in) ───────
  if (RISK_CONFIG.enableTailHedger && state.tailHedgeRecommendation?.triggered) {
    const th = state.tailHedgeRecommendation;
    checks.tailHedge = th;
    // When tail hedge is triggered, scale position size down proportional to
    // the recommended hedge ratio — the idea is that if you'd hedge X% of
    // portfolio, you should also reduce new entries by that amount.
    const tailScale = Math.max(0.20, 1.0 - (th.hedgeRatio || 0));
    adjustedSize = Math.max(1, Math.floor(adjustedSize * tailScale));
    reasons.push(`Tail hedge triggered (DD ${(th.drawdown * 100).toFixed(1)}%, regime=${th.regime || "?"}) — size reduced to ${(tailScale * 100).toFixed(0)}%`);
  }

  // ── Check 11: Bayesian confidence-weighted sizing (opt-in)
  if (RISK_CONFIG.enableBayesianRisk && state.bayesianRiskAssessment && !state.bayesianRiskAssessment.error) {
    const ba = state.bayesianRiskAssessment;
    checks.bayesianRisk = {
      dominantRegime: ba.dominantRegime,
      scaleFactor: ba.scaleFactor,
      regimeProbabilities: ba.regimeProbabilities,
    };

    if (ba.scaleFactor < 1.0) {
      adjustedSize = Math.max(1, Math.floor(adjustedSize * ba.scaleFactor));
      reasons.push(`Bayesian risk (regime=${ba.dominantRegime}, P(crisis)=${((ba.regimeProbabilities.crisis || 0) * 100).toFixed(0)}%) — size scaled to ${(ba.scaleFactor * 100).toFixed(0)}%`);
    }
  }

  // ── Final validation ───────────────────────────────────
  adjustedSize = Math.max(0, adjustedSize);
  const allowed = adjustedSize > 0;
  const reason = reasons.length > 0
    ? reasons.join("; ")
    : "All risk checks passed";

  return {
    allowed,
    reason,
    adjustedSize,
    riskScore,
    checks,
  };
}

/**
 * Check circuit breaker for an agent, with safe error handling.
 */
function safeCheckBreaker(agentRole) {
  try {
    const result = shouldTrade(agentRole);
    return { allowed: result.ok !== false, reason: result.reason || "" };
  } catch {
    // If circuit breaker module fails, allow trading with warning
    return { allowed: true, reason: "circuit breaker unavailable" };
  }
}

/**
 * Compute gross exposure as fraction of equity from current positions.
 */
function computeGrossExposure(portfolioState) {
  if (!portfolioState.positions || portfolioState.positions.length === 0) return 0;
  const equity = portfolioState.equity || 1;
  const totalExposure = portfolioState.positions.reduce((sum, pos) => {
    return sum + Math.abs(pos.value || (pos.qty * (pos.currentPrice || 0)));
  }, 0);
  return totalExposure / equity;
}

// ─── Exported: getPortfolioRiskScore ──────────────────────

/**
 * Compute a composite portfolio risk score from 0 (safe) to 100 (extreme risk).
 *
 * Components (weighted):
 *   - Drawdown severity:     25%
 *   - Volatility ratio:      20%
 *   - Correlation risk:      15%
 *   - Concentration risk:    15%
 *   - Alert severity:        15%
 *   - Circuit breaker state: 10%
 *
 * @returns {number} Risk score 0-100
 */
export function getPortfolioRiskScore() {
  const state = refreshRiskState();

  // Component 1: Drawdown severity (0-100)
  const ddScore = computeDrawdownScore(state);

  // Component 2: Volatility ratio (0-100)
  const volScore = computeVolatilityScore(state);

  // Component 3: Correlation risk (0-100)
  const corrScore = computeCorrelationScore(state);

  // Component 4: Concentration risk (0-100)
  const concScore = computeConcentrationScore(state);

  // Component 5: Alert severity (0-100)
  const alertScore = computeAlertScore(state);

  // Component 6: Circuit breaker state (0-100)
  const breakerScore = computeBreakerScore(state);

  // Weighted composite
  const composite = Math.round(
    ddScore * 0.25 +
    volScore * 0.20 +
    corrScore * 0.15 +
    concScore * 0.15 +
    alertScore * 0.15 +
    breakerScore * 0.10
  );

  return Math.min(100, Math.max(0, composite));
}

function computeDrawdownScore(state) {
  const dd = state.drawdownMetrics.maxDrawdown;
  // 0% DD = 0 score, 10% DD = 50 score, 20%+ DD = 100 score
  return Math.min(100, (dd / 0.20) * 100);
}

function computeVolatilityScore(state) {
  const volRatio = state.metrics.volRatio || 0;
  // volRatio 1.0 = on target (score 30), 1.5+ = danger (score 100)
  if (volRatio <= 0.5) return 0;
  if (volRatio <= 1.0) return volRatio * 30;
  return Math.min(100, 30 + (volRatio - 1.0) * 140);
}

function computeCorrelationScore(state) {
  const corrWarnings = state.warningAlerts.filter(a => a.type === "correlation");
  // Each correlated pair adds 25 points
  return Math.min(100, corrWarnings.length * 25);
}

function computeConcentrationScore(state) {
  const normHHI = state.concentrationMetrics.normalizedHHI;
  // normalized HHI 0 = perfectly diversified (score 0), 1 = concentrated (score 100)
  return Math.min(100, normHHI * 100);
}

function computeAlertScore(state) {
  const criticals = state.criticalAlerts.length;
  const warnings = state.warningAlerts.length;
  // Each critical = 30 pts, each warning = 10 pts
  return Math.min(100, criticals * 30 + warnings * 10);
}

function computeBreakerScore(state) {
  const status = state.breakerStatus;
  if (!status) return 0;
  // If any breakers are tripped, that's serious
  const tripped = status.trippedCount || 0;
  if (tripped === 0) return 0;
  return Math.min(100, tripped * 40);
}

// ─── Exported: getRiskLimits ──────────────────────────────

/**
 * Return the current active risk limits, dynamically adjusted based on
 * market conditions and portfolio state.
 *
 * @returns {Object} Active risk limits with current values and status
 */
export function getRiskLimits() {
  const state = refreshRiskState();
  const riskScore = getPortfolioRiskScore();

  // Dynamic limit tightening: as risk rises, limits become more conservative
  const tighteningFactor = riskScore > 50 ? (1 - (riskScore - 50) / 100) : 1.0;

  return {
    timestamp: new Date().toISOString(),
    riskScore,
    regime: riskScore >= 80 ? "EXTREME" : riskScore >= 60 ? "HIGH" : riskScore >= 40 ? "ELEVATED" : "NORMAL",

    positionLimits: {
      maxPositionPct: round4(RISK_CONFIG.maxPositionPctOfPortfolio * tighteningFactor),
      maxPositionLossPct: round4(RISK_CONFIG.maxPositionLossPct * tighteningFactor),
      positionScaleFactor: round4(
        (RISK_CONFIG.riskScaleThresholds.find(t => riskScore >= t.score) || { scale: 1.0 }).scale
      ),
    },

    portfolioLimits: {
      maxGrossExposure: round4(RISK_CONFIG.maxGrossExposure * tighteningFactor),
      maxNetExposure: round4(RISK_CONFIG.maxNetExposure * tighteningFactor),
      varLimitPct: RISK_CONFIG.varLimitPct,
      drawdownHaltPct: RISK_CONFIG.drawdownHaltPct,
      drawdownReducePct: RISK_CONFIG.drawdownReducePct,
    },

    currentState: {
      portfolioDrawdown: round4(state.drawdownMetrics.maxDrawdown),
      currentDrawdown: round4(state.drawdownMetrics.currentDrawdown),
      portfolioVol: round4(state.metrics.portfolioVol || 0),
      volRatio: round4(state.metrics.volRatio || 0),
      grossExposure: round4(state.metrics.grossExposure || 0),
      criticalAlerts: state.criticalAlerts.length,
      warningAlerts: state.warningAlerts.length,
      breakersTripped: state.breakerStatus?.trippedCount || 0,
    },

    greeks: state.metrics.greeks || { delta: 0, gamma: 0, theta: 0, vega: 0 },
    concentration: {
      hhi: round4(state.concentrationMetrics.hhi),
      effectivePositions: round4(state.concentrationMetrics.effectiveN),
      diversificationRatio: round4(state.concentrationMetrics.diversificationRatio),
    },

    // Opt-in module state (null when disabled)
    tailHedge: state.tailHedgeRecommendation || null,
    bayesianRisk: state.bayesianRiskAssessment
      ? {
          dominantRegime: state.bayesianRiskAssessment.dominantRegime,
          regimeProbabilities: state.bayesianRiskAssessment.regimeProbabilities,
          scaleFactor: state.bayesianRiskAssessment.scaleFactor,
        }
      : null,
  };
}

function round4(x) {
  if (typeof x !== "number" || !isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ─── Backtest Integration Helper ──────────────────────────

/**
 * Compute a risk-adjusted position size for use in backtesting.
 * Uses the current risk score to scale the requested position size.
 *
 * @param {number} requestedSize - Original position size (shares or fraction)
 * @param {Object} [strategyMetrics] - Optional strategy performance metrics
 * @param {number} [strategyMetrics.winRate] - Historical win rate (0-1)
 * @param {number} [strategyMetrics.avgWin] - Average winning return
 * @param {number} [strategyMetrics.avgLoss] - Average losing return (positive)
 * @param {number} [strategyMetrics.maxDrawdown] - Historical max drawdown
 * @param {number} [strategyMetrics.volatility] - Annualized volatility
 * @returns {{ adjustedSize: number, scaleFactor: number, method: string }}
 */
export function computeRiskAdjustedSize(requestedSize, strategyMetrics = {}) {
  const riskScore = getPortfolioRiskScore();

  // Base scale from risk score
  const scaleEntry = RISK_CONFIG.riskScaleThresholds.find(t => riskScore >= t.score);
  let scaleFactor = scaleEntry ? scaleEntry.scale : 1.0;
  let method = `risk_score(${riskScore})`;

  // If strategy metrics available, apply Kelly and drawdown constraints
  if (strategyMetrics.winRate && strategyMetrics.avgWin && strategyMetrics.avgLoss) {
    const kellyFrac = kellySize(strategyMetrics.winRate, strategyMetrics.avgWin, strategyMetrics.avgLoss, 0.5);
    if (kellyFrac > 0 && kellyFrac < scaleFactor) {
      scaleFactor = kellyFrac;
      method += `+kelly(${kellyFrac.toFixed(3)})`;
    }
  }

  // Apply vol targeting if volatility data available
  if (strategyMetrics.volatility && strategyMetrics.volatility > 0) {
    const volScale = volTargetSize(strategyMetrics.volatility, 0.10, 1.0);
    if (volScale < scaleFactor) {
      scaleFactor = volScale;
      method += `+vol_target(${volScale.toFixed(3)})`;
    }
  }

  // Apply max drawdown constraint
  if (strategyMetrics.maxDrawdown && strategyMetrics.maxDrawdown > 0) {
    const ddSize = maxDrawdownSize(strategyMetrics.maxDrawdown, RISK_CONFIG.maxPositionLossPct, 1.0);
    if (ddSize.fraction < scaleFactor) {
      scaleFactor = ddSize.fraction;
      method += `+dd_cap(${ddSize.fraction.toFixed(3)})`;
    }
  }

  return {
    adjustedSize: typeof requestedSize === "number" ? requestedSize * scaleFactor : requestedSize,
    scaleFactor: round4(scaleFactor),
    method,
  };
}

/**
 * Force a refresh of the cached risk state.
 * Useful after portfolio changes that should immediately update risk checks.
 */
export function invalidateRiskCache() {
  _cachedRiskState = null;
  _cacheTimestamp = 0;
}

/**
 * Configure opt-in risk modules at runtime.
 * Allows callers to enable tail-hedger, bayesian-risk, or both
 * without modifying source code.
 *
 * @param {Object} overrides - Config keys to override
 * @param {boolean} [overrides.enableTailHedger] - Enable tail hedge recommendations
 * @param {number}  [overrides.tailHedgeDrawdownThreshold] - Drawdown % that triggers tail hedge
 * @param {boolean} [overrides.enableBayesianRisk] - Enable Bayesian risk model
 * @param {number}  [overrides.bayesianPriorSharpe] - Prior Sharpe for Bayesian estimation
 * @param {number}  [overrides.bayesianPriorWeight] - Weight of prior vs sample (0-1)
 */
export function configureRiskModules(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (key in RISK_CONFIG) {
      RISK_CONFIG[key] = value;
    }
  }
  // Invalidate cache so next assessment uses new config
  invalidateRiskCache();
}
