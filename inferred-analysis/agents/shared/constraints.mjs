/**
 * Shared Constraints Module — Inferred Analysis
 *
 * Provides parameter bounds, weight normalization, position limits,
 * turnover constraints, sector exposure limits, and allocation validation
 * for all optimizer modules.
 *
 * Usage:
 *   import {
 *     BOUNDS, clampWeight, normalizeWeights, applyPositionLimits,
 *     applyTurnoverConstraint, applySectorConstraints, validateAllocation,
 *     safeMatInverse
 *   } from '../shared/constraints.mjs';
 */

// ─── Default Bounds ─────────────────────────────────────

export const BOUNDS = Object.freeze({
  // Portfolio weight bounds
  weight: { min: -1.0, max: 1.0 },
  longOnlyWeight: { min: 0.0, max: 1.0 },

  // Position sizing
  maxSinglePosition: 0.25,
  maxShortPosition: -0.25,
  maxGrossExposure: 2.0,   // sum of |weights| <= 2.0 (allows 100/100 long-short)
  maxNetExposure: 1.0,     // |sum of weights| <= 1.0

  // Turnover
  maxTurnover: 0.50,       // max 50% weight change per rebalance

  // Sector / concentration
  maxSectorExposure: 0.40, // no more than 40% in one sector
  minPositions: 2,         // at least 2 positions for diversification

  // Learning / optimization parameters
  learningRate: { min: 1e-6, max: 1.0 },
  momentum: { min: 0.0, max: 0.999 },
  regularization: { min: 0.0, max: 10.0 },
  discount: { min: 0.0, max: 1.0 },
  epsilon: { min: 0.0, max: 1.0 },

  // Strategy parameters
  lookback: { min: 2, max: 500 },
  threshold: { min: 0.0001, max: 0.50 },
  stopLoss: { min: -0.50, max: 0.0 },
  takeProfit: { min: 0.001, max: 1.0 },
  positionSize: { min: 0.01, max: 0.50 },

  // Genetic / evolutionary
  mutationRate: { min: 0.001, max: 0.50 },
  mutationStrength: { min: 0.01, max: 0.50 },
  crossoverRate: { min: 0.1, max: 1.0 },
  populationSize: { min: 5, max: 1000 },

  // Volatility
  targetVol: { min: 0.01, max: 0.50 },
  maxLeverage: { min: 0.1, max: 5.0 },

  // Sharpe / performance sanity
  maxSharpe: 6.0,          // anything above ~6 annualized is almost certainly overfit
  minSharpe: -6.0,

  // Matrix condition number threshold
  matrixConditionThreshold: 1e10,
  singularityThreshold: 1e-12,
});

// ─── Weight Clamping ────────────────────────────────────

/**
 * Clamp a single weight to [min, max].
 * Returns NaN-safe result (NaN/Infinity become 0).
 *
 * @param {number} weight - The weight to clamp
 * @param {number} min - Lower bound (default -1)
 * @param {number} max - Upper bound (default 1)
 * @returns {number} Clamped weight
 */
export function clampWeight(weight, min = BOUNDS.weight.min, max = BOUNDS.weight.max) {
  if (!Number.isFinite(weight)) return 0;
  return Math.max(min, Math.min(max, weight));
}

// ─── Weight Normalization ───────────────────────────────

/**
 * Normalize an array of weights so they sum to a target value.
 * Handles edge cases: all-zero weights, NaN values, long-only constraint.
 *
 * @param {number[]} weights - Array of portfolio weights
 * @param {Object} options
 * @param {number} options.targetSum - Target sum (default 1.0)
 * @param {boolean} options.longOnly - If true, clamp negatives to 0 before normalizing
 * @param {number} options.minWeight - Floor for each weight after normalization
 * @param {number} options.maxWeight - Cap for each weight after normalization
 * @returns {number[]} Normalized weights
 */
