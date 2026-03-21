#!/usr/bin/env node
/**
 * Diversification Optimizer — Inferred Analysis
 *
 * Actively optimizes portfolio construction for diversification by:
 * 1. Computing full pairwise correlation matrices
 * 2. Maximizing the diversification ratio (DR)
 * 3. Identifying redundant strategy pairs
 * 4. Tracking correlation stability via rolling windows
 * 5. Producing allocation recommendations that balance returns and diversification
 *
 * Usage:
 *   node agents/optimizer/diversification-optimizer.mjs
 *   import { computeCorrelationMatrix, optimizeForDiversification } from './diversification-optimizer.mjs'
 */

import {
  BOUNDS,
  normalizeWeights,
  applyPositionLimits,
  clampWeight,
} from "../shared/constraints.mjs";

import {
  covarianceMatrix,
  correlationMatrix as corrFromCov,
} from "./portfolio-optimizer.mjs";

// ─── Constants ──────────────────────────────────────────

const DEFAULT_CORRELATION_THRESHOLD = 0.7;
const DEFAULT_ROLLING_WINDOW = 63;       // ~3 months of trading days
const MAX_OPTIM_ITERATIONS = 2000;
const CONVERGENCE_TOL = 1e-8;
const PERTURBATION_SCALE = 0.02;
const ANNUALIZATION_FACTOR = 252;

// ─── Core: Pearson Correlation ──────────────────────────

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  const denom = Math.sqrt(sx * sy);
  return denom > 1e-15 ? cov / denom : 0;
}

// ─── Correlation Matrix ─────────────────────────────────

/**
 * Compute the full pairwise Pearson correlation matrix.
 *
 * @param {Object} strategyReturns - { strategyName: [dailyReturn, ...], ... }
 * @param {Object} [options]
 * @param {number} [options.window] - If set, use only the last `window` observations
 * @returns {{ matrix: number[][], names: string[], window: number|null }}
 */
export function computeCorrelationMatrix(strategyReturns, options = {}) {
  const { window = null } = options;
  const names = Object.keys(strategyReturns);
  const n = names.length;

  if (n < 2) {
    return { matrix: [[1]], names, window };
  }

  const series = names.map(name => {
    const r = strategyReturns[name];
    return window ? r.slice(-window) : r;
  });

  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const corr = pearson(series[i], series[j]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return { matrix, names, window };
}

// ─── Portfolio Volatility Helpers ───────────────────────

function getVolatilities(strategyReturns, names) {
  return names.map(name => {
    const r = strategyReturns[name];
    const n = r.length;
    if (n < 2) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / n;
    const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance);
  });
}

function portfolioVolatility(weights, covMatrix) {
  let variance = 0;
  const n = weights.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += weights[i] * weights[j] * covMatrix[i][j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

function buildCovFromCorrAndVol(corrMatrix, vols) {
  const n = vols.length;
  const cov = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      cov[i][j] = corrMatrix[i][j] * vols[i] * vols[j];
    }
  }
  return cov;
}

// ─── Diversification Ratio ──────────────────────────────

/**
 * Compute the Diversification Ratio (DR).
 *
 * DR = (weighted average of individual volatilities) / (portfolio volatility)
 *
 * DR >= 1 always. Higher DR means better diversification.
 * DR = 1 implies a single-asset portfolio or perfect positive correlation.
 *
 * @param {number[]} weights - Portfolio weights (must sum to ~1)
 * @param {number[][]} correlationMatrix - Pairwise correlation matrix
 * @param {number[]} volatilities - Individual strategy volatilities
 * @returns {{ ratio: number, weightedAvgVol: number, portfolioVol: number }}
 */
export function getDiversificationRatio(weights, correlationMatrix, volatilities) {
  const n = weights.length;
  if (n !== correlationMatrix.length || n !== volatilities.length) {
    throw new Error(`Dimension mismatch: weights(${n}), corr(${correlationMatrix.length}), vol(${volatilities.length})`);
  }

  // Weighted average individual volatility
  const weightedAvgVol = weights.reduce((s, w, i) => s + Math.abs(w) * volatilities[i], 0);

  // Portfolio volatility via correlation matrix
  const covMatrix = buildCovFromCorrAndVol(correlationMatrix, volatilities);
  const portVol = portfolioVolatility(weights, covMatrix);

  const ratio = portVol > 1e-15 ? weightedAvgVol / portVol : 1.0;

  return { ratio, weightedAvgVol, portfolioVol: portVol };
}

