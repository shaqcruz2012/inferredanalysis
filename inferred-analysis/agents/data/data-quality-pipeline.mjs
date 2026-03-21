#!/usr/bin/env node
/**
 * Data Quality Pipeline for Real Market Data
 *
 * 4-stage pipeline: Validate -> Clean -> Normalize -> Score
 *
 * Integrates with quality-checker.mjs detection logic and adds enforcement:
 * series scoring below 60 are flagged as unreliable.
 *
 * Exports:
 *   runPipeline(rawData, options)   — full 4-stage pipeline
 *   validateOnly(rawData)           — validation stage only, returns issues list
 *   getQualityReport(symbols)       — batch quality assessment
 *   getQualityScore(symbol)         — single symbol score + breakdown
 *
 * No external dependencies.
 */

import { DataQualityChecker, checkQuality, detectSplits, repairData } from "./quality-checker.mjs";
import { generateRealisticPrices } from "./fetch.mjs";

// ─── Constants ──────────────────────────────────────────

const UNRELIABLE_THRESHOLD = 60;

const SCORE_WEIGHTS = {
  completeness: 0.30,
  freshness: 0.20,
  consistency: 0.30,
  outlierRatio: 0.20,
};

const DEFAULT_OPTIONS = {
  // Validation
  sigmaThreshold: 5,
  staleRunLength: 3,
  volumeSpikeMultiple: 10,
  maxGapDays: 5,
  splitThresholdPct: 30,

  // Cleaning
  forwardFillMaxGap: 3,
  adjustSplits: true,
  outlierClampSigma: 4,

  // Normalization
  computeReturns: true,
  computeVolatility: true,
  normalizeVolume: true,
  volatilityWindow: 20,
  alignDates: true,

  // Scoring
  maxStalenessDays: 5,
};

// ─── Helpers ────────────────────────────────────────────

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function businessDaysBetween(dateA, dateB) {
  const a = new Date(dateA + "T12:00:00Z");
  const b = new Date(dateB + "T12:00:00Z");
  if (b <= a) return 0;
  let count = 0;
  const walker = new Date(a);
  walker.setUTCDate(walker.getUTCDate() + 1);
  while (walker <= b) {
    if (walker.getUTCDay() !== 0 && walker.getUTCDay() !== 6) {
      count++;
    }
    walker.setUTCDate(walker.getUTCDate() + 1);
  }
  return count;
}

function meanStd(arr) {
  if (arr.length === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return { mean, std: Math.sqrt(variance) };
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function deepCopyBars(bars) {
  return bars.map(b => ({ ...b }));
}

function toDateStr(d) {
  return d.toISOString().split("T")[0];
}

// ─── Stage 1: Validate ─────────────────────────────────

/**
 * Validate OHLCV data for structural integrity, gaps, staleness,
 * and consistency. Uses quality-checker.mjs detection logic under
 * the hood plus additional enforcement checks.
 *
 * @param {Array} bars - OHLCV array sorted by date ascending
 * @param {Object} opts - Pipeline options
 * @returns {{ issues: Array, passed: boolean, criticalCount: number, warningCount: number }}
 */
function stageValidate(bars, opts) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      issues: [{ type: "EMPTY_DATA", severity: "CRITICAL", index: -1, date: "N/A", detail: "No data provided" }],
      passed: false,
      criticalCount: 1,
      warningCount: 0,
    };
  }

  // Use the existing DataQualityChecker for core detection
  const checker = new DataQualityChecker({
    sigmaThreshold: opts.sigmaThreshold,
    staleRunLength: opts.staleRunLength,
    volumeSpikeMultiple: opts.volumeSpikeMultiple,
    maxGapDays: opts.maxGapDays,
    splitThresholdPct: opts.splitThresholdPct,
  });

  const result = checker.checkQuality(bars);
  const issues = [...result.issues];

  // --- Enforcement checks beyond detection ---

  // Check date ordering
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].date <= bars[i - 1].date) {
      issues.push({
        type: "DATE_ORDER",
        severity: "CRITICAL",
        index: i,
        date: bars[i].date,
        detail: `Date ${bars[i].date} is not after ${bars[i - 1].date} (out of order or duplicate)`,
      });
    }
  }

  // Check for weekend dates in the series
  for (let i = 0; i < bars.length; i++) {
    if (isWeekend(bars[i].date)) {
      issues.push({
        type: "WEEKEND_DATE",
        severity: "WARNING",
        index: i,
        date: bars[i].date,
        detail: "Market data on a weekend date",
      });
    }
  }

  // Staleness enforcement: last bar age vs today
  const lastDate = bars[bars.length - 1].date;
  const today = toDateStr(new Date());
  const staleDays = businessDaysBetween(lastDate, today);
  if (staleDays > opts.maxStalenessDays) {
    issues.push({
      type: "STALE_SERIES",
      severity: "WARNING",
      index: bars.length - 1,
      date: lastDate,
      detail: `Series ends ${staleDays} business days ago (threshold: ${opts.maxStalenessDays})`,
    });
  }

  const criticalCount = issues.filter(i => i.severity === "CRITICAL").length;
  const warningCount = issues.filter(i => i.severity === "WARNING").length;

  return {
    issues,
    passed: criticalCount === 0,
    criticalCount,
    warningCount,
  };
}

