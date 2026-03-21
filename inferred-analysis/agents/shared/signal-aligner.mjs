#!/usr/bin/env node
/**
 * Signal Aligner — Inferred Analysis Shared Module
 *
 * Handles misaligned dates and different timeframes across agent signal sets.
 * Ensures the ensemble modules receive properly aligned data before combining.
 *
 * Exports:
 *   alignSignals(signalSets, method)   — align multiple signal arrays to common dates
 *   resampleSignal(signal, fromFreq, toFreq) — convert between timeframes
 *   fillGaps(signal, method)           — fill missing dates in a signal array
 *   getSignalOverlap(signalSets)       — report overlap stats per source
 *   getRegimeAlignmentMethod(regimes)  — pick alignment method based on regime
 */

// ─── Date Helpers ────────────────────────────────────────────

/** Parse a date string to epoch ms. Handles YYYY-MM-DD and ISO formats. */
function toEpoch(dateStr) {
  return new Date(dateStr).getTime();
}

/** Format epoch ms back to YYYY-MM-DD. */
function toDateStr(epoch) {
  const d = new Date(epoch);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Normalize a date string to YYYY-MM-DD for consistent keying. */
function normalizeDate(dateStr) {
  return toDateStr(toEpoch(dateStr));
}

/** Generate all business days between two YYYY-MM-DD strings (inclusive). */
function generateBusinessDays(startDate, endDate) {
  const dates = [];
  const start = toEpoch(startDate);
  const end = toEpoch(endDate);
  const ONE_DAY = 86400 * 1000;

  for (let t = start; t <= end; t += ONE_DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      dates.push(toDateStr(t));
    }
  }
  return dates;
}

// ─── alignSignals ────────────────────────────────────────────

/**
 * Align multiple signal arrays to common dates.
 *
 * @param {Array} signalSets - Array of { name, signals: [{ date, signal, price, ... }], weight? }
 * @param {string} method - 'intersection' | 'union' | 'latest'
 *   - 'intersection': only dates present in ALL signal sets (conservative, no fill)
 *   - 'union': all dates from any set; missing entries filled via carry-forward then zero
 *   - 'latest': keep only the most recent signal per source, aligned to a single date
 * @returns {Array} signalSets with signals arrays aligned to the chosen date set
 */
export function alignSignals(signalSets, method = "union") {
  if (!signalSets || signalSets.length === 0) return [];
  if (signalSets.length === 1) return signalSets;

  // Build per-source date maps: date -> signal entry
  const sourceMaps = signalSets.map((src) => {
    const map = new Map();
    for (const sig of src.signals) {
      const key = normalizeDate(sig.date);
      map.set(key, sig);
    }
    return map;
  });

  // Determine the target date set
  let targetDates;

  if (method === "intersection") {
    targetDates = getIntersectionDates(sourceMaps);
  } else if (method === "latest") {
    return alignToLatest(signalSets, sourceMaps);
  } else {
    // 'union' (default)
    targetDates = getUnionDates(sourceMaps);
  }

  if (targetDates.length === 0) return signalSets;

  // Re-build each source's signals array aligned to targetDates
  return signalSets.map((src, idx) => {
    const map = sourceMaps[idx];
    const aligned = [];
    let lastEntry = null;

    for (const date of targetDates) {
      if (map.has(date)) {
        lastEntry = map.get(date);
        aligned.push({ ...lastEntry, date });
      } else if (method === "union") {
        // Carry forward the most recent signal; zero if none seen yet
        if (lastEntry) {
          aligned.push({
            date,
            signal: lastEntry.signal,
            price: lastEntry.price,
            _filled: "carry_forward",
          });
        } else {
          aligned.push({
            date,
            signal: 0,
            price: null,
            _filled: "zero",
          });
        }
      }
    }

    return { ...src, signals: aligned };
  });
}

/** Dates present in every source. */
function getIntersectionDates(sourceMaps) {
  if (sourceMaps.length === 0) return [];
  const sets = sourceMaps.map((m) => new Set(m.keys()));
  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((d) => sets[i].has(d)));
  }
  return [...common].sort();
}

/** All dates from any source, sorted. */
function getUnionDates(sourceMaps) {
  const allDates = new Set();
  for (const m of sourceMaps) {
    for (const d of m.keys()) allDates.add(d);
  }
  return [...allDates].sort();
}