export function normalizeWeights(weights, options = {}) {
  const {
    targetSum = 1.0,
    longOnly = false,
    minWeight = -Infinity,
    maxWeight = Infinity,
  } = options;

  // Sanitize: replace NaN/Infinity with 0
  let w = weights.map(v => Number.isFinite(v) ? v : 0);

  // Long-only: clamp negatives to 0
  if (longOnly) {
    w = w.map(v => Math.max(0, v));
  }

  // Apply per-weight bounds
  if (Number.isFinite(minWeight) || Number.isFinite(maxWeight)) {
    w = w.map(v => Math.max(minWeight, Math.min(maxWeight, v)));
  }

  const sum = w.reduce((a, b) => a + b, 0);

  // If all weights are zero, fall back to equal weights
  if (Math.abs(sum) < 1e-15) {
    const n = w.length;
    if (n === 0) return [];
    return new Array(n).fill(targetSum / n);
  }

  // Scale to target sum
  const scale = targetSum / sum;
  w = w.map(v => v * scale);

  // Re-apply bounds after scaling (iterative clip-and-redistribute)
  if (Number.isFinite(minWeight) || Number.isFinite(maxWeight)) {
    for (let iter = 0; iter < 20; iter++) {
      let excess = 0;
      const capped = new Array(w.length).fill(false);

      for (let i = 0; i < w.length; i++) {
        if (w[i] > maxWeight) {
          excess += w[i] - maxWeight;
          w[i] = maxWeight;
          capped[i] = true;
        } else if (w[i] < minWeight) {
          excess += w[i] - minWeight; // negative excess
          w[i] = minWeight;
          capped[i] = true;
        }
      }

      if (Math.abs(excess) < 1e-12) break;

      // Redistribute excess to uncapped positions proportionally
      // or equally if none have weight yet
      const uncappedIndices = [];
      for (let i = 0; i < w.length; i++) {
        if (!capped[i] && w[i] < maxWeight - 1e-12) {
          uncappedIndices.push(i);
        }
      }

      if (uncappedIndices.length === 0) {
        // All positions are at cap; cannot redistribute further
        // This is the best feasible solution (may not sum exactly to targetSum)
        break;
      }

      const uncappedSum = uncappedIndices.reduce((s, i) => s + Math.abs(w[i]), 0);
      for (const i of uncappedIndices) {
        if (uncappedSum > 1e-12) {
          // Proportional redistribution
          w[i] += excess * (Math.abs(w[i]) / uncappedSum);
        } else {
          // Equal redistribution to zero-weight positions
          w[i] += excess / uncappedIndices.length;
        }
      }
    }
  }

  return w;
}

// ─── Position Limits ────────────────────────────────────

/**
 * Cap any single position at maxSinglePosition.
 * Redistributes excess weight proportionally to remaining positions.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number} maxSinglePosition - Max absolute weight for any position (default 0.25)
 * @returns {number[]} Adjusted weights
 */
export function applyPositionLimits(weights, maxSinglePosition = BOUNDS.maxSinglePosition) {
  if (!Array.isArray(weights) || weights.length === 0) return [];

  let w = weights.map(v => Number.isFinite(v) ? v : 0);
  const originalSum = w.reduce((a, b) => a + b, 0);

  // Iterative clip-and-redistribute (converges in a few iterations)
  for (let iter = 0; iter < 20; iter++) {
    let excess = 0;
    let nUncapped = 0;

    for (let i = 0; i < w.length; i++) {
      if (Math.abs(w[i]) > maxSinglePosition) {
        excess += Math.abs(w[i]) - maxSinglePosition;
        w[i] = Math.sign(w[i]) * maxSinglePosition;
      } else {
        nUncapped++;
      }
    }

    if (excess < 1e-12) break;

    // Redistribute excess proportionally to uncapped positions
    if (nUncapped > 0 && Math.abs(originalSum) > 1e-15) {
      const uncappedSum = w
        .filter((_, i) => Math.abs(w[i]) < maxSinglePosition - 1e-12)
        .reduce((a, b) => a + Math.abs(b), 0);

      if (uncappedSum > 1e-12) {
        for (let i = 0; i < w.length; i++) {
          if (Math.abs(w[i]) < maxSinglePosition - 1e-12) {
            w[i] += (Math.abs(w[i]) / uncappedSum) * excess * Math.sign(w[i] || 1);
          }
        }
      }
    }
  }

  // Final normalization to preserve original sum
  if (Math.abs(originalSum) > 1e-15) {
    const newSum = w.reduce((a, b) => a + b, 0);
    if (Math.abs(newSum) > 1e-15) {
      const scale = originalSum / newSum;
      w = w.map(v => v * scale);
    }
  }

  // Final hard clamp
  w = w.map(v => {
    if (Math.abs(v) > maxSinglePosition + 1e-10) {
      return Math.sign(v) * maxSinglePosition;
    }
    return v;
  });

  return w;
}