// ─── Diversification Optimizer ──────────────────────────

/**
 * Find weights that maximize the Diversification Ratio (DR).
 *
 * Uses projected gradient ascent with random restarts.
 * Long-only by default; set options.allowShort = true for long-short.
 *
 * @param {Object} strategyReturns - { name: [dailyReturns], ... }
 * @param {Object} [options]
 * @param {number} [options.maxIterations=2000]
 * @param {number} [options.learningRate=0.01]
 * @param {number} [options.restarts=5] - Number of random starting points
 * @param {boolean} [options.allowShort=false]
 * @param {number} [options.minWeight=0.02] - Minimum allocation per strategy
 * @param {number} [options.maxWeight] - Maximum allocation per strategy
 * @param {number} [options.window] - Rolling window for correlation estimation
 * @returns {{ weights: number[], diversificationRatio: number, names: string[], iterations: number }}
 */
export function optimizeForDiversification(strategyReturns, options = {}) {
  const {
    maxIterations = MAX_OPTIM_ITERATIONS,
    learningRate = 0.01,
    restarts = 5,
    allowShort = false,
    minWeight = 0.02,
    maxWeight = BOUNDS.maxSinglePosition,
    window = null,
  } = options;

  const names = Object.keys(strategyReturns);
  const n = names.length;

  if (n < 2) {
    return { weights: [1.0], diversificationRatio: 1.0, names, iterations: 0 };
  }

  const { matrix: corrMatrix } = computeCorrelationMatrix(strategyReturns, { window });
  const vols = getVolatilities(strategyReturns, names);
  const covMatrix = buildCovFromCorrAndVol(corrMatrix, vols);

  let bestWeights = new Array(n).fill(1 / n);
  let bestDR = getDiversificationRatio(bestWeights, corrMatrix, vols).ratio;
  let totalIter = 0;

  for (let restart = 0; restart < restarts; restart++) {
    // Initialize: random perturbation around equal-weight
    let w = new Array(n);
    if (restart === 0) {
      w.fill(1 / n);
    } else {
      for (let i = 0; i < n; i++) {
        w[i] = 1 / n + (Math.random() - 0.5) * PERTURBATION_SCALE;
      }
      w = projectWeights(w, allowShort, minWeight, maxWeight);
    }

    let prevDR = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      totalIter++;

      // Compute gradient of DR with respect to weights via finite differences
      const currentDR = getDiversificationRatio(w, corrMatrix, vols).ratio;

      if (Math.abs(currentDR - prevDR) < CONVERGENCE_TOL && iter > 10) {
        break;
      }
      prevDR = currentDR;

      const grad = new Array(n);
      const h = 1e-6;
      for (let i = 0; i < n; i++) {
        const wPlus = [...w];
        wPlus[i] += h;
        const drPlus = getDiversificationRatio(
          normalizeArray(wPlus), corrMatrix, vols
        ).ratio;
        grad[i] = (drPlus - currentDR) / h;
      }

      // Gradient ascent step
      for (let i = 0; i < n; i++) {
        w[i] += learningRate * grad[i];
      }

      // Project back onto feasible set
      w = projectWeights(w, allowShort, minWeight, maxWeight);
    }

    const finalDR = getDiversificationRatio(w, corrMatrix, vols).ratio;
    if (finalDR > bestDR) {
      bestDR = finalDR;
      bestWeights = [...w];
    }
  }

  // Apply shared position limits
  bestWeights = applyPositionLimits(bestWeights, maxWeight);
  bestWeights = normalizeWeights(bestWeights, {
    targetSum: 1.0,
    longOnly: !allowShort,
  });

  return {
    weights: bestWeights,
    diversificationRatio: getDiversificationRatio(bestWeights, corrMatrix, vols).ratio,
    names,
    iterations: totalIter,
  };
}

function normalizeArray(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum > 1e-15 ? arr.map(x => x / sum) : arr.map(() => 1 / arr.length);
}

function projectWeights(w, allowShort, minW, maxW) {
  const n = w.length;
  const floor = allowShort ? -maxW : minW;
  for (let i = 0; i < n; i++) {
    w[i] = Math.max(floor, Math.min(maxW, w[i]));
  }
  const sum = w.reduce((a, b) => a + b, 0);
  if (Math.abs(sum) > 1e-15) {
    for (let i = 0; i < n; i++) w[i] /= sum;
  } else {
    w.fill(1 / n);
  }
  // Re-clamp after normalization
  for (let i = 0; i < n; i++) {
    w[i] = Math.max(floor, Math.min(maxW, w[i]));
  }
  const sum2 = w.reduce((a, b) => a + b, 0);
  if (Math.abs(sum2) > 1e-15) {
    for (let i = 0; i < n; i++) w[i] /= sum2;
  }
  return w;
}