// ─── Stage 2: Clean ─────────────────────────────────────

/**
 * Clean data: forward-fill gaps, adjust splits, remove outliers.
 *
 * @param {Array} bars - OHLCV array
 * @param {Object} opts - Pipeline options
 * @returns {{ cleaned: Array, actions: Array<string> }}
 */
function stageClean(bars, opts) {
  const actions = [];

  if (!Array.isArray(bars) || bars.length === 0) {
    return { cleaned: [], actions: ["No data to clean"] };
  }

  // Step 1: Remove duplicate dates (keep first occurrence)
  let cleaned = [];
  const seenDates = new Set();
  for (const bar of bars) {
    if (!seenDates.has(bar.date)) {
      seenDates.add(bar.date);
      cleaned.push({ ...bar });
    } else {
      actions.push(`${bar.date}: Removed duplicate bar`);
    }
  }

  // Step 2: Sort by date
  cleaned.sort((a, b) => a.date.localeCompare(b.date));

  // Step 3: Remove weekend bars
  const beforeWeekend = cleaned.length;
  cleaned = cleaned.filter(b => !isWeekend(b.date));
  const removedWeekend = beforeWeekend - cleaned.length;
  if (removedWeekend > 0) {
    actions.push(`Removed ${removedWeekend} weekend bar(s)`);
  }

  // Step 4: Forward-fill missing fields (NaN/null -> previous bar value)
  const priceFields = ["open", "high", "low", "close"];
  for (let i = 0; i < cleaned.length; i++) {
    for (const field of priceFields) {
      if (cleaned[i][field] === undefined || cleaned[i][field] === null || Number.isNaN(cleaned[i][field])) {
        if (i > 0 && typeof cleaned[i - 1][field] === "number") {
          cleaned[i][field] = cleaned[i - 1][field];
          actions.push(`${cleaned[i].date}: Forward-filled ${field} from prior bar`);
        }
      }
    }
    if (cleaned[i].volume === undefined || cleaned[i].volume === null || Number.isNaN(cleaned[i].volume)) {
      if (i > 0 && typeof cleaned[i - 1].volume === "number") {
        cleaned[i].volume = cleaned[i - 1].volume;
        actions.push(`${cleaned[i].date}: Forward-filled volume from prior bar`);
      } else {
        cleaned[i].volume = 0;
        actions.push(`${cleaned[i].date}: Set missing volume to 0`);
      }
    }
  }

  // Step 5: Use repairData for gap interpolation and split adjustment
  const { repaired, repairs } = repairData(cleaned, {
    maxInterpolateGap: opts.forwardFillMaxGap,
    adjustSplits: opts.adjustSplits,
  });
  cleaned = repaired;
  actions.push(...repairs);

  // Step 6: Clamp outlier returns
  if (cleaned.length >= 20 && opts.outlierClampSigma > 0) {
    const returns = [];
    for (let i = 1; i < cleaned.length; i++) {
      if (cleaned[i].close > 0 && cleaned[i - 1].close > 0) {
        returns.push(Math.log(cleaned[i].close / cleaned[i - 1].close));
      } else {
        returns.push(0);
      }
    }
    const { mean, std } = meanStd(returns);
    if (std > 0) {
      const upperBound = mean + opts.outlierClampSigma * std;
      const lowerBound = mean - opts.outlierClampSigma * std;

      for (let i = 1; i < cleaned.length; i++) {
        if (cleaned[i].close <= 0 || cleaned[i - 1].close <= 0) continue;
        const ret = Math.log(cleaned[i].close / cleaned[i - 1].close);
        if (ret > upperBound || ret < lowerBound) {
          const clampedRet = Math.max(lowerBound, Math.min(upperBound, ret));
          const newClose = +(cleaned[i - 1].close * Math.exp(clampedRet)).toFixed(2);
          const ratio = newClose / cleaned[i].close;

          actions.push(
            `${cleaned[i].date}: Clamped outlier return ${(ret * 100).toFixed(2)}% -> ${(clampedRet * 100).toFixed(2)}% (close ${cleaned[i].close} -> ${newClose})`
          );

          cleaned[i].close = newClose;
          cleaned[i].open = +(cleaned[i].open * ratio).toFixed(2);
          cleaned[i].high = +(cleaned[i].high * ratio).toFixed(2);
          cleaned[i].low = +(cleaned[i].low * ratio).toFixed(2);

          // Re-enforce OHLC consistency after clamping
          const maxP = Math.max(cleaned[i].open, cleaned[i].high, cleaned[i].low, cleaned[i].close);
          const minP = Math.min(cleaned[i].open, cleaned[i].high, cleaned[i].low, cleaned[i].close);
          cleaned[i].high = maxP;
          cleaned[i].low = minP;
        }
      }
    }
  }

  // Step 7: Final OHLC consistency pass
  for (let i = 0; i < cleaned.length; i++) {
    const bar = cleaned[i];
    const maxP = Math.max(bar.open, bar.high, bar.low, bar.close);
    const minP = Math.min(bar.open, bar.high, bar.low, bar.close);
    if (bar.high < maxP) {
      bar.high = maxP;
    }
    if (bar.low > minP) {
      bar.low = minP;
    }
    // Ensure non-negative volume
    if (bar.volume < 0) {
      bar.volume = 0;
      actions.push(`${bar.date}: Corrected negative volume to 0`);
    }
  }

  return { cleaned, actions };
}