// ─── Turnover Constraint ────────────────────────────────

/**
 * Limit portfolio turnover (total weight change) between rebalances.
 * Blends new weights toward old weights to stay within the turnover budget.
 *
 * @param {number[]} newWeights - Desired new weights
 * @param {number[]} oldWeights - Current/previous weights
 * @param {number} maxTurnover - Maximum total turnover (default 0.5)
 * @returns {number[]} Adjusted weights respecting turnover constraint
 */
export function applyTurnoverConstraint(newWeights, oldWeights, maxTurnover = BOUNDS.maxTurnover) {
  if (!Array.isArray(newWeights) || newWeights.length === 0) return [];
  if (!Array.isArray(oldWeights) || oldWeights.length !== newWeights.length) {
    return [...newWeights]; // no old weights to constrain against
  }

  // Sanitize inputs
  const nw = newWeights.map(v => Number.isFinite(v) ? v : 0);
  const ow = oldWeights.map(v => Number.isFinite(v) ? v : 0);

  // Compute total turnover: sum of |new[i] - old[i]| / 2
  const turnover = nw.reduce((s, w, i) => s + Math.abs(w - ow[i]), 0) / 2;

  if (turnover <= maxTurnover + 1e-12) {
    return nw; // within budget
  }

  // Scale down the trade by blending toward old weights
  // blend = maxTurnover / turnover gives us a fraction of the desired trade
  const blend = maxTurnover / turnover;
  const result = nw.map((w, i) => ow[i] + blend * (w - ow[i]));

  return result;
}

// ─── Sector Constraints ─────────────────────────────────

/**
 * Limit sector concentration. No sector can exceed maxSectorExposure.
 * Excess is redistributed proportionally within the sector.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {string[]} sectors - Sector label for each weight (parallel array)
 * @param {number} maxSectorExposure - Max total weight in one sector (default 0.4)
 * @returns {number[]} Adjusted weights
 */
export function applySectorConstraints(weights, sectors, maxSectorExposure = BOUNDS.maxSectorExposure) {
  if (!Array.isArray(weights) || weights.length === 0) return [];
  if (!Array.isArray(sectors) || sectors.length !== weights.length) {
    return [...weights]; // no sector info, pass through
  }

  const w = weights.map(v => Number.isFinite(v) ? v : 0);

  // Group indices by sector
  const sectorGroups = {};
  for (let i = 0; i < sectors.length; i++) {
    const sec = sectors[i] || "unknown";
    if (!sectorGroups[sec]) sectorGroups[sec] = [];
    sectorGroups[sec].push(i);
  }

  // For each sector, check total exposure and scale down if needed
  for (const [, indices] of Object.entries(sectorGroups)) {
    const sectorSum = indices.reduce((s, i) => s + Math.abs(w[i]), 0);

    if (sectorSum > maxSectorExposure + 1e-12) {
      const scale = maxSectorExposure / sectorSum;
      for (const i of indices) {
        w[i] *= scale;
      }
    }
  }

  return w;
}

// ─── Allocation Validation ──────────────────────────────

