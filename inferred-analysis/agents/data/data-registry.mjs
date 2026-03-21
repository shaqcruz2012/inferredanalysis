#!/usr/bin/env node
/**
 * Data Registry — Symbol & Data Status Tracker
 *
 * Maintains a persistent registry of all symbols and their data status,
 * enabling the system to know what data is available, how fresh it is,
 * and its quality score.
 *
 * The registry is stored as a JSON file alongside the cache directory.
 *
 * Usage:
 *   node agents/data/data-registry.mjs                # Show all registered symbols
 *   node agents/data/data-registry.mjs --register SPY # Register a new symbol
 *   node agents/data/data-registry.mjs --scan         # Scan cache and update registry
 *
 * Exports:
 *   getAvailableSymbols()    — returns array of registered symbols with status
 *   getDataStatus(symbol)    — returns detailed status for one symbol
 *   registerNewSymbol(symbol, opts) — register a symbol and optionally fetch data
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "cache");
const REGISTRY_PATH = join(__dirname, "cache", "registry.json");

// ─── Registry Persistence ────────────────────────────────

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { symbols: {}, updatedAt: null };
  }
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return { symbols: {}, updatedAt: null };
  }
}

function saveRegistry(registry) {
  ensureCacheDir();
  registry.updatedAt = new Date().toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// ─── Asset Classification ────────────────────────────────

const ASSET_CLASSES = {
  // Equities
  AAPL: "equity", MSFT: "equity", GOOGL: "equity", AMZN: "equity",
  TSLA: "equity", META: "equity", NVDA: "equity", AMD: "equity",
  // ETFs
  SPY: "etf", QQQ: "etf", IWM: "etf", TLT: "etf", GLD: "etf",
  XLF: "etf", XLE: "etf", XLK: "etf", VXX: "etf", HYG: "etf",
  EEM: "etf", DIA: "etf", IEF: "etf", LQD: "etf", SLV: "etf",
  // Crypto
  BTC: "crypto", ETH: "crypto", SOL: "crypto", DOGE: "crypto",
  ADA: "crypto", DOT: "crypto", AVAX: "crypto", LINK: "crypto",
  UNI: "crypto", ATOM: "crypto", XRP: "crypto", LTC: "crypto",
  BNB: "crypto", ARB: "crypto", OP: "crypto",
  // Macro
  GDP: "macro", CPI: "macro", VIX: "macro", UNEMPLOYMENT: "macro",
  FED_FUNDS: "macro", "10Y_YIELD": "macro", "2Y_YIELD": "macro",
  M2: "macro", PAYROLLS: "macro",
};

function classifyAsset(symbol) {
  const upper = symbol.toUpperCase();
  if (ASSET_CLASSES[upper]) return ASSET_CLASSES[upper];
  if (upper.endsWith("-USD")) return "crypto";
  if (/^[A-Z]{1,5}$/.test(upper)) return "equity";
  return "unknown";
}

// ─── Cache Scanning ──────────────────────────────────────

/**
 * Scan the cache directory and update the registry with found data.
 */
function scanCache() {
  ensureCacheDir();
  const registry = loadRegistry();
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json") && f !== "registry.json");

  let updated = 0;

  for (const f of files) {
    try {
      const fpath = join(CACHE_DIR, f);
      const data = JSON.parse(readFileSync(fpath, "utf-8"));
      const symbol = data.symbol;
      if (!symbol) continue;

      const canonical = symbol.toUpperCase();
      const priceCount = data.prices?.length || data.data?.length || data.count || 0;
      const fetchedAt = data.fetchedAt || 0;

      // Compute a quality score (0-100)
      let quality = 50; // base
      if (priceCount > 500) quality += 20;
      else if (priceCount > 100) quality += 10;
      if (priceCount > 1000) quality += 10;
      if (data.source === "yahoo" || data.source === "fred" || data.source === "coingecko") quality += 15;
      if (Date.now() - fetchedAt < 24 * 60 * 60 * 1000) quality += 5; // fresh data bonus

      // Check for data integrity
      const prices = data.prices || [];
      if (prices.length > 0) {
        const hasAllFields = prices.every(
          (p) => p.date && typeof p.close === "number" && !isNaN(p.close)
        );
        if (hasAllFields) quality += 5;
        else quality -= 10;

        // Check for consecutive identical closes (stale data)
        let staleRun = 0;
        let maxStaleRun = 0;
        for (let i = 1; i < prices.length; i++) {
          if (prices[i].close === prices[i - 1].close) {
            staleRun++;
            maxStaleRun = Math.max(maxStaleRun, staleRun);
          } else {
            staleRun = 0;
          }
        }
        if (maxStaleRun > 5) quality -= 15;
        else if (maxStaleRun > 3) quality -= 5;
      }

      quality = Math.max(0, Math.min(100, quality));

      const entry = {
        symbol: canonical,
        asset_class: classifyAsset(canonical),
        last_updated: fetchedAt ? new Date(fetchedAt).toISOString() : null,
        last_updated_ts: fetchedAt,
        data_points_count: priceCount,
        source: data.source || "unknown",
        quality_score: quality,
        cache_file: f,
        interval: data.interval || "1d",
        date_range: {
          start: data.startDate || (prices.length > 0 ? prices[0].date : null),
          end: data.endDate || (prices.length > 0 ? prices[prices.length - 1].date : null),
        },
        registered_at: registry.symbols[canonical]?.registered_at || new Date().toISOString(),
      };

      registry.symbols[canonical] = entry;
      updated++;
    } catch {
      // Skip files that can't be parsed
    }
  }

  saveRegistry(registry);
  return { scanned: files.length, updated };
}