// ─── Redundancy Detection ───────────────────────────────

/**
 * Identify pairs of strategies with correlation above a threshold.
 *
 * @param {number[][]} correlationMatrix
 * @param {string[]} names - Strategy names
 * @param {number} [threshold=0.7] - Correlation cutoff
 * @returns {{ pairs: Array<{a: string, b: string, correlation: number}>, clusters: string[][] }}
 */
export function identifyRedundantStrategies(correlationMatrix, names, threshold = DEFAULT_CORRELATION_THRESHOLD) {
  const n = correlationMatrix.length;
  const pairs = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const absCorr = Math.abs(correlationMatrix[i][j]);
      if (absCorr > threshold) {
        pairs.push({
          a: names[i],
          b: names[j],
          correlation: correlationMatrix[i][j],
        });
      }
    }
  }

  // Sort by absolute correlation descending
  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  // Build clusters via union-find for connected components above threshold
  const parent = names.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (const pair of pairs) {
    const idxA = names.indexOf(pair.a);
    const idxB = names.indexOf(pair.b);
    union(idxA, idxB);
  }

  // Group into clusters
  const groups = {};
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(names[i]);
  }

  // Only return clusters with more than 1 member (actual redundancy)
  const clusters = Object.values(groups).filter(c => c.length > 1);

  return { pairs, clusters };
}

// ─── Portfolio Suggestion ───────────────────────────────

/**
 * Suggest a portfolio allocation balancing expected returns and diversification.
 *
 * Blends a return-maximizing portfolio with the maximum-diversification portfolio
 * using the riskBudget parameter as the blend weight.
 *   riskBudget = 0 → pure diversification (max DR)
 *   riskBudget = 1 → pure return-seeking (inverse-vol weighted by return)
 *
 * @param {Object} strategyReturns - { name: [dailyReturns], ... }
 * @param {number} [riskBudget=0.5] - Blend parameter in [0, 1]
 * @param {Object} [options]
 * @param {number} [options.window] - Correlation estimation window
 * @param {number} [options.maxWeight] - Max per-strategy weight
 * @returns {Object} Full recommendation with weights, metrics, and diagnostics
 */
export function suggestPortfolio(strategyReturns, riskBudget = 0.5, options = {}) {
  const { window = null, maxWeight = BOUNDS.maxSinglePosition } = options;
  const names = Object.keys(strategyReturns);
  const n = names.length;

  if (n === 0) {
    return { weights: [], names: [], metrics: {}, diagnostics: {} };
  }
  if (n === 1) {
    return {
      weights: [1.0],
      names,
      metrics: { diversificationRatio: 1.0, expectedReturn: 0, portfolioVol: 0 },
      diagnostics: { blend: riskBudget, method: "single_strategy" },
    };
  }

  const clampedBudget = Math.max(0, Math.min(1, riskBudget));

  // 1. Max-diversification weights
  const divResult = optimizeForDiversification(strategyReturns, { window, maxWeight });

  // 2. Return-seeking weights (inverse-vol weighted, scaled by annualized return)
  const vols = getVolatilities(strategyReturns, names);
  const annReturns = names.map(name => {
    const r = strategyReturns[name];
    return (r.reduce((a, b) => a + b, 0) / r.length) * ANNUALIZATION_FACTOR;
  });

  const returnWeights = names.map((_, i) => {
    const invVol = vols[i] > 1e-15 ? 1 / vols[i] : 0;
    return Math.max(0, annReturns[i]) * invVol;
  });
  const retSum = returnWeights.reduce((a, b) => a + b, 0);
  const normRetWeights = retSum > 1e-15
    ? returnWeights.map(w => w / retSum)
    : new Array(n).fill(1 / n);

  // 3. Blend
  let blended = new Array(n);
  for (let i = 0; i < n; i++) {
    blended[i] = (1 - clampedBudget) * divResult.weights[i] + clampedBudget * normRetWeights[i];
  }

  // Apply constraints
  blended = applyPositionLimits(blended, maxWeight);
  blended = normalizeWeights(blended, { targetSum: 1.0, longOnly: true });

  // 4. Compute final metrics
  const { matrix: corrMatrix } = computeCorrelationMatrix(strategyReturns, { window });
  const covMatrix = buildCovFromCorrAndVol(corrMatrix, vols);
  const drInfo = getDiversificationRatio(blended, corrMatrix, vols);
  const expectedReturn = blended.reduce((s, w, i) => s + w * annReturns[i], 0);
  const portVol = portfolioVolatility(blended, covMatrix) * Math.sqrt(ANNUALIZATION_FACTOR);

  // 5. Redundancy check
  const { pairs: redundantPairs, clusters } = identifyRedundantStrategies(corrMatrix, names);

  // 6. Concentration check
  const maxAlloc = Math.max(...blended);
  const effectiveN = 1 / blended.reduce((s, w) => s + w * w, 0); // Herfindahl inverse

  return {
    weights: blended,
    names,
    metrics: {
      diversificationRatio: drInfo.ratio,
      expectedReturn,
      portfolioVol: portVol,
      sharpe: portVol > 1e-15 ? expectedReturn / portVol : 0,
      effectiveStrategies: effectiveN,
      maxConcentration: maxAlloc,
    },
    diagnostics: {
      blend: clampedBudget,
      method: "diversification_return_blend",
      redundantPairs,
      redundancyClusters: clusters,
      divOnlyDR: divResult.diversificationRatio,
      optimIterations: divResult.iterations,
    },
  };
}