/**
 * Validate a weight allocation for feasibility.
 * Checks for NaN, correct sum, within bounds, and diversification.
 *
 * @param {number[]} weights - Portfolio weights to validate
 * @param {Object} options
 * @param {number} options.targetSum - Expected weight sum (default 1.0)
 * @param {number} options.tolerance - Tolerance for sum check (default 0.01)
 * @param {number} options.maxSinglePosition - Max position size (default 0.25)
 * @param {number} options.maxGrossExposure - Max sum of |weights| (default 2.0)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateAllocation(weights, options = {}) {
  const {
    targetSum = 1.0,
    tolerance = 0.01,
    maxSinglePosition = BOUNDS.maxSinglePosition,
    maxGrossExposure = BOUNDS.maxGrossExposure,
  } = options;

  const errors = [];
  const warnings = [];

  if (!Array.isArray(weights)) {
    return { valid: false, errors: ["weights is not an array"], warnings };
  }

  if (weights.length === 0) {
    return { valid: false, errors: ["weights array is empty"], warnings };
  }

  // Check for NaN / Infinity
  const nanCount = weights.filter(w => !Number.isFinite(w)).length;
  if (nanCount > 0) {
    errors.push(`${nanCount} weight(s) are NaN or Infinity`);
  }

  // Check sum
  const sum = weights.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (Math.abs(sum - targetSum) > tolerance) {
    errors.push(`weights sum to ${sum.toFixed(6)}, expected ${targetSum} (tolerance ${tolerance})`);
  }

  // Check individual position limits
  const overLimitCount = weights.filter(w => Math.abs(w) > maxSinglePosition + 1e-10).length;
  if (overLimitCount > 0) {
    warnings.push(`${overLimitCount} position(s) exceed max single position of ${maxSinglePosition}`);
  }

  // Check gross exposure
  const grossExposure = weights.reduce((s, w) => s + Math.abs(Number.isFinite(w) ? w : 0), 0);
  if (grossExposure > maxGrossExposure + tolerance) {
    warnings.push(`gross exposure ${grossExposure.toFixed(4)} exceeds max ${maxGrossExposure}`);
  }

  // Check concentration (single position > 50% is always suspicious)
  const maxPos = Math.max(...weights.map(w => Math.abs(Number.isFinite(w) ? w : 0)));
  if (maxPos > 0.50) {
    warnings.push(`largest position is ${(maxPos * 100).toFixed(1)}% -- high concentration risk`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metrics: {
      sum,
      grossExposure,
      maxPosition: maxPos,
      nPositions: weights.filter(w => Math.abs(w) > 1e-6).length,
    },
  };
}

// ─── Safe Matrix Inverse ────────────────────────────────

/**
 * Safely invert a matrix with singularity detection and regularization fallback.
 * If the matrix is singular or near-singular, applies Tikhonov regularization
 * (adds ridge penalty to diagonal) and retries.
 *
 * @param {number[][]} M - Square matrix to invert
 * @param {Object} options
 * @param {number} options.singularityThreshold - Pivot threshold (default 1e-12)
 * @param {number} options.ridgePenalty - Regularization added to diagonal on fallback (default 1e-6)
 * @param {number} options.maxRetries - Max regularization retries (default 5)
 * @returns {{ inverse: number[][] | null, regularized: boolean, ridgeUsed: number }}
 */
export function safeMatInverse(M, options = {}) {
  const {
    singularityThreshold = BOUNDS.singularityThreshold,
    ridgePenalty = 1e-6,
    maxRetries = 5,
  } = options;

  if (!Array.isArray(M) || M.length === 0 || M.length !== M[0]?.length) {
    return { inverse: null, regularized: false, ridgeUsed: 0, error: "invalid matrix dimensions" };
  }

  // Check for NaN in input matrix
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      if (!Number.isFinite(M[i][j])) {
        return { inverse: null, regularized: false, ridgeUsed: 0, error: "matrix contains NaN or Infinity" };
      }
    }
  }

  // Try direct inverse first
  const directResult = _gaussJordanInverse(M, singularityThreshold);
  if (directResult !== null) {
    return { inverse: directResult, regularized: false, ridgeUsed: 0 };
  }

  // Fallback: Tikhonov regularization with increasing ridge
  const n = M.length;
  let ridge = ridgePenalty;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const regularized = M.map((row, i) =>
      row.map((val, j) => val + (i === j ? ridge : 0))
    );

    const result = _gaussJordanInverse(regularized, singularityThreshold);
    if (result !== null) {
      return { inverse: result, regularized: true, ridgeUsed: ridge };
    }

    ridge *= 10; // increase regularization
  }

  return { inverse: null, regularized: false, ridgeUsed: 0, error: "matrix inversion failed after regularization" };
}

