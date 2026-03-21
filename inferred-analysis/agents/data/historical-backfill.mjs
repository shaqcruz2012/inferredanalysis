#!/usr/bin/env node
/**
 * Historical Data Backfill System
 *
 * Downloads, stores, and serves real historical OHLCV data for backtesting.
 * Replaces synthetic data with persistent, incrementally-updated market data.
 *
 * Usage:
 *   node historical-backfill.mjs --backfill SPY,QQQ,BTC-USD --years 3
 *   node historical-backfill.mjs --backfill-all                          # All default symbols
 *   node historical-backfill.mjs --stats                                 # Storage stats
 *   node historical-backfill.mjs --symbols                               # List stored symbols
 *   node historical-backfill.mjs --range SPY                             # Date range for symbol
 *   node historical-backfill.mjs --update                                # Daily update all stored
 *
 * Exports: getStoredSymbols, getDataRange, loadHistorical, backfillSymbol,
 *          backfillAll, getStorageStats, scheduleDailyUpdate
 *
 * No external dependencies — uses native Node.js fetch and fs.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORICAL_DIR = join(__dirname, "historical");
const META_PATH = join(HISTORICAL_DIR, "_meta.json");
const API_KEY = process.env.ALPHA_VANTAGE_KEY || "9M9R6PT1SZCK6014";
const BASE_URL = "https://www.alphavantage.co/query";

// Rate limit: Alpha Vantage free tier = 5 calls/min, 25 calls/day for some keys.
// We use 15s between calls to stay safe.
const RATE_LIMIT_DELAY_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;

// ─── Default Symbol Universe ────────────────────────────

const DEFAULT_SYMBOLS = [
  "SPY", "QQQ", "IWM", "TLT", "GLD",
  "BTC-USD", "ETH-USD",
  "AAPL", "MSFT", "GOOGL", "AMZN", "META",
  "VIX",
];

const CRYPTO_SYMBOLS = new Set(["BTC-USD", "ETH-USD"]);

function isCrypto(symbol) {
  return CRYPTO_SYMBOLS.has(symbol.toUpperCase()) || symbol.toUpperCase().endsWith("-USD");
}

function defaultYears(symbol) {
  return isCrypto(symbol) ? 3 : 5;
}

// ─── Ensure Storage Directory ───────────────────────────

function ensureDir() {
  if (!existsSync(HISTORICAL_DIR)) {
    mkdirSync(HISTORICAL_DIR, { recursive: true });
  }
}

// ─── Metadata Tracking ─────────────────────────────────

function loadMeta() {
  if (!existsSync(META_PATH)) return {};
  try {
    return JSON.parse(readFileSync(META_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  ensureDir();
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

function updateSymbolMeta(symbol, updates) {
  const meta = loadMeta();
  meta[symbol] = { ...(meta[symbol] || {}), ...updates };
  saveMeta(meta);
}

function getSymbolMeta(symbol) {
  const meta = loadMeta();
  return meta[symbol.toUpperCase()] || null;
}

// ─── Fetch with Retry ───────────────────────────────────

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();

      // Alpha Vantage error responses
      if (data["Error Message"]) {
        throw new Error(`Alpha Vantage: ${data["Error Message"]}`);
      }
      if (data["Note"]) {
        // Rate limit hit — wait longer and retry
        const waitMs = RETRY_BACKOFF_BASE_MS * attempt * 4;
        console.log(`  Rate limited (attempt ${attempt}/${retries}). Waiting ${Math.round(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
      if (data["Information"]) {
        throw new Error(`Alpha Vantage: ${data["Information"]}`);
      }

      return data;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const waitMs = RETRY_BACKOFF_BASE_MS * attempt;
        console.log(`  Fetch failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${Math.round(waitMs / 1000)}s...`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Data Fetching (Alpha Vantage) ──────────────────────

/**
 * Fetch daily OHLCV for a traditional equity/ETF symbol.
 * Returns sorted array of {date, open, high, low, close, volume}.
 */