// ─── Stage 3: Normalize ─────────────────────────────────

/**
 * Normalize data: compute returns, rolling volatility, volume normalization,
 * and cross-asset date alignment.
 *
 * @param {Array} bars - Cleaned OHLCV array
 * @param {Object} opts - Pipeline options
 * @returns {{ normalized: Array, metadata: Object }}
 */
function stageNormalize(bars, opts) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { normalized: [], metadata: { barCount: 0 } };
  }

  const normalized = deepCopyBars(bars);
  const volWindow = opts.volatilityWindow || 20;

  // --- Returns ---
  if (opts.computeReturns) {
    normalized[0].return = 0;
    normalized[0].logReturn = 0;
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i].close > 0 && normalized[i - 1].close > 0) {
        normalized[i].return = +((normalized[i].close / normalized[i - 1].close - 1)).toFixed(6);
        normalized[i].logReturn = +(Math.log(normalized[i].close / normalized[i - 1].close)).toFixed(6);
      } else {
        normalized[i].return = 0;
        normalized[i].logReturn = 0;
      }
    }
  }

  // --- Rolling volatility (annualized, based on log returns) ---
  if (opts.computeVolatility && normalized.length > volWindow) {
    for (let i = 0; i < volWindow; i++) {
      normalized[i].volatility = null;
    }
    for (let i = volWindow; i < normalized.length; i++) {
      const window = [];
      for (let j = i - volWindow + 1; j <= i; j++) {
        window.push(normalized[j].logReturn || 0);
      }
      const { std } = meanStd(window);
      // Annualize: multiply by sqrt(252)
      normalized[i].volatility = +(std * Math.sqrt(252)).toFixed(6);
    }
  }

  // --- Volume normalization (z-score relative to rolling 20-day median/MAD) ---
  if (opts.normalizeVolume) {
    const vols = normalized.map(b => b.volume || 0);
    for (let i = 0; i < normalized.length; i++) {
      if (i < volWindow) {
        normalized[i].volumeNorm = null;
        continue;
      }
      const window = vols.slice(i - volWindow, i);
      const med = median(window);
      // Median Absolute Deviation
      const mad = median(window.map(v => Math.abs(v - med)));
      if (mad > 0) {
        normalized[i].volumeNorm = +((vols[i] - med) / (mad * 1.4826)).toFixed(4);
      } else if (med > 0) {
        normalized[i].volumeNorm = +((vols[i] / med - 1)).toFixed(4);
      } else {
        normalized[i].volumeNorm = 0;
      }
    }
  }

  // Metadata
  const allReturns = normalized
    .filter(b => b.logReturn !== undefined && b.logReturn !== null && b.logReturn !== 0)
    .map(b => b.logReturn);
  const { mean: meanRet, std: stdRet } = meanStd(allReturns);
  const lastVol = normalized.filter(b => b.volatility != null);
  const currentVol = lastVol.length > 0 ? lastVol[lastVol.length - 1].volatility : null;

  const metadata = {
    barCount: normalized.length,
    dateRange: normalized.length > 0
      ? { start: normalized[0].date, end: normalized[normalized.length - 1].date }
      : null,
    meanDailyReturn: +(meanRet).toFixed(6),
    dailyReturnStd: +(stdRet).toFixed(6),
    annualizedReturn: +((meanRet * 252) * 100).toFixed(2),
    currentVolatility: currentVol,
    fieldsAdded: [
      opts.computeReturns ? "return, logReturn" : null,
      opts.computeVolatility ? "volatility" : null,
      opts.normalizeVolume ? "volumeNorm" : null,
    ].filter(Boolean),
  };

  return { normalized, metadata };
}