/** Align to the single most-recent date available, using each source's latest signal. */
function alignToLatest(signalSets, sourceMaps) {
  // Find the most recent date across all sources
  let latestDate = null;
  for (const m of sourceMaps) {
    for (const d of m.keys()) {
      if (!latestDate || d > latestDate) latestDate = d;
    }
  }
  if (!latestDate) return signalSets;

  return signalSets.map((src, idx) => {
    const map = sourceMaps[idx];

    // If source has the latest date, use it directly
    if (map.has(latestDate)) {
      return { ...src, signals: [{ ...map.get(latestDate), date: latestDate }] };
    }

    // Otherwise, find the source's own most recent signal
    const sorted = [...map.keys()].sort();
    const mostRecent = sorted[sorted.length - 1];
    if (mostRecent && map.has(mostRecent)) {
      return {
        ...src,
        signals: [{
          ...map.get(mostRecent),
          date: latestDate,
          _originalDate: mostRecent,
          _filled: "latest_carry",
        }],
      };
    }

    return { ...src, signals: [{ date: latestDate, signal: 0, price: null, _filled: "zero" }] };
  });
}

// ─── resampleSignal ──────────────────────────────────────────

/** Supported frequency labels. */
const FREQ_DAYS = {
  daily: 1,
  weekly: 5,
  biweekly: 10,
  monthly: 21,
  quarterly: 63,
};

/**
 * Resample a signal array from one frequency to another.
 *
 * @param {Array} signal - Array of { date, signal, price, ... } sorted by date
 * @param {string} fromFreq - Source frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'
 * @param {string} toFreq - Target frequency
 * @returns {Array} Resampled signal array
 *
 * Downsampling (daily -> weekly): takes the last signal in each bucket.
 * Upsampling (weekly -> daily): forward-fills the signal across days.
 */
export function resampleSignal(signal, fromFreq, toFreq) {
  if (!signal || signal.length === 0) return [];
  if (fromFreq === toFreq) return signal;

  const fromDays = FREQ_DAYS[fromFreq];
  const toDays = FREQ_DAYS[toFreq];

  if (!fromDays || !toDays) {
    throw new Error(`Unknown frequency. Supported: ${Object.keys(FREQ_DAYS).join(", ")}`);
  }

  if (toDays > fromDays) {
    // Downsampling: aggregate buckets, take last signal per bucket
    return downsample(signal, toDays);
  } else {
    // Upsampling: expand each entry across the interval
    return upsample(signal, fromDays, toDays);
  }
}

function downsample(signal, bucketDays) {
  const result = [];
  let bucketStart = toEpoch(signal[0].date);
  let lastInBucket = null;
  const bucketMs = bucketDays * 86400 * 1000;

  for (const entry of signal) {
    const epoch = toEpoch(entry.date);
    if (epoch >= bucketStart + bucketMs) {
      // Emit previous bucket
      if (lastInBucket) result.push(lastInBucket);
      // Advance bucket start
      while (epoch >= bucketStart + bucketMs) {
        bucketStart += bucketMs;
      }
    }
    lastInBucket = entry;
  }
  // Emit final bucket
  if (lastInBucket) result.push(lastInBucket);
  return result;
}

function upsample(signal, fromDays, toDays) {
  if (signal.length < 2) return signal;

  const result = [];
  const stepMs = toDays * 86400 * 1000;

  for (let i = 0; i < signal.length - 1; i++) {
    const startEpoch = toEpoch(signal[i].date);
    const endEpoch = toEpoch(signal[i + 1].date);

    for (let t = startEpoch; t < endEpoch; t += stepMs) {
      const dow = new Date(t).getUTCDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      result.push({
        ...signal[i],
        date: toDateStr(t),
        _resampled: true,
      });
    }
  }
  // Include the last entry
  result.push(signal[signal.length - 1]);
  return result;
}

// ─── fillGaps ────────────────────────────────────────────────

/**
 * Fill missing dates in a signal array.
 *
 * @param {Array} signal - Array of { date, signal, price, ... } sorted by date
 * @param {string} method - 'forward' | 'zero' | 'interpolate'
 *   - 'forward': carry the previous signal/price forward
 *   - 'zero': fill missing signals with 0, price with last known
 *   - 'interpolate': linear interpolation between surrounding values
 * @returns {Array} Signal array with gaps filled (business days only)
 */
export function fillGaps(signal, method = "forward") {
  if (!signal || signal.length < 2) return signal || [];

  const sorted = [...signal].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startDate = sorted[0].date;
  const endDate = sorted[sorted.length - 1].date;
  const allDays = generateBusinessDays(startDate, endDate);

  // Index existing signals by date
  const dateMap = new Map();
  for (const entry of sorted) {
    dateMap.set(normalizeDate(entry.date), entry);
  }

  if (method === "interpolate") {
    return fillInterpolate(allDays, dateMap, sorted);
  }

  const result = [];
  let lastKnown = null;

  for (const date of allDays) {
    if (dateMap.has(date)) {
      lastKnown = dateMap.get(date);
      result.push({ ...lastKnown, date });
    } else if (method === "forward" && lastKnown) {
      result.push({
        date,
        signal: lastKnown.signal,
        price: lastKnown.price,
        _filled: "forward",
      });
    } else {
      // 'zero' fill or no prior data for forward fill
      result.push({
        date,
        signal: 0,
        price: lastKnown ? lastKnown.price : null,
        _filled: "zero",
      });
    }
  }

  return result;
}