/**
 * Gauss-Jordan elimination for matrix inverse.
 * Returns null if singular (pivot below threshold).
 */
function _gaussJordanInverse(M, threshold) {
  const n = M.length;
  const aug = M.map((row, i) => [
    ...row.map(v => v),
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let i = 0; i < n; i++) {
    // Partial pivoting
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

    const pivot = aug[i][i];
    if (Math.abs(pivot) < threshold) return null;

    for (let j = 0; j < 2 * n; j++) aug[i][j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = aug[k][i];
      for (let j = 0; j < 2 * n; j++) aug[k][j] -= factor * aug[i][j];
    }
  }

  return aug.map(row => row.slice(n));
}

// ─── Convenience: Clamp Sharpe ──────────────────────────

/**
 * Clamp a Sharpe ratio to a sane range to detect overfitting.
 * @param {number} sharpe
 * @returns {number}
 */
export function clampSharpe(sharpe) {
  if (!Number.isFinite(sharpe)) return 0;
  return Math.max(BOUNDS.minSharpe, Math.min(BOUNDS.maxSharpe, sharpe));
}

// ─── Convenience: Clamp Parameter ───────────────────────

/**
 * Clamp a named parameter to its BOUNDS range.
 * @param {string} paramName - Key in BOUNDS (e.g., 'learningRate', 'positionSize')
 * @param {number} value - Value to clamp
 * @returns {number} Clamped value
 */
export function clampParam(paramName, value) {
  if (!Number.isFinite(value)) return 0;
  const bound = BOUNDS[paramName];
  if (!bound || typeof bound.min !== "number") return value;
  return Math.max(bound.min, Math.min(bound.max, value));
}

// ─── Convenience: Ensure Feasible Allocation ────────────

/**
 * All-in-one: clamp, limit positions, normalize, and validate.
 * Returns a guaranteed-feasible weight vector.
 *
 * @param {number[]} weights - Raw weights from optimizer
 * @param {Object} options
 * @param {number} options.maxSinglePosition - Per-position cap
 * @param {number} options.targetSum - Desired sum
 * @param {boolean} options.longOnly - Long-only constraint
 * @param {number[]} options.oldWeights - Previous weights for turnover constraint
 * @param {number} options.maxTurnover - Turnover cap
 * @param {string[]} options.sectors - Sector labels
 * @param {number} options.maxSectorExposure - Sector cap
 * @returns {number[]} Feasible weights
 */
export function ensureFeasible(weights, options = {}) {
  const {
    maxSinglePosition = BOUNDS.maxSinglePosition,
    targetSum = 1.0,
    longOnly = false,
    oldWeights = null,
    maxTurnover = BOUNDS.maxTurnover,
    sectors = null,
    maxSectorExposure = BOUNDS.maxSectorExposure,
  } = options;

  if (!Array.isArray(weights) || weights.length === 0) return [];

  // Step 1: Clamp individual weights
  let w = weights.map(v => clampWeight(v));

  // Step 2: Apply position limits
  w = applyPositionLimits(w, maxSinglePosition);

  // Step 3: Apply sector constraints if provided
  if (sectors) {
    w = applySectorConstraints(w, sectors, maxSectorExposure);
  }

  // Step 4: Normalize to target sum with position cap
  w = normalizeWeights(w, { targetSum, longOnly, maxWeight: maxSinglePosition });

  // Step 5: Apply turnover constraint if old weights provided
  if (oldWeights) {
    w = applyTurnoverConstraint(w, oldWeights, maxTurnover);
    // Re-apply position limits after turnover blending (blending can push above cap)
    w = normalizeWeights(w, { targetSum, longOnly, maxWeight: maxSinglePosition });
  }

  return w;
}