/**
 * Align multiple assets to a common date set (intersection).
 * Only keeps dates present in ALL series.
 *
 * @param {Object} assetMap - { symbol: bars[] }
 * @returns {Object} - { symbol: alignedBars[] }
 */
function alignDates(assetMap) {
  const symbols = Object.keys(assetMap);
  if (symbols.length <= 1) return assetMap;

  // Build date sets for each symbol
  const dateSets = symbols.map(s => new Set(assetMap[s].map(b => b.date)));

  // Intersection of all date sets
  let commonDates = dateSets[0];
  for (let i = 1; i < dateSets.length; i++) {
    commonDates = new Set([...commonDates].filter(d => dateSets[i].has(d)));
  }

  const result = {};
  for (const symbol of symbols) {
    result[symbol] = assetMap[symbol].filter(b => commonDates.has(b.date));
  }
  return result;
}

// ─── Stage 4: Score ─────────────────────────────────────

/**
 * Score data quality 0-100 based on completeness, freshness,
 * consistency, and outlier ratio.
 *
 * @param {Array} bars - Normalized OHLCV array
 * @param {Array} validationIssues - Issues from validation stage
 * @param {Object} opts - Pipeline options
 * @returns {{ score: number, breakdown: Object, reliable: boolean }}
 */
function stageScore(bars, validationIssues, opts) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      score: 0,
      breakdown: { completeness: 0, freshness: 0, consistency: 0, outlierRatio: 0 },
      reliable: false,
      flag: "UNRELIABLE: no data",
    };
  }

  // --- Completeness (0-100): penalize gaps and missing data ---
  const totalBars = bars.length;
  const gapIssues = validationIssues.filter(i => i.type === "DATE_GAP");
  const missingFieldIssues = validationIssues.filter(i =>
    i.type === "MISSING_FIELD" || i.type === "INVALID_VALUE"
  );
  const interpolatedBars = bars.filter(b => b._interpolated).length;

  // Estimate expected bars from date range
  let expectedBars = totalBars;
  if (totalBars > 1) {
    const startDate = bars[0].date;
    const endDate = bars[totalBars - 1].date;
    expectedBars = Math.max(totalBars, businessDaysBetween(startDate, endDate));
  }
  const coverageRatio = expectedBars > 0 ? Math.min(1, totalBars / expectedBars) : 1;
  const missingPenalty = Math.min(1, (missingFieldIssues.length / Math.max(1, totalBars)));
  const interpolatedPenalty = Math.min(0.3, (interpolatedBars / Math.max(1, totalBars)) * 0.5);
  const completeness = Math.max(0, (coverageRatio - missingPenalty - interpolatedPenalty) * 100);

  // --- Freshness (0-100): how recent is the data ---
  const lastDate = bars[totalBars - 1].date;
  const today = toDateStr(new Date());
  const staleDays = businessDaysBetween(lastDate, today);
  // Full marks if <= 1 day old, linear decay to 0 at 30 days
  const freshness = Math.max(0, Math.min(100, (1 - staleDays / 30) * 100));

  // --- Consistency (0-100): OHLC validity, date ordering ---
  const ohlcIssues = validationIssues.filter(i =>
    i.type === "OHLC_INVALID" || i.type === "NON_POSITIVE_PRICE" ||
    i.type === "DATE_ORDER" || i.type === "WEEKEND_DATE"
  );
  const staleDataIssues = validationIssues.filter(i => i.type === "STALE_DATA");
  const consistencyPenalty = Math.min(1,
    (ohlcIssues.length * 5 + staleDataIssues.length * 2) / Math.max(1, totalBars)
  );
  const consistency = Math.max(0, (1 - consistencyPenalty) * 100);

  // --- Outlier ratio (0-100): fewer outliers = higher score ---
  const outlierIssues = validationIssues.filter(i =>
    i.type === "OUTLIER_RETURN" || i.type === "PRICE_JUMP" || i.type === "VOLUME_SPIKE"
  );
  const outlierRatio = outlierIssues.length / Math.max(1, totalBars);
  // Full marks if <1% outliers, decays to 0 at 10%
  const outlierScore = Math.max(0, Math.min(100, (1 - outlierRatio / 0.10) * 100));

  // --- Weighted final score ---
  const score = +(
    completeness * SCORE_WEIGHTS.completeness +
    freshness * SCORE_WEIGHTS.freshness +
    consistency * SCORE_WEIGHTS.consistency +
    outlierScore * SCORE_WEIGHTS.outlierRatio
  ).toFixed(1);

  const reliable = score >= UNRELIABLE_THRESHOLD;

  const result = {
    score,
    breakdown: {
      completeness: +completeness.toFixed(1),
      freshness: +freshness.toFixed(1),
      consistency: +consistency.toFixed(1),
      outlierRatio: +outlierScore.toFixed(1),
    },
    reliable,
  };

  if (!reliable) {
    result.flag = `UNRELIABLE: quality score ${score} is below threshold ${UNRELIABLE_THRESHOLD}`;
  }

  return result;
}

