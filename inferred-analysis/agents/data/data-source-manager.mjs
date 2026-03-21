#!/usr/bin/env node
/**
 * Data Source Manager — Synthetic-to-Real Migration Layer
 *
 * Central routing layer that controls all price data access. Tracks synthetic
 * data usage and provides a clear migration path to 100% real data.
 *
 * EVERY module should import getPrices from here instead of directly using
 * generateRealisticPrices(). This module ensures:
 *   1. Real cached data is preferred
 *   2. Real-time API fetch is tried when cache is stale
 *   3. Synthetic fallback is logged and tracked
 *
 * Exports:
 *   getPrices(symbol, options)       — single entry point for all price data
 *   trackSyntheticUsage(...)         — record a synthetic data event
 *   getSyntheticUsageReport()        — full log of synthetic usage
 *   getMigrationStatus()             — real vs synthetic call percentages
 *   getMigrationPlan()               — ordered list of modules to migrate
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_LOG_PATH = join(__dirname, "synthetic-usage-log.json");
const CACHE_DIR = join(__dirname, "cache");

// ─── Synthetic Usage State ──────────────────────────────

/** In-memory usage counters for the current process lifetime. */
const _sessionStats = {
  totalCalls: 0,
  realCalls: 0,
  cacheCalls: 0,
  syntheticCalls: 0,
  startedAt: new Date().toISOString(),
};

/**
 * Load the persistent synthetic usage log from disk.
 * Returns an array of usage records.
 */
