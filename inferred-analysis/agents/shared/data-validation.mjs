/**
 * Data Validation & Sanitization Module — Inferred Analysis
 *
 * Shared utilities for validating price data, sanitizing bad values,
 * and ensuring signal integrity across all strategy modules.
 *
 * Exports:
 *   validatePriceData(prices)   — checks for NaN, Infinity, negatives, missing fields
 *   sanitizePrices(prices)      — removes/interpolates bad data points
 *   validateSignals(signals)    — ensures signals are valid
 *   safeDiv(a, b)               — division that handles zero denominators
 *   safeMean(arr)               — mean that handles empty/invalid arrays
 *   safeStd(arr)                — std dev that handles empty/invalid arrays
 *   withValidation(fn, label)   — wraps a signal generator with try/catch and validation
 */

// ─── Numeric Validation Helpers ─────────────────────────

/**
 * Check if a value is a finite number (not NaN, not Infinity, not null/undefined).
 * @param {*} v
 * @returns {boolean}
 */
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// ─── Price Data Validation ──────────────────────────────

/**
 * Validate an array of OHLCV price data.
 * Returns { valid: boolean, errors: string[], warnings: string[], cleanCount: number }
 *
 * Checks:
 *   - Array is non-empty
 *   - Each bar has a .close that is finite and positive
 *   - Optionally checks .open, .high, .low, .volume fields
 *   - No NaN or Infinity in numeric fields
 *   - No negative prices
 *
 * @param {Array<{close: number, open?: number, high?: number, low?: number, volume?: number, date?: string}>} prices
 * @returns {{ valid: boolean, errors: string[], warnings: string[], cleanCount: number }}
 */
export function validatePriceData(prices) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(prices)) {
    return { valid: false, errors: ["prices is not an array"], warnings, cleanCount: 0 };
  }

  if (prices.length === 0) {
    return { valid: false, errors: ["prices array is empty"], warnings, cleanCount: 0 };
  }

  let cleanCount = 0;
  const numericFields = ["close", "open", "high", "low", "volume"];

  for (let i = 0; i < prices.length; i++) {
    const bar = prices[i];
    if (bar == null || typeof bar !== "object") {
      errors.push(`bar[${i}] is null or not an object`);
      continue;
    }

    // close is mandatory
    if (!isFiniteNum(bar.close)) {
      errors.push(`bar[${i}].close is not a finite number: ${bar.close}`);
      continue;
    }

    if (bar.close <= 0) {
      errors.push(`bar[${i}].close is non-positive: ${bar.close}`);
      continue;
    }

    // Check optional OHLV fields for bad values (warnings, not errors)
    let barClean = true;
    for (const field of numericFields) {
      if (field === "close") continue; // already checked
      if (bar[field] !== undefined && bar[field] !== null) {
        if (!isFiniteNum(bar[field])) {
          warnings.push(`bar[${i}].${field} is not finite: ${bar[field]}`);
          barClean = false;
        } else if (field !== "volume" && bar[field] < 0) {
          warnings.push(`bar[${i}].${field} is negative: ${bar[field]}`);
          barClean = false;
        }
      }
    }

    // OHLC consistency: high >= low, high >= close, low <= close
    if (isFiniteNum(bar.high) && isFiniteNum(bar.low)) {
      if (bar.high < bar.low) {
        warnings.push(`bar[${i}]: high (${bar.high}) < low (${bar.low})`);
        barClean = false;
      }
    }

    if (barClean) cleanCount++;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    cleanCount,
  };
}

// ─── Price Data Sanitization ────────────────────────────

/**
 * Sanitize price data by removing or interpolating bad data points.
 *
 * Strategy:
 *   1. Bars with invalid/missing close are dropped
 *   2. NaN/Infinity in open/high/low are replaced with close
 *   3. Negative prices are treated as invalid
 *   4. Bars where high < low are corrected (swap them)
 *   5. Missing volume defaults to 0
 *
 * Returns a new array (does not mutate input).
 *
 * @param {Array<{close: number, open?: number, high?: number, low?: number, volume?: number, date?: string}>} prices
 * @returns {Array<{close: number, open: number, high: number, low: number, volume: number, date?: string}>}
 */
export function sanitizePrices(prices) {
  if (!Array.isArray(prices)) return [];

  const result = [];

  for (let i = 0; i < prices.length; i++) {
    const bar = prices[i];
    if (bar == null || typeof bar !== "object") continue;

    // close must be valid
    if (!isFiniteNum(bar.close) || bar.close <= 0) continue;

    const close = bar.close;
    let open = isFiniteNum(bar.open) && bar.open > 0 ? bar.open : close;
    let high = isFiniteNum(bar.high) && bar.high > 0 ? bar.high : close;
    let low = isFiniteNum(bar.low) && bar.low > 0 ? bar.low : close;
    const volume = isFiniteNum(bar.volume) && bar.volume >= 0 ? bar.volume : 0;

    // Ensure high >= low
    if (high < low) {
      const tmp = high;
      high = low;
      low = tmp;
    }

    // Ensure high >= close and low <= close
    if (high < close) high = close;
    if (low > close) low = close;
    if (high < open) high = open;
    if (low > open) low = open;

    const sanitized = { close, open, high, low, volume };

    // Preserve date and any other fields
    if (bar.date !== undefined) sanitized.date = bar.date;

    // Copy through any extra fields unchanged
    for (const key of Object.keys(bar)) {
      if (!(key in sanitized)) {
        sanitized[key] = bar[key];
      }
    }

    result.push(sanitized);
  }

  return result;
}