// ─── Rolling Correlation Stability ──────────────────────

/**
 * Track correlation stability over time using rolling windows.
 *
 * For each window position, computes the average pairwise absolute correlation.
 * Also computes the rate of change and flags regime shifts where correlation
 * changes rapidly.
 *
 * @param {Object} strategyReturns - { name: [dailyReturns], ... }
 * @param {Object} [options]
 * @param {number} [options.window=63] - Rolling window size
 * @param {number} [options.step=1] - Step size between windows
 * @param {number} [options.shiftThreshold=0.15] - Correlation change to flag as regime shift
 * @returns {{ timeline: Array, regimeShifts: Array, stability: number }}
 */
export function trackCorrelationStability(strategyReturns, options = {}) {
  const {
    window = DEFAULT_ROLLING_WINDOW,
    step = 1,
    shiftThreshold = 0.15,
  } = options;

  const names = Object.keys(strategyReturns);
  const n = names.length;

  if (n < 2) {
    return { timeline: [], regimeShifts: [], stability: 1.0 };
  }

  const series = names.map(name => strategyReturns[name]);
  const minLen = Math.min(...series.map(s => s.length));

  if (minLen < window + 1) {
    return { timeline: [], regimeShifts: [], stability: 1.0 };
  }

  const timeline = [];
  const pairCount = (n * (n - 1)) / 2;

  for (let end = window; end <= minLen; end += step) {
    const start = end - window;
    let totalAbsCorr = 0;
    let maxCorr = 0;
    let minCorr = 1;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sliceA = series[i].slice(start, end);
        const sliceB = series[j].slice(start, end);
        const c = Math.abs(pearson(sliceA, sliceB));
        totalAbsCorr += c;
        if (c > maxCorr) maxCorr = c;
        if (c < minCorr) minCorr = c;
      }
    }

    const avgAbsCorr = totalAbsCorr / pairCount;

    timeline.push({
      period: end,
      avgAbsCorrelation: avgAbsCorr,
      maxCorrelation: maxCorr,
      minCorrelation: minCorr,
      spread: maxCorr - minCorr,
    });
  }

  // Detect regime shifts: points where avg correlation changes abruptly
  const regimeShifts = [];
  for (let i = 1; i < timeline.length; i++) {
    const delta = Math.abs(timeline[i].avgAbsCorrelation - timeline[i - 1].avgAbsCorrelation);
    if (delta > shiftThreshold) {
      regimeShifts.push({
        period: timeline[i].period,
        from: timeline[i - 1].avgAbsCorrelation,
        to: timeline[i].avgAbsCorrelation,
        delta,
      });
    }
  }

  // Stability score: 1 - normalized std of rolling avg correlations
  const avgCorrs = timeline.map(t => t.avgAbsCorrelation);
  const meanCorr = avgCorrs.reduce((a, b) => a + b, 0) / avgCorrs.length;
  const stdCorr = Math.sqrt(
    avgCorrs.reduce((s, c) => s + (c - meanCorr) ** 2, 0) / avgCorrs.length
  );
  // Stability in [0, 1] where 1 = perfectly stable correlations
  const stability = Math.max(0, 1 - stdCorr * 4);

  return { timeline, regimeShifts, stability };
}