function _loadUsageLog() {
  try {
    if (existsSync(USAGE_LOG_PATH)) {
      const raw = readFileSync(USAGE_LOG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    // Corrupted log — start fresh
  }
  return [];
}

/**
 * Save the usage log to disk atomically.
 */
function _saveUsageLog(log) {
  try {
    mkdirSync(dirname(USAGE_LOG_PATH), { recursive: true });
    writeFileSync(USAGE_LOG_PATH, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error(`[data-source-manager] Failed to write usage log: ${err.message}`);
  }
}

// ─── Data Source Detection ──────────────────────────────

/**
 * Check if real cached data exists for a symbol and is not stale.
 * Returns { valid: boolean, prices: array|null, age: number|null }
 */
function _checkCache(symbol, maxAgeMs = 24 * 60 * 60 * 1000) {
  const cachePath = join(CACHE_DIR, `${symbol.toUpperCase()}.json`);

  if (!existsSync(cachePath)) {
    return { valid: false, prices: null, age: null };
  }

  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    const age = Date.now() - (cached.fetchedAt || 0);
    const valid = age < maxAgeMs && Array.isArray(cached.prices) && cached.prices.length > 0;

    return {
      valid,
      prices: cached.prices,
      age,
      stale: age >= maxAgeMs,
      count: cached.prices?.length || 0,
    };
  } catch {
    return { valid: false, prices: null, age: null };
  }
}

/**
 * Compute a quality score (0-100) for a price dataset.
 *   100 = fresh real data with high bar count
 *   50  = stale cache
 *   10  = synthetic data
 */
function _computeQuality(source, prices, cacheAge) {
  if (!prices || prices.length === 0) return 0;

  let score = 0;

  // Source weight
  if (source === "real") score += 50;
  else if (source === "cache") score += 35;
  else score += 5; // synthetic

  // Data volume: more bars = better, up to 30 pts
  const barScore = Math.min(30, (prices.length / 1000) * 30);
  score += barScore;

  // Freshness: recent data gets up to 20 pts
  if (cacheAge !== null && cacheAge !== undefined) {
    const hoursOld = cacheAge / (1000 * 60 * 60);
    const freshnessScore = Math.max(0, 20 - hoursOld * 0.5);
    score += freshnessScore;
  } else if (source === "real") {
    score += 20; // just fetched
  }

  return Math.round(Math.min(100, score));
}

// ─── Public API: Data Source Router ─────────────────────

/**
 * Single entry point for ALL price data access.
 *
 * Decision logic:
 *   1. Try real cached data first (from historical storage)
 *   2. Try real-time API fetch if cache is stale
 *   3. ONLY fall back to synthetic if no real data exists, AND log a warning
 *
 * @param {string} symbol - Ticker symbol (e.g., "SPY")
 * @param {object} [options]
 * @param {string}  options.callerModule   - Name of the calling module for tracking
 * @param {boolean} options.forceRefresh   - Skip cache, fetch fresh data
 * @param {string}  options.startDate      - Start date for synthetic fallback (YYYY-MM-DD)
 * @param {string}  options.endDate        - End date for synthetic fallback (YYYY-MM-DD)
 * @param {number}  options.cacheTTL       - Custom cache TTL in ms
 * @param {number}  options.priority       - Priority level for API requests
 * @returns {Promise<{prices: Array, source: string, quality: number, warning: string|null}>}
 */
export async function getPrices(symbol, options = {}) {
  const {
    callerModule = "unknown",
    forceRefresh = false,
    startDate = "2020-01-01",
    endDate = "2025-03-01",
    cacheTTL = 24 * 60 * 60 * 1000,
    priority,
  } = options;

  symbol = symbol.toUpperCase();
  _sessionStats.totalCalls++;

  // ── Step 1: Check cache ────────────────────────────
  if (!forceRefresh) {
    const cache = _checkCache(symbol, cacheTTL);

    if (cache.valid && cache.prices) {
      _sessionStats.cacheCalls++;
      return {
        prices: cache.prices,
        source: "cache",
        quality: _computeQuality("cache", cache.prices, cache.age),
        warning: null,
      };
    }

    // Stale cache: still usable but we should try to refresh
    if (cache.stale && cache.prices && cache.prices.length > 0) {
      // Try API fetch, but fall back to stale cache (not synthetic)
      try {
        const freshPrices = await _fetchFromAPI(symbol, priority);
        if (freshPrices && freshPrices.length > 0) {
          _sessionStats.realCalls++;
          return {
            prices: freshPrices,
            source: "real",
            quality: _computeQuality("real", freshPrices, 0),
            warning: null,
          };
        }
      } catch {
        // API failed — use stale cache rather than synthetic
        _sessionStats.cacheCalls++;
        return {
          prices: cache.prices,
          source: "cache",
          quality: _computeQuality("cache", cache.prices, cache.age),
          warning: `Using stale cache for ${symbol} (${Math.round(cache.age / 3600000)}h old). API fetch failed.`,
        };
      }
    }
  }

  // ── Step 2: Try real-time API fetch ────────────────
  try {
    const freshPrices = await _fetchFromAPI(symbol, priority);
    if (freshPrices && freshPrices.length > 0) {
      _sessionStats.realCalls++;
      return {
        prices: freshPrices,
        source: "real",
        quality: _computeQuality("real", freshPrices, 0),
        warning: null,
      };
    }
  } catch {
    // API unavailable — fall through to synthetic
  }

  // ── Step 3: Synthetic fallback (last resort) ───────
  console.warn(
    `[data-source-manager] WARNING: Falling back to synthetic data for ${symbol}. ` +
    `Caller: ${callerModule}. No real data available.`
  );

  _sessionStats.syntheticCalls++;

  // Lazy-import to avoid circular dependency at module load time
  const { generateRealisticPrices } = await import("./fetch.mjs");
  const syntheticPrices = generateRealisticPrices(symbol, startDate, endDate);

  // Track this synthetic usage
  trackSyntheticUsage(callerModule, symbol, "No real data available — API and cache both failed");

  return {
    prices: syntheticPrices,
    source: "synthetic",
    quality: _computeQuality("synthetic", syntheticPrices, null),
    warning: `SYNTHETIC DATA for ${symbol}. Results are NOT based on real market data. Migrate to real data ASAP.`,
  };
}

/**
 * Attempt to fetch real price data from the API via the existing fetch module.
 * Returns prices array or throws.
 */
async function _fetchFromAPI(symbol, priority) {
  // Lazy import to avoid circular dependency
  const fetchModule = await import("./fetch.mjs");
  const fetchGetPrices = fetchModule.getPrices;

  // Call the original fetch.mjs getPrices with forceRefresh=true
  // to get real API data (it handles its own cache writing)
  const prices = await fetchGetPrices(symbol, true, { priority });
  return prices;
}

// ─── Public API: Synthetic Usage Tracker ────────────────

/**
 * Record a synthetic data usage event.
 *
 * @param {string} callerModule - Module name (e.g., "trend-following")
 * @param {string} symbol       - Ticker that needed synthetic data
 * @param {string} reason       - Why synthetic data was used
 */
export function trackSyntheticUsage(callerModule, symbol, reason) {
  const record = {
    module: callerModule,
    symbol: symbol.toUpperCase(),
    timestamp: new Date().toISOString(),
    reason: reason || "unspecified",
    migrated: false,
  };

  const log = _loadUsageLog();
  log.push(record);

  // Cap log at 10000 entries to prevent unbounded growth
  if (log.length > 10000) {
    log.splice(0, log.length - 10000);
  }

  _saveUsageLog(log);
}

/**
 * Get the full synthetic usage report.
 * Returns all logged synthetic data events, with summary stats.
 */
export function getSyntheticUsageReport() {
  const log = _loadUsageLog();

  // Compute summary by module
  const byModule = {};
  const bySymbol = {};

  for (const entry of log) {
    const mod = entry.module || "unknown";
    const sym = entry.symbol || "unknown";

    if (!byModule[mod]) byModule[mod] = { count: 0, symbols: new Set(), lastUsed: null };
    byModule[mod].count++;
    byModule[mod].symbols.add(sym);
    byModule[mod].lastUsed = entry.timestamp;

    if (!bySymbol[sym]) bySymbol[sym] = { count: 0, modules: new Set() };
    bySymbol[sym].count++;
    bySymbol[sym].modules.add(mod);
  }

  // Serialize Sets for JSON output
  const moduleSummary = {};
  for (const [mod, data] of Object.entries(byModule)) {
    moduleSummary[mod] = {
      count: data.count,
      symbols: [...data.symbols],
      lastUsed: data.lastUsed,
    };
  }

  const symbolSummary = {};
  for (const [sym, data] of Object.entries(bySymbol)) {
    symbolSummary[sym] = {
      count: data.count,
      modules: [...data.modules],
    };
  }

  return {
    totalEvents: log.length,
    uniqueModules: Object.keys(byModule).length,
    uniqueSymbols: Object.keys(bySymbol).length,
    byModule: moduleSummary,
    bySymbol: symbolSummary,
    migratedCount: log.filter(e => e.migrated).length,
    pendingCount: log.filter(e => !e.migrated).length,
    entries: log,
  };
}

// ─── Public API: Migration Helper ───────────────────────

/**
 * Known modules in the codebase that use generateRealisticPrices.
 * Categorized by type for migration priority ordering.
 */
const KNOWN_SYNTHETIC_CONSUMERS = [
  // High-frequency strategies (migrate first — highest impact)
  { module: "hf_quant", type: "strategy", frequency: "high", path: "strategies/hf_quant.js" },
  { module: "stat_arb_quant", type: "strategy", frequency: "high", path: "strategies/stat_arb_quant.js" },
  { module: "market-making", type: "strategy", frequency: "high", path: "strategies/market-making.mjs" },
  { module: "intraday-patterns", type: "strategy", frequency: "high", path: "strategies/intraday-patterns.mjs" },
  { module: "microstructure_researcher", type: "strategy", frequency: "high", path: "strategies/microstructure_researcher.js" },

  // Core strategies (migrate second)
  { module: "trend-following", type: "strategy", frequency: "medium", path: "strategies/trend-following.mjs" },
  { module: "mean-reversion-pairs", type: "strategy", frequency: "medium", path: "strategies/mean-reversion-pairs.mjs" },
  { module: "cross-asset-momentum", type: "strategy", frequency: "medium", path: "strategies/cross-asset-momentum.mjs" },
  { module: "crypto-momentum", type: "strategy", frequency: "medium", path: "strategies/crypto-momentum.mjs" },
  { module: "carry-trade", type: "strategy", frequency: "medium", path: "strategies/carry-trade.mjs" },
  { module: "fx-carry", type: "strategy", frequency: "medium", path: "strategies/fx-carry.mjs" },
  { module: "dispersion-trade", type: "strategy", frequency: "medium", path: "strategies/dispersion-trade.mjs" },
  { module: "volatility-surface", type: "strategy", frequency: "medium", path: "strategies/volatility-surface.mjs" },
  { module: "mean-variance-timing", type: "strategy", frequency: "medium", path: "strategies/mean-variance-timing.mjs" },
  { module: "fractal-market", type: "strategy", frequency: "medium", path: "strategies/fractal-market.mjs" },
  { module: "hmm-regime", type: "strategy", frequency: "medium", path: "strategies/hmm-regime.mjs" },
  { module: "kalman-tracker", type: "strategy", frequency: "medium", path: "strategies/kalman-tracker.mjs" },
  { module: "event-study", type: "strategy", frequency: "medium", path: "strategies/event-study.mjs" },
  { module: "sentiment-analyzer", type: "strategy", frequency: "medium", path: "strategies/sentiment-analyzer.mjs" },
  { module: "universe-scanner", type: "strategy", frequency: "medium", path: "strategies/universe-scanner.mjs" },
  { module: "vol_quant", type: "strategy", frequency: "medium", path: "strategies/vol_quant.js" },
  { module: "macro_quant", type: "strategy", frequency: "medium", path: "strategies/macro_quant.js" },
  { module: "econ_researcher", type: "strategy", frequency: "medium", path: "strategies/econ_researcher.js" },
  { module: "multi-timeframe", type: "strategy", frequency: "medium", path: "strategies/multi-timeframe.mjs" },

  // Backtesting infrastructure (migrate third)
  { module: "backtest-engine", type: "backtest", frequency: "medium", path: "trading/backtest-engine.mjs" },
  { module: "shared-backtest-engine", type: "backtest", frequency: "medium", path: "shared/backtest-engine.mjs" },
  { module: "backtests-template", type: "backtest", frequency: "low", path: "backtests/template.js" },
  { module: "smart-order-router", type: "backtest", frequency: "medium", path: "trading/smart-order-router.mjs" },

  // Risk modules
  { module: "tail-hedger", type: "risk", frequency: "medium", path: "risk/tail-hedger.mjs" },
  { module: "factor-model", type: "risk", frequency: "medium", path: "risk/factor-model.mjs" },
  { module: "extreme-value", type: "risk", frequency: "low", path: "risk/extreme-value.mjs" },
  { module: "correlation-regime", type: "risk", frequency: "low", path: "risk/correlation-regime.mjs" },

  // Ensemble
  { module: "run-ensemble", type: "ensemble", frequency: "medium", path: "ensemble/run-ensemble.mjs" },
  { module: "regime-detector", type: "ensemble", frequency: "low", path: "ensemble/regime-detector.mjs" },
  { module: "signal-blender", type: "ensemble", frequency: "low", path: "ensemble/signal-blender.mjs" },
  { module: "strategy-combiner", type: "ensemble", frequency: "low", path: "ensemble/strategy-combiner.mjs" },
  { module: "multi-horizon", type: "ensemble", frequency: "low", path: "ensemble/multi-horizon.mjs" },

  // Optimizer modules
  { module: "monte-carlo", type: "optimizer", frequency: "low", path: "optimizer/monte-carlo.mjs" },
  { module: "covariance-forecast", type: "optimizer", frequency: "low", path: "optimizer/covariance-forecast.mjs" },
  { module: "walk-forward", type: "optimizer", frequency: "low", path: "optimizer/walk-forward.mjs" },
  { module: "walk-forward-optimizer", type: "optimizer", frequency: "low", path: "optimizer/walk-forward-optimizer.mjs" },
  { module: "genetic-strategy", type: "optimizer", frequency: "low", path: "optimizer/genetic-strategy.mjs" },
  { module: "feature-importance", type: "optimizer", frequency: "low", path: "optimizer/feature-importance.mjs" },
  { module: "signal-decay", type: "optimizer", frequency: "low", path: "optimizer/signal-decay.mjs" },
  { module: "rl-sizer", type: "optimizer", frequency: "low", path: "optimizer/rl-sizer.mjs" },
  { module: "adaptive-params", type: "optimizer", frequency: "low", path: "optimizer/adaptive-params.mjs" },

  // Management / reporting (migrate last — lowest impact on revenue)
  { module: "performance-attribution", type: "research", frequency: "low", path: "management/performance-attribution.mjs" },
  { module: "strategy-correlation", type: "research", frequency: "low", path: "management/strategy-correlation.mjs" },
  { module: "benchmark-comparison", type: "research", frequency: "low", path: "management/benchmark-comparison.mjs" },
  { module: "report-card", type: "research", frequency: "low", path: "management/report-card.mjs" },
  { module: "ascii-charts", type: "research", frequency: "low", path: "management/ascii-charts.mjs" },
  { module: "portfolio-dashboard", type: "research", frequency: "low", path: "management/portfolio-dashboard.mjs" },
  { module: "quality-checker", type: "research", frequency: "low", path: "data/quality-checker.mjs" },

  // Data modules (internal — synthetic lives here, wrap last)
  { module: "streaming", type: "data", frequency: "high", path: "data/streaming.mjs" },
  { module: "onchain-metrics", type: "data", frequency: "low", path: "data/onchain-metrics.mjs" },
];

/**
 * Get migration status: percentage of calls using real vs synthetic data.
 * Combines session stats (current process) with historical log.
 */
export function getMigrationStatus() {
  const log = _loadUsageLog();
  const totalHistoricSynthetic = log.filter(e => !e.migrated).length;
  const totalHistoricMigrated = log.filter(e => e.migrated).length;

  const sessionTotal = _sessionStats.totalCalls || 1; // avoid div-by-zero

  return {
    session: {
      totalCalls: _sessionStats.totalCalls,
      realCalls: _sessionStats.realCalls,
      cacheCalls: _sessionStats.cacheCalls,
      syntheticCalls: _sessionStats.syntheticCalls,
      realPct: ((_sessionStats.realCalls + _sessionStats.cacheCalls) / sessionTotal * 100).toFixed(1) + "%",
      syntheticPct: (_sessionStats.syntheticCalls / sessionTotal * 100).toFixed(1) + "%",
      startedAt: _sessionStats.startedAt,
    },
    historical: {
      totalSyntheticEvents: log.length,
      pendingMigration: totalHistoricSynthetic,
      alreadyMigrated: totalHistoricMigrated,
      migrationPct: log.length > 0
        ? (totalHistoricMigrated / log.length * 100).toFixed(1) + "%"
        : "N/A (no events logged)",
    },
    knownConsumers: KNOWN_SYNTHETIC_CONSUMERS.length,
  };
}

/**
 * Get a prioritized migration plan.
 * Orders modules by impact: high-frequency strategies first, then backtests,
 * then risk, then research/management.
 *
 * @returns {Array<{module, type, frequency, path, priority, status, syntheticEvents}>}
 */
export function getMigrationPlan() {
  const log = _loadUsageLog();

  // Count synthetic events per module from the log
  const eventCounts = {};
  for (const entry of log) {
    const mod = entry.module || "unknown";
    eventCounts[mod] = (eventCounts[mod] || 0) + 1;
  }

  // Priority scoring: lower number = migrate first
  const typePriority = {
    strategy: 1,
    backtest: 2,
    risk: 3,
    ensemble: 4,
    optimizer: 5,
    research: 6,
    data: 7,
  };

  const freqPriority = {
    high: 0,
    medium: 10,
    low: 20,
  };

  const plan = KNOWN_SYNTHETIC_CONSUMERS.map(consumer => {
    const syntheticEvents = eventCounts[consumer.module] || 0;
    const priorityScore = (typePriority[consumer.type] || 99) * 100
      + (freqPriority[consumer.frequency] || 50)
      - Math.min(syntheticEvents, 50); // more events = higher urgency

    return {
      module: consumer.module,
      type: consumer.type,
      frequency: consumer.frequency,
      path: consumer.path,
      priority: priorityScore,
      syntheticEvents,
      status: syntheticEvents > 0 ? "active-synthetic" : "not-yet-tracked",
      action: `Replace generateRealisticPrices() calls with: import { getPrices } from "../data/data-source-manager.mjs"`,
    };
  });

  // Sort by priority (ascending = highest priority first)
  plan.sort((a, b) => a.priority - b.priority);

  // Add rank
  return plan.map((item, index) => ({
    rank: index + 1,
    ...item,
  }));
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Data Source Manager — Synthetic-to-Real Migration");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  if (command === "status") {
    const status = getMigrationStatus();
    console.log("  Session Stats:");
    console.log(`    Total calls:     ${status.session.totalCalls}`);
    console.log(`    Real data:       ${status.session.realCalls} (${status.session.realPct})`);
    console.log(`    Cached data:     ${status.session.cacheCalls}`);
    console.log(`    Synthetic data:  ${status.session.syntheticCalls} (${status.session.syntheticPct})`);
    console.log("");
    console.log("  Historical Log:");
    console.log(`    Total synthetic events: ${status.historical.totalSyntheticEvents}`);
    console.log(`    Pending migration:      ${status.historical.pendingMigration}`);
    console.log(`    Already migrated:       ${status.historical.alreadyMigrated}`);
    console.log(`    Migration progress:     ${status.historical.migrationPct}`);
    console.log("");
    console.log(`  Known synthetic consumers: ${status.knownConsumers} modules`);
  }

  if (command === "report") {
    const report = getSyntheticUsageReport();
    console.log(`  Total synthetic events: ${report.totalEvents}`);
    console.log(`  Unique modules:         ${report.uniqueModules}`);
    console.log(`  Unique symbols:         ${report.uniqueSymbols}`);
    console.log("");

    if (report.totalEvents > 0) {
      console.log("  By Module:");
      for (const [mod, data] of Object.entries(report.byModule)) {
        console.log(`    ${mod.padEnd(30)} ${String(data.count).padStart(5)} events  symbols: ${data.symbols.join(", ")}`);
      }
      console.log("");
      console.log("  By Symbol:");
      for (const [sym, data] of Object.entries(report.bySymbol)) {
        console.log(`    ${sym.padEnd(8)} ${String(data.count).padStart(5)} events  modules: ${data.modules.join(", ")}`);
      }
    } else {
      console.log("  No synthetic usage events logged yet.");
      console.log("  Events will appear here once modules route through data-source-manager.");
    }
  }

  if (command === "plan") {
    const plan = getMigrationPlan();
    console.log("  Migration Plan (ordered by priority):\n");
    console.log(`  ${"Rank".padEnd(6)} ${"Module".padEnd(30)} ${"Type".padEnd(12)} ${"Freq".padEnd(8)} ${"Events".padStart(7)}  Status`);
    console.log(`  ${"─".repeat(6)} ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(7)}  ${"─".repeat(20)}`);

    for (const item of plan) {
      console.log(
        `  ${String(item.rank).padEnd(6)} ` +
        `${item.module.padEnd(30)} ` +
        `${item.type.padEnd(12)} ` +
        `${item.frequency.padEnd(8)} ` +
        `${String(item.syntheticEvents).padStart(7)}  ` +
        `${item.status}`
      );
    }

    console.log("");
    console.log("  To migrate a module:");
    console.log('    1. Replace: import { generateRealisticPrices } from "../data/fetch.mjs"');
    console.log('       With:    import { getPrices } from "../data/data-source-manager.mjs"');
    console.log('    2. Replace: const prices = generateRealisticPrices(symbol, start, end)');
    console.log('       With:    const { prices } = await getPrices(symbol, { callerModule: "module-name", startDate, endDate })');
    console.log("    3. Handle the metadata: source, quality, warning fields");
  }

  if (command === "test") {
    const symbol = args[1] || "SPY";
    console.log(`  Testing data source resolution for ${symbol}...\n`);

    const result = await getPrices(symbol, { callerModule: "cli-test" });
    console.log(`  Source:  ${result.source}`);
    console.log(`  Quality: ${result.quality}/100`);
    console.log(`  Bars:    ${result.prices.length}`);
    console.log(`  Warning: ${result.warning || "none"}`);
    if (result.prices.length > 0) {
      const first = result.prices[0];
      const last = result.prices[result.prices.length - 1];
      console.log(`  Range:   ${first.date} -> ${last.date}`);
      console.log(`  Last close: $${last.close}`);
    }
  }

  console.log("");
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("data-source-manager.mjs") ||
  process.argv[1].endsWith("data-source-manager")
);

if (isMain) {
  main().catch(err => {
    console.error("Data source manager error:", err.message);
    process.exit(1);
  });
}