// ─── Exported Pipeline ──────────────────────────────────

/**
 * Run the full 4-stage data quality pipeline.
 *
 * Stages: Validate -> Clean -> Normalize -> Score
 *
 * @param {Array|Object} rawData
 *   Either an OHLCV array for a single symbol, or
 *   an object { symbol: bars[] } for multiple symbols.
 * @param {Object} [options] - Override default pipeline options.
 * @returns {Object} Pipeline result with stages, final data, and scores.
 */
export function runPipeline(rawData, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Handle multi-symbol input
  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    const results = {};
    const symbols = Object.keys(rawData);
    const assetMap = {};

    for (const symbol of symbols) {
      const singleResult = _runSinglePipeline(rawData[symbol], opts);
      results[symbol] = singleResult;
      if (singleResult.data && singleResult.data.length > 0) {
        assetMap[symbol] = singleResult.data;
      }
    }

    // Cross-asset date alignment
    if (opts.alignDates && Object.keys(assetMap).length > 1) {
      const aligned = alignDates(assetMap);
      for (const symbol of Object.keys(aligned)) {
        results[symbol].data = aligned[symbol];
        results[symbol].stages.normalize.metadata.alignedBarCount = aligned[symbol].length;
      }
    }

    return {
      type: "multi",
      symbols,
      results,
      summary: _buildMultiSummary(results),
    };
  }

  // Single symbol
  const result = _runSinglePipeline(rawData, opts);
  return {
    type: "single",
    ...result,
  };
}