// ─── Public API ──────────────────────────────────────────

/**
 * Get all available symbols with their current data status.
 *
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.asset_class] - Filter by asset class ("equity", "etf", "crypto", "macro")
 * @param {number} [filters.min_quality] - Minimum quality score (0-100)
 * @param {boolean} [filters.fresh_only] - Only include data updated in last 24h
 * @returns {Array<{symbol, asset_class, last_updated, data_points_count, source, quality_score}>}
 */
export function getAvailableSymbols(filters = {}) {
  // Scan cache on every call to stay current
  scanCache();

  const registry = loadRegistry();
  let entries = Object.values(registry.symbols);

  if (filters.asset_class) {
    entries = entries.filter((e) => e.asset_class === filters.asset_class);
  }

  if (filters.min_quality != null) {
    entries = entries.filter((e) => e.quality_score >= filters.min_quality);
  }

  if (filters.fresh_only) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    entries = entries.filter((e) => e.last_updated_ts > cutoff);
  }

  // Sort by quality score descending, then alphabetically
  entries.sort((a, b) => {
    if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
    return a.symbol.localeCompare(b.symbol);
  });

  return entries.map((e) => ({
    symbol: e.symbol,
    asset_class: e.asset_class,
    last_updated: e.last_updated,
    data_points_count: e.data_points_count,
    source: e.source,
    quality_score: e.quality_score,
  }));
}

/**
 * Get detailed data status for a specific symbol.
 *
 * @param {string} symbol
 * @returns {{ found: boolean, symbol: string, status: Object | null }}
 */
export function getDataStatus(symbol) {
  scanCache();

  const registry = loadRegistry();
  const canonical = symbol.toUpperCase();
  const entry = registry.symbols[canonical];

  if (!entry) {
    return {
      found: false,
      symbol: canonical,
      status: null,
      suggestion: `Symbol ${canonical} not in registry. Call registerNewSymbol("${canonical}") to add it.`,
    };
  }

  const now = Date.now();
  const age = entry.last_updated_ts ? now - entry.last_updated_ts : Infinity;
  const isFresh = age < 24 * 60 * 60 * 1000;
  const isStale = age > 7 * 24 * 60 * 60 * 1000;

  return {
    found: true,
    symbol: canonical,
    status: {
      ...entry,
      freshness: isFresh ? "fresh" : isStale ? "stale" : "aging",
      age_hours: +(age / 3600000).toFixed(1),
      needs_refresh: !isFresh,
    },
  };
}

/**
 * Register a new symbol in the registry.
 * This records the symbol for tracking. Data is not fetched automatically
 * unless `opts.fetch` is true.
 *
 * @param {string} symbol
 * @param {Object} [opts]
 * @param {string} [opts.asset_class] - Override auto-detected asset class
 * @param {string} [opts.source] - Preferred data source
 * @param {boolean} [opts.fetch=false] - Whether to immediately fetch data
 * @returns {{ registered: boolean, symbol: string, entry: Object }}
 */