// ─── Formatted Correlation Report ───────────────────────

/**
 * Generate a formatted correlation matrix report with heatmap-style indicators.
 *
 * @param {Object} strategyReturns - { name: [dailyReturns], ... }
 * @param {Object} [options]
 * @param {number} [options.window] - Rolling window for correlation
 * @param {number} [options.redundancyThreshold=0.7]
 * @returns {string} Formatted report
 */
export function getCorrelationReport(strategyReturns, options = {}) {
  const { window = null, redundancyThreshold = DEFAULT_CORRELATION_THRESHOLD } = options;
  const names = Object.keys(strategyReturns);
  const n = names.length;

  if (n === 0) return "No strategies provided.";

  const { matrix } = computeCorrelationMatrix(strategyReturns, { window });
  const { pairs, clusters } = identifyRedundantStrategies(matrix, names, redundancyThreshold);
  const stability = trackCorrelationStability(strategyReturns, { window: window || DEFAULT_ROLLING_WINDOW });

  // Heatmap indicators by correlation magnitude
  function heatChar(corr) {
    const abs = Math.abs(corr);
    if (abs >= 0.8) return "##";  // Very high
    if (abs >= 0.6) return "++";  // High
    if (abs >= 0.4) return "~~";  // Moderate
    if (abs >= 0.2) return "..";  // Low
    return "  ";                   // Near zero
  }

  function signedVal(corr) {
    const sign = corr < 0 ? "-" : "+";
    return `${sign}${Math.abs(corr).toFixed(2)}`;
  }

  const lines = [];
  const maxNameLen = Math.max(6, ...names.map(n => Math.min(n.length, 10)));

  // Title
  lines.push("=== Strategy Correlation Matrix ===");
  lines.push(`Strategies: ${n} | Window: ${window || "full"} | Threshold: ${redundancyThreshold}`);
  lines.push("");

  // Header row
  const abbrevNames = names.map(nm => nm.slice(0, 8));
  lines.push(
    " ".repeat(maxNameLen + 1) +
    abbrevNames.map(nm => nm.padStart(9)).join("")
  );

  // Matrix rows
  for (let i = 0; i < n; i++) {
    let row = names[i].slice(0, maxNameLen).padEnd(maxNameLen) + " ";
    for (let j = 0; j < n; j++) {
      const val = matrix[i][j];
      const heat = heatChar(val);
      row += ` ${signedVal(val)}${heat}`;
    }
    lines.push(row);
  }

  lines.push("");
  lines.push("Legend: ## corr>=0.8 | ++ >=0.6 | ~~ >=0.4 | .. >=0.2 | (space) <0.2");

  // Redundant pairs
  if (pairs.length > 0) {
    lines.push("");
    lines.push(`--- Redundant Pairs (|corr| > ${redundancyThreshold}) ---`);
    for (const p of pairs) {
      lines.push(`  ${p.a} <-> ${p.b}: ${p.correlation.toFixed(3)}`);
    }
  }

  // Redundancy clusters
  if (clusters.length > 0) {
    lines.push("");
    lines.push("--- Redundancy Clusters ---");
    for (let c = 0; c < clusters.length; c++) {
      lines.push(`  Cluster ${c + 1}: [${clusters[c].join(", ")}]`);
    }
    lines.push("  Consider keeping only the best performer from each cluster.");
  }

  // Stability
  lines.push("");
  lines.push("--- Correlation Stability ---");
  lines.push(`  Stability score: ${stability.stability.toFixed(3)} (1.0 = perfectly stable)`);
  if (stability.regimeShifts.length > 0) {
    lines.push(`  Regime shifts detected: ${stability.regimeShifts.length}`);
    for (const shift of stability.regimeShifts.slice(0, 5)) {
      lines.push(`    Period ${shift.period}: ${shift.from.toFixed(3)} -> ${shift.to.toFixed(3)} (delta ${shift.delta.toFixed(3)})`);
    }
  } else {
    lines.push("  No regime shifts detected.");
  }

  // Diversification snapshot
  const vols = getVolatilities(strategyReturns, names);
  const eqWeights = new Array(n).fill(1 / n);
  const eqDR = getDiversificationRatio(eqWeights, matrix, vols);

  lines.push("");
  lines.push("--- Diversification Snapshot (Equal-Weight) ---");
  lines.push(`  Diversification Ratio: ${eqDR.ratio.toFixed(3)}`);
  lines.push(`  Weighted Avg Vol:      ${(eqDR.weightedAvgVol * Math.sqrt(ANNUALIZATION_FACTOR) * 100).toFixed(1)}%`);
  lines.push(`  Portfolio Vol:         ${(eqDR.portfolioVol * Math.sqrt(ANNUALIZATION_FACTOR) * 100).toFixed(1)}%`);

  return lines.join("\n");
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("=== Diversification Optimizer ===\n");

  // Generate synthetic strategy returns with known correlation structure
  const T = 252 * 3; // 3 years
  const strategies = [
    { name: "Momentum",    drift: 0.0003,  vol: 0.012 },
    { name: "MeanRev",     drift: 0.0002,  vol: 0.008 },
    { name: "VolArb",      drift: 0.00015, vol: 0.006 },
    { name: "StatArb",     drift: 0.00018, vol: 0.009 },
    { name: "TrendFollow", drift: 0.00025, vol: 0.011 },
  ];

  // Create returns with some correlation (Momentum and TrendFollow are correlated)
  const noise = strategies.map(() => {
    const r = [];
    for (let t = 0; t < T; t++) {
      const u1 = Math.random() * 0.9998 + 0.0001;
      const u2 = Math.random() * 0.9998 + 0.0001;
      r.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    }
    return r;
  });

  // Inject correlation between Momentum (0) and TrendFollow (4)
  const sharedFactor = noise[0].map((_, t) => {
    const u1 = Math.random() * 0.9998 + 0.0001;
    const u2 = Math.random() * 0.9998 + 0.0001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });

  const strategyReturns = {};
  for (let s = 0; s < strategies.length; s++) {
    const st = strategies[s];
    const mixing = (s === 0 || s === 4) ? 0.7 : 0; // shared factor weight
    strategyReturns[st.name] = noise[s].map((z, t) => {
      const combined = mixing * sharedFactor[t] + (1 - mixing) * z;
      return st.drift + st.vol * combined;
    });
  }

  // 1. Correlation matrix report
  console.log(getCorrelationReport(strategyReturns));
  console.log("");

  // 2. Optimize for diversification
  console.log("--- Diversification Optimization ---\n");
  const optResult = optimizeForDiversification(strategyReturns);
  console.log("  Max-DR Weights:");
  for (let i = 0; i < optResult.names.length; i++) {
    console.log(`    ${optResult.names[i].padEnd(14)} ${(optResult.weights[i] * 100).toFixed(1)}%`);
  }
  console.log(`  Diversification Ratio: ${optResult.diversificationRatio.toFixed(3)}`);
  console.log(`  Iterations: ${optResult.iterations}`);

  // 3. Suggest portfolio at different risk budgets
  console.log("\n--- Portfolio Suggestions ---\n");
  for (const budget of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    const suggestion = suggestPortfolio(strategyReturns, budget);
    const wStr = suggestion.names
      .map((n, i) => `${n.slice(0, 6)}:${(suggestion.weights[i] * 100).toFixed(0)}%`)
      .join(" ");
    console.log(
      `  Budget=${budget.toFixed(2)} DR=${suggestion.metrics.diversificationRatio.toFixed(2)} ` +
      `E[R]=${(suggestion.metrics.expectedReturn * 100).toFixed(1)}% ` +
      `Vol=${(suggestion.metrics.portfolioVol * 100).toFixed(1)}% ` +
      `Sharpe=${suggestion.metrics.sharpe.toFixed(2)}`
    );
    console.log(`    [${wStr}]`);
  }

  // 4. Correlation stability
  console.log("\n--- Correlation Stability Timeline ---\n");
  const stab = trackCorrelationStability(strategyReturns, { step: 63 });
  for (const point of stab.timeline.slice(-8)) {
    const bar = "#".repeat(Math.round(point.avgAbsCorrelation * 40));
    console.log(
      `  Period ${String(point.period).padStart(4)}: ` +
      `avg=${point.avgAbsCorrelation.toFixed(3)} ` +
      `max=${point.maxCorrelation.toFixed(3)} ` +
      `${bar}`
    );
  }
  console.log(`  Stability: ${stab.stability.toFixed(3)}`);
}

if (process.argv[1]?.includes("diversification-optimizer")) {
  main().catch(console.error);
}