/**
 * Run pipeline stages for a single OHLCV array.
 */
function _runSinglePipeline(bars, opts) {
  const stages = {};

  // Stage 1: Validate
  const validation = stageValidate(bars, opts);
  stages.validate = {
    issueCount: validation.issues.length,
    criticalCount: validation.criticalCount,
    warningCount: validation.warningCount,
    passed: validation.passed,
    issues: validation.issues,
  };

  // Stage 2: Clean
  const { cleaned, actions } = stageClean(bars, opts);
  stages.clean = {
    inputBars: Array.isArray(bars) ? bars.length : 0,
    outputBars: cleaned.length,
    actionsApplied: actions.length,
    actions,
  };

  // Stage 3: Normalize
  const { normalized, metadata } = stageNormalize(cleaned, opts);
  stages.normalize = { metadata };

  // Stage 4: Score (use validation issues from original data for scoring)
  const scoring = stageScore(normalized, validation.issues, opts);
  stages.score = scoring;

  return {
    data: normalized,
    stages,
    score: scoring.score,
    reliable: scoring.reliable,
    flag: scoring.flag || null,
  };
}

/**
 * Build summary across multiple symbols.
 */
function _buildMultiSummary(results) {
  const symbols = Object.keys(results);
  const scores = symbols.map(s => results[s].score);
  const unreliable = symbols.filter(s => !results[s].reliable);

  return {
    symbolCount: symbols.length,
    avgScore: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    unreliableSymbols: unreliable,
    unreliableCount: unreliable.length,
    allReliable: unreliable.length === 0,
  };
}

// ─── validateOnly ───────────────────────────────────────

/**
 * Run only the validation stage on raw OHLCV data.
 * Returns a list of issues with severity, type, and detail.
 *
 * @param {Array} rawData - OHLCV array sorted by date ascending.
 * @returns {{ issues: Array, passed: boolean, criticalCount: number, warningCount: number, summary: Object }}
 */
export function validateOnly(rawData) {
  const opts = { ...DEFAULT_OPTIONS };
  const result = stageValidate(rawData, opts);

  // Group issues by type for the summary
  const byType = {};
  for (const iss of result.issues) {
    byType[iss.type] = (byType[iss.type] || 0) + 1;
  }

  return {
    issues: result.issues,
    passed: result.passed,
    criticalCount: result.criticalCount,
    warningCount: result.warningCount,
    summary: {
      totalIssues: result.issues.length,
      byType,
      barCount: Array.isArray(rawData) ? rawData.length : 0,
    },
  };
}

// ─── getQualityReport ───────────────────────────────────

/**
 * Batch quality assessment for multiple symbols.
 * Fetches data (from cache/synthetic) and runs full pipeline.
 *
 * @param {Array<string>} symbols - List of ticker symbols.
 * @param {Object} [options] - Pipeline options.
 * @returns {{ report: Object, unreliable: Array<string>, reliable: Array<string> }}
 */