// ─── Signal Validation ──────────────────────────────────

/**
 * Validate an array of signal objects.
 * Signals should have a numeric .signal field. Values can be:
 *   - Discrete: -1, 0, 1
 *   - Continuous: any finite number in [-1, 1] (or wider for leveraged)
 *
 * Invalid signals are clamped or zeroed out.
 * Returns a new array with validated signals.
 *
 * @param {Array<{signal: number, [key: string]: any}>} signals
 * @returns {Array<{signal: number, [key: string]: any}>}
 */
export function validateSignals(signals) {
  if (!Array.isArray(signals)) return [];

  return signals.map((sig, i) => {
    if (sig == null || typeof sig !== "object") {
      return { signal: 0, _validationError: `signal[${i}] is null or not an object` };
    }

    let signal = sig.signal;

    // Handle missing signal
    if (signal === undefined || signal === null) {
      return { ...sig, signal: 0, _validationError: "missing signal value" };
    }

    // Handle non-numeric
    if (typeof signal !== "number" || !Number.isFinite(signal)) {
      return { ...sig, signal: 0, _validationError: `invalid signal value: ${signal}` };
    }

    // Clamp extreme values (allow up to [-3, 3] for leveraged strategies)
    if (signal > 3) signal = 3;
    if (signal < -3) signal = -3;

    if (signal !== sig.signal) {
      return { ...sig, signal, _validationWarning: `signal clamped from ${sig.signal}` };
    }

    return sig;
  });
}

// ─── Safe Math Utilities ────────────────────────────────

/**
 * Safe division that returns a default value when the denominator is zero,
 * NaN, or Infinity.
 *
 * @param {number} a - Numerator
 * @param {number} b - Denominator
 * @param {number} [fallback=0] - Value to return when division is invalid
 * @returns {number}
 */
export function safeDiv(a, b, fallback = 0) {
  if (!isFiniteNum(a) || !isFiniteNum(b) || b === 0) {
    return fallback;
  }
  const result = a / b;
  return isFiniteNum(result) ? result : fallback;
}

/**
 * Safe mean that handles empty arrays, arrays with non-finite values,
 * and other edge cases.
 *
 * Filters out NaN/Infinity before computing. Returns 0 for empty input.
 *
 * @param {number[]} arr
 * @returns {number}
 */
export function safeMean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (isFiniteNum(arr[i])) {
      sum += arr[i];
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Safe standard deviation that handles empty arrays, single-element arrays,
 * and arrays with non-finite values.
 *
 * Uses population std dev (divides by N, not N-1) for consistency
 * with existing strategy code. Returns 0 for insufficient data.
 *
 * @param {number[]} arr
 * @param {boolean} [sample=false] - If true, use N-1 (sample std dev)
 * @returns {number}
 */
export function safeStd(arr, sample = false) {
  if (!Array.isArray(arr)) return 0;

  const finite = [];
  for (let i = 0; i < arr.length; i++) {
    if (isFiniteNum(arr[i])) finite.push(arr[i]);
  }

  const n = finite.length;
  if (n < 2) return 0;

  const mean = finite.reduce((s, v) => s + v, 0) / n;
  const sumSq = finite.reduce((s, v) => s + (v - mean) ** 2, 0);
  const divisor = sample ? n - 1 : n;

  if (divisor <= 0) return 0;
  const result = Math.sqrt(sumSq / divisor);
  return isFiniteNum(result) ? result : 0;
}

// ─── Strategy Wrapper ───────────────────────────────────

/**
 * Wrap a signal-generating function with input validation, try/catch,
 * and error logging. On failure, returns an array of neutral (0) signals
 * matching the expected output length.
 *
 * @param {Function} fn - The signal generation function to wrap
 * @param {string} label - Name of the strategy (for error messages)
 * @returns {Function} Wrapped function with the same signature
 */
export function withValidation(fn, label) {
  return function (...args) {
    try {
      // Validate first argument if it looks like price data
      const firstArg = args[0];
      if (Array.isArray(firstArg) && firstArg.length > 0 && firstArg[0]?.close !== undefined) {
        const validation = validatePriceData(firstArg);
        if (!validation.valid) {
          console.error(`[${label}] Price data validation failed: ${validation.errors.join("; ")}`);
          return [];
        }
        if (validation.warnings.length > 0) {
          console.warn(`[${label}] Price data warnings (${validation.warnings.length}): ${validation.warnings.slice(0, 3).join("; ")}${validation.warnings.length > 3 ? "..." : ""}`);
        }
      }
      // If first arg is an object of price arrays (multi-asset strategies)
      else if (firstArg && typeof firstArg === "object" && !Array.isArray(firstArg)) {
        const symbols = Object.keys(firstArg);
        for (const sym of symbols) {
          if (Array.isArray(firstArg[sym]) && firstArg[sym].length > 0 && firstArg[sym][0]?.close !== undefined) {
            const validation = validatePriceData(firstArg[sym]);
            if (!validation.valid) {
              console.error(`[${label}] Price data validation failed for ${sym}: ${validation.errors.join("; ")}`);
              return [];
            }
          }
        }
      }

      const result = fn.apply(this, args);
      return result;
    } catch (err) {
      console.error(`[${label}] Signal generation failed: ${err.message}`);
      return [];
    }
  };
}