async function fetchEquityDaily(symbol) {
  const url = `${BASE_URL}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${API_KEY}`;
  console.log(`  Fetching ${symbol} daily data from Alpha Vantage...`);
  const data = await fetchWithRetry(url);

  const timeSeries = data["Time Series (Daily)"];
  if (!timeSeries) {
    throw new Error(`No daily data returned for ${symbol}. Response keys: ${Object.keys(data).join(", ")}`);
  }

  return Object.entries(timeSeries)
    .map(([date, v]) => ({
      date,
      open: parseFloat(v["1. open"]),
      high: parseFloat(v["2. high"]),
      low: parseFloat(v["3. low"]),
      close: parseFloat(v["4. close"]),
      volume: parseInt(v["5. volume"]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch daily OHLCV for a crypto symbol (e.g. BTC-USD).
 * Alpha Vantage uses DIGITAL_CURRENCY_DAILY with a different response format.
 */
async function fetchCryptoDaily(symbol) {
  // Extract the coin part: BTC-USD -> BTC
  const coin = symbol.split("-")[0];
  const market = "USD";
  const url = `${BASE_URL}?function=DIGITAL_CURRENCY_DAILY&symbol=${encodeURIComponent(coin)}&market=${market}&apikey=${API_KEY}`;
  console.log(`  Fetching ${symbol} (crypto) daily data from Alpha Vantage...`);
  const data = await fetchWithRetry(url);

  const timeSeries = data["Time Series (Digital Currency Daily)"];
  if (!timeSeries) {
    throw new Error(`No crypto daily data for ${symbol}. Response keys: ${Object.keys(data).join(", ")}`);
  }

  return Object.entries(timeSeries)
    .map(([date, v]) => ({
      date,
      open: parseFloat(v["1a. open (USD)"] || v["1. open"]),
      high: parseFloat(v["2a. high (USD)"] || v["2. high"]),
      low: parseFloat(v["3a. low (USD)"] || v["3. low"]),
      close: parseFloat(v["4a. close (USD)"] || v["4. close"]),
      volume: parseFloat(v["5. volume"] || v["6. volume"] || "0"),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch daily data for any symbol (auto-detects crypto vs equity).
 */
async function fetchDailyData(symbol) {
  symbol = symbol.toUpperCase();
  if (isCrypto(symbol)) {
    return await fetchCryptoDaily(symbol);
  }
  return await fetchEquityDaily(symbol);
}

// ─── File Path Helpers ──────────────────────────────────

function dataFilePath(symbol) {
  return join(HISTORICAL_DIR, `${symbol.toUpperCase()}_daily.json`);
}

// ─── Storage Manager ────────────────────────────────────

/**
 * List all locally stored symbols.
 * @returns {string[]} Array of symbol names.
 */
export function getStoredSymbols() {
  ensureDir();
  return readdirSync(HISTORICAL_DIR)
    .filter(f => f.endsWith("_daily.json"))
    .map(f => f.replace("_daily.json", ""));
}

/**
 * Get the date range of stored data for a symbol.
 * @param {string} symbol
 * @returns {{ earliest: string, latest: string, records: number } | null}
 */
export function getDataRange(symbol) {
  symbol = symbol.toUpperCase();
  const filePath = dataFilePath(symbol);
  if (!existsSync(filePath)) return null;

  try {
    const stored = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!stored.data || stored.data.length === 0) return null;
    return {
      earliest: stored.data[0].date,
      latest: stored.data[stored.data.length - 1].date,
      records: stored.data.length,
    };
  } catch {
    return null;
  }
}

/**
 * Load historical data from disk, optionally filtered by date range.
 * @param {string} symbol
 * @param {string} [startDate] - YYYY-MM-DD inclusive start
 * @param {string} [endDate] - YYYY-MM-DD inclusive end
 * @returns {Array<{date, open, high, low, close, volume}>}
 */
export function loadHistorical(symbol, startDate, endDate) {
  symbol = symbol.toUpperCase();
  const filePath = dataFilePath(symbol);
  if (!existsSync(filePath)) return [];

  try {
    const stored = JSON.parse(readFileSync(filePath, "utf-8"));
    let data = stored.data || [];

    if (startDate) {
      data = data.filter(d => d.date >= startDate);
    }
    if (endDate) {
      data = data.filter(d => d.date <= endDate);
    }

    return data;
  } catch {
    return [];
  }
}

/**
 * Save data to the historical store, merging with existing data.
 * Only adds new dates, preserving existing records (incremental).
 */
function saveHistorical(symbol, newRecords, source = "alphavantage") {
  symbol = symbol.toUpperCase();
  ensureDir();

  const filePath = dataFilePath(symbol);
  let existing = [];

  if (existsSync(filePath)) {
    try {
      const stored = JSON.parse(readFileSync(filePath, "utf-8"));
      existing = stored.data || [];
    } catch {
      existing = [];
    }
  }

  // Merge: build a date set from existing, only add new dates
  const existingDates = new Set(existing.map(d => d.date));
  let addedCount = 0;

  for (const record of newRecords) {
    if (!existingDates.has(record.date)) {
      existing.push(record);
      existingDates.add(record.date);
      addedCount++;
    }
  }

  // Sort by date ascending
  existing.sort((a, b) => a.date.localeCompare(b.date));

  const fileData = {
    symbol,
    interval: "daily",
    data: existing,
    metadata: {
      source,
      downloaded_at: new Date().toISOString(),
      records_count: existing.length,
    },
  };

  writeFileSync(filePath, JSON.stringify(fileData, null, 2));

  // Update metadata
  updateSymbolMeta(symbol, {
    last_updated: new Date().toISOString(),
    records: existing.length,
    earliest: existing[0]?.date || null,
    latest: existing[existing.length - 1]?.date || null,
    access_count: (getSymbolMeta(symbol)?.access_count || 0),
  });

  return { total: existing.length, added: addedCount };
}

/**
 * Determine which dates are missing from stored data relative to a target range.
 */
function getMissingDateRange(symbol, targetStartDate) {
  symbol = symbol.toUpperCase();
  const range = getDataRange(symbol);

  if (!range) {
    // No data at all — need full download
    return { needsFull: true, gapStart: targetStartDate, gapEnd: null };
  }

  const today = new Date().toISOString().split("T")[0];
  const result = { needsFull: false, gapStart: null, gapEnd: null };

  // Check if we need earlier data
  if (targetStartDate < range.earliest) {
    result.gapStart = targetStartDate;
    // Alpha Vantage returns full history in one call (outputsize=full),
    // so we just need to fetch once and merge
    result.needsFull = true;
  }

  // Check if we need more recent data (more than 1 day old)
  const latestStored = new Date(range.latest + "T00:00:00Z");
  const now = new Date(today + "T00:00:00Z");
  const daysSinceUpdate = Math.floor((now - latestStored) / (24 * 60 * 60 * 1000));

  if (daysSinceUpdate > 1) {
    result.needsFull = true; // Alpha Vantage compact gets ~100 days, full gets all
  }

  return result;
}

// ─── Backfill Engine ────────────────────────────────────

/**
 * Download and store historical data for a single symbol.
 * Performs incremental updates — only downloads if data is missing or stale.
 *
 * @param {string} symbol - Ticker symbol (e.g., "SPY", "BTC-USD")
 * @param {number} [years] - Years of history (default: 5 equities, 3 crypto)
 * @returns {Promise<{symbol, added, total, range}>}
 */
export async function backfillSymbol(symbol, years) {
  symbol = symbol.toUpperCase();
  years = years || defaultYears(symbol);
  ensureDir();

  const targetStart = new Date();
  targetStart.setFullYear(targetStart.getFullYear() - years);
  const targetStartDate = targetStart.toISOString().split("T")[0];

  console.log(`\n[Backfill] ${symbol} — target: ${years}yr from ${targetStartDate}`);

  // Check what we already have
  const existing = getDataRange(symbol);
  if (existing) {
    console.log(`  Existing: ${existing.records} records (${existing.earliest} to ${existing.latest})`);
  } else {
    console.log(`  No existing data for ${symbol}`);
  }

  // Determine if we need to fetch
  const missing = getMissingDateRange(symbol, targetStartDate);

  if (!missing.needsFull && existing) {
    // Check staleness: if latest data is from today or yesterday (weekend-adjusted), skip
    const today = new Date();
    const latestDate = new Date(existing.latest + "T00:00:00Z");
    const daysDiff = Math.floor((today - latestDate) / (24 * 60 * 60 * 1000));

    // Account for weekends: if today is Monday, data from Friday is fine
    const dayOfWeek = today.getDay();
    const allowedGap = dayOfWeek === 1 ? 3 : dayOfWeek === 0 ? 2 : 1;

    if (daysDiff <= allowedGap && existing.earliest <= targetStartDate) {
      console.log(`  Data is current (${daysDiff} day(s) old). Skipping fetch.`);
      return {
        symbol,
        added: 0,
        total: existing.records,
        range: { earliest: existing.earliest, latest: existing.latest },
      };
    }
  }

  // Fetch full history from API
  try {
    const records = await fetchDailyData(symbol);

    // Filter to target date range
    const filtered = records.filter(r => r.date >= targetStartDate);
    console.log(`  Fetched ${records.length} total records, ${filtered.length} in target range`);

    const result = saveHistorical(symbol, filtered);
    const range = getDataRange(symbol);

    console.log(`  Stored: ${result.total} records (${result.added} new). Range: ${range.earliest} to ${range.latest}`);

    // Track access for scheduling priority
    updateSymbolMeta(symbol, {
      last_fetched: new Date().toISOString(),
      access_count: (getSymbolMeta(symbol)?.access_count || 0) + 1,
    });

    return {
      symbol,
      added: result.added,
      total: result.total,
      range: { earliest: range.earliest, latest: range.latest },
    };
  } catch (err) {
    console.error(`  Failed to backfill ${symbol}: ${err.message}`);
    throw err;
  }
}

/**
 * Batch backfill multiple symbols with progress tracking.
 * Respects rate limits between API calls.
 *
 * @param {string[]} [symbols] - Symbols to backfill (default: DEFAULT_SYMBOLS)
 * @param {number} [years] - Years of history per symbol
 * @returns {Promise<{results: Array, summary: Object}>}
 */
export async function backfillAll(symbols, years) {
  symbols = symbols || DEFAULT_SYMBOLS;
  const results = [];
  const errors = [];
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Historical Backfill — ${symbols.length} symbols`);
  console.log(`${"=".repeat(60)}`);

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i].toUpperCase();
    const progress = `[${i + 1}/${symbols.length}]`;

    console.log(`\n${progress} Processing ${sym}...`);

    try {
      const result = await backfillSymbol(sym, years);
      results.push(result);
    } catch (err) {
      errors.push({ symbol: sym, error: err.message });
      results.push({ symbol: sym, added: 0, total: 0, range: null, error: err.message });
    }

    // Rate limit: wait between API calls (skip if last symbol or if no fetch was needed)
    if (i < symbols.length - 1) {
      const lastResult = results[results.length - 1];
      // Only wait if we actually made an API call (added > 0 or error occurred)
      if (lastResult.added > 0 || lastResult.error) {
        console.log(`  Rate limit pause (${RATE_LIMIT_DELAY_MS / 1000}s)...`);
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalRecords = results.reduce((s, r) => s + (r.total || 0), 0);
  const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
  const successful = results.filter(r => !r.error).length;

  const summary = {
    symbols_requested: symbols.length,
    symbols_successful: successful,
    symbols_failed: errors.length,
    total_records: totalRecords,
    records_added: totalAdded,
    elapsed_seconds: parseFloat(elapsed),
    errors,
  };

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Backfill Complete`);
  console.log(`  Success: ${successful}/${symbols.length} | Records: ${totalRecords} (+${totalAdded} new) | Time: ${elapsed}s`);
  if (errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of errors) {
      console.log(`    ${e.symbol}: ${e.error}`);
    }
  }
  console.log(`${"=".repeat(60)}`);

  return { results, summary };
}

// ─── Storage Stats ──────────────────────────────────────

/**
 * Get aggregate storage statistics.
 * @returns {{ symbols: number, total_records: number, disk_bytes: number, disk_human: string, details: Array }}
 */
export function getStorageStats() {
  ensureDir();
  const files = readdirSync(HISTORICAL_DIR).filter(f => f.endsWith("_daily.json"));
  let totalRecords = 0;
  let totalBytes = 0;
  const details = [];

  for (const f of files) {
    const filePath = join(HISTORICAL_DIR, f);
    const symbol = f.replace("_daily.json", "");

    try {
      const stat = statSync(filePath);
      totalBytes += stat.size;

      const stored = JSON.parse(readFileSync(filePath, "utf-8"));
      const count = stored.data?.length || 0;
      totalRecords += count;

      const meta = getSymbolMeta(symbol);

      details.push({
        symbol,
        records: count,
        bytes: stat.size,
        earliest: stored.data?.[0]?.date || "N/A",
        latest: stored.data?.[stored.data.length - 1]?.date || "N/A",
        last_updated: meta?.last_updated || stored.metadata?.downloaded_at || "unknown",
        access_count: meta?.access_count || 0,
      });
    } catch {
      details.push({ symbol, records: 0, bytes: 0, error: "corrupt file" });
    }
  }

  // Sort details by access count descending (most-used first)
  details.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));

  return {
    symbols: files.length,
    total_records: totalRecords,
    disk_bytes: totalBytes,
    disk_human: formatBytes(totalBytes),
    details,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Scheduler ──────────────────────────────────────────

/**
 * Update all stored symbols with latest data.
 * Prioritizes most-used symbols first, then stale data.
 * Designed to be called by a daemon/cron once per day.
 *
 * @returns {Promise<{results: Array, summary: Object}>}
 */
export async function scheduleDailyUpdate() {
  console.log(`\n[Scheduler] Daily update — ${new Date().toISOString()}`);

  const stats = getStorageStats();
  if (stats.symbols === 0) {
    console.log("  No stored symbols. Run --backfill-all first.");
    return { results: [], summary: { message: "no symbols to update" } };
  }

  // Sort by priority: most-used first, then oldest data first
  const sorted = stats.details
    .filter(d => !d.error)
    .sort((a, b) => {
      // Primary: access count (descending)
      if ((b.access_count || 0) !== (a.access_count || 0)) {
        return (b.access_count || 0) - (a.access_count || 0);
      }
      // Secondary: staleness (oldest first)
      return (a.last_updated || "").localeCompare(b.last_updated || "");
    });

  const symbols = sorted.map(d => d.symbol);
  console.log(`  Updating ${symbols.length} symbols in priority order: ${symbols.join(", ")}`);

  return await backfillAll(symbols);
}

/**
 * Record an access for a symbol (used to prioritize updates).
 * Call this whenever a strategy reads historical data.
 */
export function recordAccess(symbol) {
  symbol = symbol.toUpperCase();
  const meta = getSymbolMeta(symbol);
  if (meta) {
    updateSymbolMeta(symbol, {
      access_count: (meta.access_count || 0) + 1,
      last_accessed: new Date().toISOString(),
    });
  }
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Historical Data Backfill System
${"─".repeat(40)}

Commands:
  --backfill SYM1,SYM2   Download historical data for symbols
  --years N               Years of history (default: 5 equity, 3 crypto)
  --backfill-all          Backfill all default symbols
  --update                Daily update for all stored symbols
  --stats                 Show storage statistics
  --symbols               List stored symbols
  --range SYMBOL          Show date range for a symbol

Examples:
  node historical-backfill.mjs --backfill SPY,QQQ,BTC-USD --years 3
  node historical-backfill.mjs --backfill-all
  node historical-backfill.mjs --stats

Default symbols: ${DEFAULT_SYMBOLS.join(", ")}
`);
    return;
  }

  // --stats
  if (args.includes("--stats")) {
    const stats = getStorageStats();
    console.log(`\nStorage Statistics`);
    console.log(`${"─".repeat(50)}`);
    console.log(`  Symbols:       ${stats.symbols}`);
    console.log(`  Total records: ${stats.total_records}`);
    console.log(`  Disk usage:    ${stats.disk_human}`);
    console.log();

    if (stats.details.length > 0) {
      console.log(`  ${"Symbol".padEnd(12)} ${"Records".padStart(8)} ${"Range".padEnd(25)} ${"Updated".padEnd(22)} Uses`);
      console.log(`  ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(25)} ${"─".repeat(22)} ${"─".repeat(5)}`);
      for (const d of stats.details) {
        const range = d.earliest !== "N/A" ? `${d.earliest} to ${d.latest}` : "N/A";
        const updated = d.last_updated ? d.last_updated.slice(0, 19).replace("T", " ") : "N/A";
        console.log(`  ${d.symbol.padEnd(12)} ${String(d.records).padStart(8)} ${range.padEnd(25)} ${updated.padEnd(22)} ${d.access_count || 0}`);
      }
    }
    return;
  }

  // --symbols
  if (args.includes("--symbols")) {
    const symbols = getStoredSymbols();
    if (symbols.length === 0) {
      console.log("No stored symbols. Run --backfill-all to download data.");
    } else {
      console.log(`Stored symbols (${symbols.length}):`);
      for (const sym of symbols) {
        const range = getDataRange(sym);
        if (range) {
          console.log(`  ${sym.padEnd(10)} ${range.records} records (${range.earliest} to ${range.latest})`);
        } else {
          console.log(`  ${sym.padEnd(10)} (empty)`);
        }
      }
    }
    return;
  }

  // --range SYMBOL
  if (args.includes("--range")) {
    const idx = args.indexOf("--range");
    const symbol = args[idx + 1];
    if (!symbol) {
      console.error("Usage: --range SYMBOL");
      process.exit(1);
    }
    const range = getDataRange(symbol.toUpperCase());
    if (!range) {
      console.log(`No data stored for ${symbol.toUpperCase()}`);
    } else {
      console.log(`${symbol.toUpperCase()}: ${range.records} records (${range.earliest} to ${range.latest})`);
    }
    return;
  }

  // --update
  if (args.includes("--update")) {
    await scheduleDailyUpdate();
    return;
  }

  // Parse --years
  let years = null;
  const yearsIdx = args.indexOf("--years");
  if (yearsIdx !== -1 && args[yearsIdx + 1]) {
    years = parseInt(args[yearsIdx + 1], 10);
    if (isNaN(years) || years < 1 || years > 20) {
      console.error("--years must be between 1 and 20");
      process.exit(1);
    }
  }

  // --backfill-all
  if (args.includes("--backfill-all")) {
    await backfillAll(DEFAULT_SYMBOLS, years);
    return;
  }

  // --backfill SYM1,SYM2,...
  if (args.includes("--backfill")) {
    const idx = args.indexOf("--backfill");
    const symbolArg = args[idx + 1];
    if (!symbolArg) {
      console.error("Usage: --backfill SPY,QQQ,BTC-USD");
      process.exit(1);
    }
    const symbols = symbolArg.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) {
      console.error("No valid symbols provided.");
      process.exit(1);
    }
    await backfillAll(symbols, years);
    return;
  }

  console.error("Unknown command. Use --help for usage.");
  process.exit(1);
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("historical-backfill.mjs") ||
  process.argv[1].endsWith("historical-backfill")
);

if (isMain) {
  main().catch(err => {
    console.error("Backfill failed:", err.message);
    process.exit(1);
  });
}