export function getQualityReport(symbols, options = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { report: {}, unreliable: [], reliable: [] };
  }

  const report = {};
  const unreliable = [];
  const reliable = [];

  for (const symbol of symbols) {
    let bars;
    try {
      bars = generateRealisticPrices(symbol);
    } catch {
      report[symbol] = {
        error: "Failed to fetch or generate data",
        score: 0,
        reliable: false,
        flag: `UNRELIABLE: data unavailable for ${symbol}`,
      };
      unreliable.push(symbol);
      continue;
    }

    const result = runPipeline(bars, options);
    report[symbol] = {
      score: result.score,
      reliable: result.reliable,
      flag: result.flag,
      breakdown: result.stages.score.breakdown,
      barCount: result.data.length,
      dateRange: result.stages.normalize.metadata.dateRange,
      issueCount: result.stages.validate.issueCount,
      criticalCount: result.stages.validate.criticalCount,
    };

    if (result.reliable) {
      reliable.push(symbol);
    } else {
      unreliable.push(symbol);
    }
  }

  return {
    report,
    unreliable,
    reliable,
    summary: {
      total: symbols.length,
      reliableCount: reliable.length,
      unreliableCount: unreliable.length,
      scores: Object.fromEntries(symbols.map(s => [s, report[s].score])),
    },
  };
}

// ─── getQualityScore ────────────────────────────────────

/**
 * Get quality score and breakdown for a single symbol.
 *
 * @param {string} symbol - Ticker symbol.
 * @param {Object} [options] - Pipeline options.
 * @returns {{ symbol: string, score: number, reliable: boolean, breakdown: Object, flag: string|null }}
 */
export function getQualityScore(symbol, options = {}) {
  let bars;
  try {
    bars = generateRealisticPrices(symbol);
  } catch {
    return {
      symbol,
      score: 0,
      reliable: false,
      breakdown: { completeness: 0, freshness: 0, consistency: 0, outlierRatio: 0 },
      flag: `UNRELIABLE: data unavailable for ${symbol}`,
    };
  }

  const result = runPipeline(bars, options);

  return {
    symbol,
    score: result.score,
    reliable: result.reliable,
    breakdown: result.stages.score.breakdown,
    flag: result.flag,
    barCount: result.data.length,
    dateRange: result.stages.normalize.metadata.dateRange,
    issueCount: result.stages.validate.issueCount,
    criticalCount: result.stages.validate.criticalCount,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const symbols = args.length > 0 ? args : ["SPY", "AAPL", "MSFT"];

  console.log("Data Quality Pipeline");
  console.log("=".repeat(60));

  // Run batch report
  const { report, unreliable, reliable, summary } = getQualityReport(symbols);

  for (const symbol of symbols) {
    const r = report[symbol];
    console.log(`\n--- ${symbol} ---`);

    if (r.error) {
      console.log(`  Error: ${r.error}`);
      continue;
    }

    console.log(`  Score:       ${r.score}/100 ${r.reliable ? "(RELIABLE)" : "(UNRELIABLE)"}`);
    console.log(`  Bars:        ${r.barCount}`);
    console.log(`  Date range:  ${r.dateRange?.start} to ${r.dateRange?.end}`);
    console.log(`  Issues:      ${r.issueCount} (${r.criticalCount} critical)`);
    console.log(`  Breakdown:`);
    console.log(`    Completeness: ${r.breakdown.completeness}`);
    console.log(`    Freshness:    ${r.breakdown.freshness}`);
    console.log(`    Consistency:  ${r.breakdown.consistency}`);
    console.log(`    Outlier:      ${r.breakdown.outlierRatio}`);

    if (r.flag) {
      console.log(`  FLAG: ${r.flag}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Summary: ${summary.reliableCount}/${summary.total} reliable, ${summary.unreliableCount} unreliable`);
  if (unreliable.length > 0) {
    console.log(`Unreliable: ${unreliable.join(", ")}`);
  }
  console.log("Done.");
}

if (process.argv[1]?.includes("data-quality-pipeline")) {
  main().catch(err => {
    console.error("Pipeline failed:", err.message);
    process.exit(1);
  });
}