function fillInterpolate(allDays, dateMap, sorted) {
  // Build lookup arrays for interpolation anchors
  const anchors = sorted.map((s) => ({
    epoch: toEpoch(s.date),
    signal: s.signal,
    price: s.price,
    entry: s,
  }));

  const result = [];
  let anchorIdx = 0;

  for (const date of allDays) {
    if (dateMap.has(date)) {
      result.push({ ...dateMap.get(date), date });
      // Advance anchor index past this date
      while (anchorIdx < anchors.length - 1 && toEpoch(date) >= anchors[anchorIdx].epoch) {
        anchorIdx++;
      }
      continue;
    }

    const epoch = toEpoch(date);

    // Find surrounding anchors
    let left = null;
    let right = null;
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].epoch <= epoch) left = anchors[i];
      if (anchors[i].epoch > epoch && !right) right = anchors[i];
    }

    if (left && right && right.epoch !== left.epoch) {
      const t = (epoch - left.epoch) / (right.epoch - left.epoch);
      result.push({
        date,
        signal: left.signal + t * (right.signal - left.signal),
        price: left.price != null && right.price != null
          ? left.price + t * (right.price - left.price)
          : (left.price || right.price),
        _filled: "interpolate",
      });
    } else if (left) {
      result.push({ date, signal: left.signal, price: left.price, _filled: "forward" });
    } else {
      result.push({ date, signal: 0, price: null, _filled: "zero" });
    }
  }

  return result;
}

// ─── getSignalOverlap ───────────────────────────────────────

/**
 * Report overlap statistics across signal sets.
 *
 * @param {Array} signalSets - Array of { name, signals: [{ date, ... }] }
 * @returns {{ overlapCount, unionCount, overlapPct, perSource: Object, dateRange }}
 */
export function getSignalOverlap(signalSets) {
  if (!signalSets || signalSets.length === 0) {
    return { overlapCount: 0, unionCount: 0, overlapPct: 0, perSource: {}, dateRange: null };
  }

  const sourceDateSets = signalSets.map((src) => {
    const s = new Set();
    for (const sig of src.signals) s.add(normalizeDate(sig.date));
    return s;
  });

  // Union of all dates
  const unionDates = new Set();
  for (const s of sourceDateSets) {
    for (const d of s) unionDates.add(d);
  }

  // Intersection of all dates
  let intersectionDates = sourceDateSets[0];
  for (let i = 1; i < sourceDateSets.length; i++) {
    intersectionDates = new Set([...intersectionDates].filter((d) => sourceDateSets[i].has(d)));
  }

  const unionCount = unionDates.size;
  const overlapCount = intersectionDates.size;
  const overlapPct = unionCount > 0 ? overlapCount / unionCount : 0;

  // Per-source coverage relative to union
  const perSource = {};
  for (let i = 0; i < signalSets.length; i++) {
    const name = signalSets[i].name || `source_${i}`;
    const count = sourceDateSets[i].size;
    perSource[name] = {
      dateCount: count,
      coveragePct: unionCount > 0 ? count / unionCount : 0,
      missingCount: unionCount - count,
      firstDate: [...sourceDateSets[i]].sort()[0] || null,
      lastDate: [...sourceDateSets[i]].sort().pop() || null,
    };
  }

  const allSorted = [...unionDates].sort();
  const dateRange = allSorted.length > 0
    ? { start: allSorted[0], end: allSorted[allSorted.length - 1] }
    : null;

  return { overlapCount, unionCount, overlapPct, perSource, dateRange };
}

// ─── Regime-Based Alignment Method ──────────────────────────

/**
 * Select alignment method based on market regime.
 * High volatility => 'intersection' (conservative, only trade when all agents agree on dates)
 * Low volatility  => 'union' (aggressive, use all available signal dates)
 * Medium / unknown => 'union' (default)
 *
 * @param {Object} regimes - Output from detectAllRegimes or { volatility: { regime } }
 * @returns {string} 'intersection' | 'union'
 */
export function getRegimeAlignmentMethod(regimes) {
  if (!regimes) return "union";

  const volRegime = regimes.volatility?.regime || regimes.regime || "medium_vol";

  if (volRegime === "high_vol") {
    return "intersection";
  }

  return "union";
}