export function registerNewSymbol(symbol, opts = {}) {
  const registry = loadRegistry();
  const canonical = symbol.toUpperCase();

  const existing = registry.symbols[canonical];
  if (existing) {
    return {
      registered: false,
      symbol: canonical,
      message: "Symbol already registered",
      entry: existing,
    };
  }

  const entry = {
    symbol: canonical,
    asset_class: opts.asset_class || classifyAsset(canonical),
    last_updated: null,
    last_updated_ts: 0,
    data_points_count: 0,
    source: opts.source || "pending",
    quality_score: 0,
    cache_file: null,
    interval: "1d",
    date_range: { start: null, end: null },
    registered_at: new Date().toISOString(),
  };

  registry.symbols[canonical] = entry;
  saveRegistry(registry);

  return {
    registered: true,
    symbol: canonical,
    message: `Symbol ${canonical} registered as ${entry.asset_class}`,
    entry,
  };
}

/**
 * Remove a symbol from the registry.
 * Does NOT delete cached data files.
 *
 * @param {string} symbol
 * @returns {{ removed: boolean, symbol: string }}
 */
export function unregisterSymbol(symbol) {
  const registry = loadRegistry();
  const canonical = symbol.toUpperCase();

  if (!registry.symbols[canonical]) {
    return { removed: false, symbol: canonical, message: "Symbol not found in registry" };
  }

  delete registry.symbols[canonical];
  saveRegistry(registry);
  return { removed: true, symbol: canonical };
}

/**
 * Get a summary of the registry.
 *
 * @returns {{ total: number, by_class: Object, by_source: Object, avg_quality: number }}
 */
export function getRegistrySummary() {
  scanCache();
  const registry = loadRegistry();
  const entries = Object.values(registry.symbols);

  const byClass = {};
  const bySource = {};
  let totalQuality = 0;

  for (const e of entries) {
    byClass[e.asset_class] = (byClass[e.asset_class] || 0) + 1;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    totalQuality += e.quality_score;
  }

  return {
    total: entries.length,
    by_class: byClass,
    by_source: bySource,
    avg_quality: entries.length > 0 ? +(totalQuality / entries.length).toFixed(1) : 0,
    updated_at: registry.updatedAt,
  };
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--scan")) {
    console.log("Scanning cache directory...");
    const result = scanCache();
    console.log(`  Scanned ${result.scanned} files, updated ${result.updated} registry entries.`);
    const summary = getRegistrySummary();
    console.log(`  Total symbols: ${summary.total}`);
    console.log(`  By class: ${JSON.stringify(summary.by_class)}`);
    console.log(`  Avg quality: ${summary.avg_quality}`);
    return;
  }

  if (args.includes("--register")) {
    const symbols = args.filter((a) => !a.startsWith("--"));
    for (const sym of symbols) {
      const result = registerNewSymbol(sym);
      console.log(`  ${result.symbol}: ${result.message}`);
    }
    return;
  }

  if (args.includes("--status")) {
    const symbols = args.filter((a) => !a.startsWith("--"));
    for (const sym of symbols) {
      const result = getDataStatus(sym);
      if (result.found) {
        const s = result.status;
        console.log(`  ${s.symbol.padEnd(10)} ${s.asset_class.padEnd(8)} ${String(s.data_points_count).padStart(6)} pts  q=${s.quality_score}  ${s.freshness}  src=${s.source}`);
      } else {
        console.log(`  ${result.symbol.padEnd(10)} NOT FOUND — ${result.suggestion}`);
      }
    }
    return;
  }

  // Default: list all symbols
  const symbols = getAvailableSymbols();
  if (symbols.length === 0) {
    console.log("Registry is empty. Run --scan to populate from cache, or --register SYMBOL to add.");
    return;
  }

  console.log("\nData Registry:");
  console.log(`${"  Symbol".padEnd(12)} ${"Class".padEnd(8)} ${"Points".padStart(8)} ${"Quality".padStart(8)} ${"Source".padEnd(12)} Last Updated`);
  console.log("  " + "-".repeat(72));
  for (const s of symbols) {
    const lastUp = s.last_updated ? s.last_updated.slice(0, 19) : "never";
    console.log(
      `  ${s.symbol.padEnd(10)} ${s.asset_class.padEnd(8)} ${String(s.data_points_count).padStart(8)} ${String(s.quality_score).padStart(8)} ${s.source.padEnd(12)} ${lastUp}`
    );
  }

  const summary = getRegistrySummary();
  console.log(`\n  Total: ${summary.total} symbols | Avg quality: ${summary.avg_quality}`);
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith("data-registry.mjs") ||
  process.argv[1].endsWith("data-registry")
);

if (isMain) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
