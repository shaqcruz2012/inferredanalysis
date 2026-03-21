#!/usr/bin/env node
/**
 * Real Market Data Collector — Multi-Source
 *
 * Collects real OHLCV and macro data from free public APIs:
 *   - Yahoo Finance (equities, ETFs, crypto — no API key)
 *   - FRED (Federal Reserve Economic Data — free, key optional)
 *   - CoinGecko (crypto — free tier, no key)
 *
 * Features:
 *   - Local JSON cache with configurable TTL
 *   - Per-source request throttling (respects rate limits)
 *   - Automatic fallback: real -> cache -> synthetic
 *   - Source logging for every request
 *
 * Usage:
 *   node agents/data/real-data-collector.mjs SPY               # Fetch equity
 *   node agents/data/real-data-collector.mjs bitcoin --crypto   # Fetch crypto
 *   node agents/data/real-data-collector.mjs --macro GDP        # Fetch macro
 *   node agents/data/real-data-collector.mjs --status           # Show cache status
 *
 * Exports:
 *   fetchRealPrices(symbol, startDate, endDate, interval)
 *   fetchMultipleSymbols(symbols, startDate, endDate)
 *   fetchMacroData(indicator)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateRealisticPrices } from "./fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "cache");

// ─── Configuration ───────────────────────────────────────

const CONFIG = {
  /** Cache time-to-live in milliseconds (default 6 hours) */
  cacheTTL: parseInt(process.env.DATA_CACHE_TTL_MS, 10) || 6 * 60 * 60 * 1000,

  /** Per-source throttle: minimum ms between requests */
  throttle: {
    yahoo: 1000,      // 1 req/s — Yahoo is generous but don't abuse
    fred: 2000,       // FRED free tier: ~120 req/min
    coingecko: 2500,  // CoinGecko free tier: 10-30 req/min
  },

  /** Request timeout in ms */
  requestTimeout: 30_000,

  /** FRED API key (optional, higher limits with key) */
  fredApiKey: process.env.FRED_API_KEY || "",

  /** User-Agent for HTTP requests (some APIs require it) */
  userAgent: "InferredAnalysis/1.0 (market-data-collector)",
};

// ─── Throttle Manager ────────────────────────────────────

const _lastRequestTime = { yahoo: 0, fred: 0, coingecko: 0 };

async function throttle(source) {
  const minGap = CONFIG.throttle[source] || 1000;
  const elapsed = Date.now() - (_lastRequestTime[source] || 0);
  if (elapsed < minGap) {
    const wait = minGap - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  _lastRequestTime[source] = Date.now();
}

// ─── Logging ─────────────────────────────────────────────

function log(source, symbol, message) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`  [${ts}] [${source.toUpperCase().padEnd(10)}] ${symbol.padEnd(12)} ${message}`);
}

// ─── Cache Layer ─────────────────────────────────────────

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(symbol, interval, startDate, endDate) {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  const intv = (interval || "1d").replace(/[^a-z0-9]/gi, "");
  const start = (startDate || "").replace(/-/g, "");
  const end = (endDate || "").replace(/-/g, "");
  return `${sym}_${intv}_${start}_${end}.json`;
}

function readCache(key) {
  const path = join(CACHE_DIR, key);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const age = Date.now() - (raw.fetchedAt || 0);
    if (age > CONFIG.cacheTTL) {
      return null; // expired
    }
    return raw;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  ensureCacheDir();
  const path = join(CACHE_DIR, key);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─── Yahoo Finance ───────────────────────────────────────

/**
 * Fetch OHLCV data from Yahoo Finance v8 chart API.
 * No API key required. Works for equities, ETFs, indices, and crypto pairs.
 *
 * @param {string} symbol - Ticker symbol (e.g., "SPY", "AAPL", "BTC-USD")
 * @param {string} startDate - ISO date string "YYYY-MM-DD"
 * @param {string} endDate - ISO date string "YYYY-MM-DD"
 * @param {string} interval - "1d", "1wk", "1mo", "1h", "5m"
 * @returns {Promise<Array<{date, open, high, low, close, volume}>>}
 */
async function fetchFromYahoo(symbol, startDate, endDate, interval = "1d") {
  await throttle("yahoo");

  const period1 = Math.floor(new Date(startDate).getTime() / 1000);
  const period2 = Math.floor(new Date(endDate).getTime() / 1000);

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${interval}` +
    `&includePrePost=false&events=div,splits`;

  log("yahoo", symbol, `Fetching ${interval} data ${startDate} to ${endDate}...`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(CONFIG.requestTimeout),
    headers: {
      "User-Agent": CONFIG.userAgent,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Yahoo HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const chart = json?.chart;

  if (chart?.error) {
    throw new Error(`Yahoo API error: ${chart.error.description || JSON.stringify(chart.error)}`);
  }

  const result = chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo returned no data for ${symbol}`);
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];

  if (!timestamps || !quote) {
    throw new Error(`Yahoo response missing timestamp or quote data for ${symbol}`);
  }

  const prices = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];

    // Skip bars with null values (market closed, etc.)
    if (o == null || h == null || l == null || c == null) continue;

    const dt = new Date(timestamps[i] * 1000);
    const dateStr =
      interval === "1d" || interval === "1wk" || interval === "1mo"
        ? dt.toISOString().split("T")[0]
        : dt.toISOString().replace("Z", "").slice(0, 19);

    prices.push({
      date: dateStr,
      open: +o.toFixed(4),
      high: +h.toFixed(4),
      low: +l.toFixed(4),
      close: +c.toFixed(4),
      volume: Math.round(v || 0),
    });
  }

  prices.sort((a, b) => a.date.localeCompare(b.date));
  log("yahoo", symbol, `Got ${prices.length} bars (${prices[0]?.date} to ${prices[prices.length - 1]?.date})`);
  return prices;
}

// ─── CoinGecko ───────────────────────────────────────────

/**
 * Map of common crypto symbols to CoinGecko IDs.
 * CoinGecko uses slug IDs, not ticker symbols.
 */
const COINGECKO_ID_MAP = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  DOGE: "dogecoin",
  ADA: "cardano",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  LINK: "chainlink",
  UNI: "uniswap",
  ATOM: "cosmos",
  XRP: "ripple",
  LTC: "litecoin",
  BNB: "binancecoin",
  SHIB: "shiba-inu",
  ARB: "arbitrum",
  OP: "optimism",
};

function resolveCoinGeckoId(symbol) {
  const upper = symbol.toUpperCase();
  if (COINGECKO_ID_MAP[upper]) return COINGECKO_ID_MAP[upper];
  // If already a slug (lowercase, has dashes), use as-is
  if (symbol === symbol.toLowerCase() && /^[a-z0-9-]+$/.test(symbol)) return symbol;
  return symbol.toLowerCase();
}

/**
 * Fetch daily OHLC from CoinGecko free API.
 * CoinGecko /ohlc endpoint returns [timestamp, O, H, L, C].
 * Free tier: daily candles for up to 365 days; for longer ranges, use /market_chart.
 *
 * @param {string} symbol - Crypto symbol ("BTC") or CoinGecko ID ("bitcoin")
 * @param {string} startDate - ISO date "YYYY-MM-DD"
 * @param {string} endDate - ISO date "YYYY-MM-DD"
 * @returns {Promise<Array<{date, open, high, low, close, volume}>>}
 */
async function fetchFromCoinGecko(symbol, startDate, endDate) {
  await throttle("coingecko");

  const coinId = resolveCoinGeckoId(symbol);
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffDays = Math.ceil((end - start) / (24 * 60 * 60 * 1000));

  // CoinGecko OHLC endpoint supports days: 1, 7, 14, 30, 90, 180, 365, max
  // For granularity: <=2 days -> 30min, <=30 days -> 4h, else daily
  // We use /market_chart/range for precise date ranges
  const fromTs = Math.floor(start.getTime() / 1000);
  const toTs = Math.floor(end.getTime() / 1000);

  const url =
    `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range` +
    `?vs_currency=usd&from=${fromTs}&to=${toTs}`;

  log("coingecko", symbol, `Fetching ${diffDays} days of data...`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(CONFIG.requestTimeout),
    headers: {
      "User-Agent": CONFIG.userAgent,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CoinGecko HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();

  if (!json.prices || json.prices.length === 0) {
    throw new Error(`CoinGecko returned no price data for ${coinId}`);
  }

  // market_chart/range returns: { prices: [[ts,price]], market_caps, total_volumes }
  // We need to construct OHLCV from daily price points.
  // Group by date and create daily bars.
  const dailyMap = new Map();

  for (const [ts, price] of json.prices) {
    const dateStr = new Date(ts).toISOString().split("T")[0];
    if (!dailyMap.has(dateStr)) {
      dailyMap.set(dateStr, { prices: [], volumes: [] });
    }
    dailyMap.get(dateStr).prices.push(price);
  }

  // Add volume data if available
  if (json.total_volumes) {
    for (const [ts, vol] of json.total_volumes) {
      const dateStr = new Date(ts).toISOString().split("T")[0];
      if (dailyMap.has(dateStr)) {
        dailyMap.get(dateStr).volumes.push(vol);
      }
    }
  }

  const prices = [];
  for (const [dateStr, data] of dailyMap.entries()) {
    const dayPrices = data.prices;
    if (dayPrices.length === 0) continue;

    prices.push({
      date: dateStr,
      open: +dayPrices[0].toFixed(4),
      high: +Math.max(...dayPrices).toFixed(4),
      low: +Math.min(...dayPrices).toFixed(4),
      close: +dayPrices[dayPrices.length - 1].toFixed(4),
      volume: data.volumes.length > 0 ? Math.round(data.volumes.reduce((a, b) => a + b, 0) / data.volumes.length) : 0,
    });
  }

  prices.sort((a, b) => a.date.localeCompare(b.date));
  log("coingecko", symbol, `Got ${prices.length} daily bars (${prices[0]?.date} to ${prices[prices.length - 1]?.date})`);
  return prices;
}

// ─── FRED (Federal Reserve Economic Data) ────────────────

/**
 * Known FRED series IDs for common macro indicators.
 */
const FRED_SERIES_MAP = {
  GDP: "GDP",
  "REAL_GDP": "GDPC1",
  CPI: "CPIAUCSL",
  "CORE_CPI": "CPILFESL",
  PCE: "PCEPI",
  "CORE_PCE": "PCEPILFE",
  UNEMPLOYMENT: "UNRATE",
  PAYROLLS: "PAYEMS",
  "FED_FUNDS": "FEDFUNDS",
  "10Y_YIELD": "DGS10",
  "2Y_YIELD": "DGS2",
  "30Y_YIELD": "DGS30",
  "3M_YIELD": "DGS3MO",
  SPREAD_10Y2Y: "T10Y2Y",
  SPREAD_10Y3M: "T10Y3M",
  VIX: "VIXCLS",
  "SP500": "SP500",
  M2: "M2SL",
  "HOUSING_STARTS": "HOUST",
  "RETAIL_SALES": "RSAFS",
  "INDUSTRIAL_PROD": "INDPRO",
  "CONSUMER_SENT": "UMCSENT",
  "INITIAL_CLAIMS": "ICSA",
  "CONTINUING_CLAIMS": "CCSA",
  DXY: "DTWEXBGS",
  "CRUDE_OIL": "DCOILWTICO",
  GOLD: "GOLDPMGBD228NLBM",
};

/**
 * Fetch time series data from FRED.
 *
 * @param {string} indicator - Indicator name (e.g., "GDP", "CPI", "VIX") or raw FRED series ID
 * @param {string} [startDate] - ISO date "YYYY-MM-DD" (default: 5 years ago)
 * @param {string} [endDate] - ISO date "YYYY-MM-DD" (default: today)
 * @returns {Promise<Array<{date, value}>>}
 */
async function fetchFromFRED(indicator, startDate, endDate) {
  await throttle("fred");

  const seriesId = FRED_SERIES_MAP[indicator.toUpperCase()] || indicator;
  const start = startDate || new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const end = endDate || new Date().toISOString().split("T")[0];

  let url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}` +
    `&observation_start=${start}` +
    `&observation_end=${end}` +
    `&file_type=json`;

  if (CONFIG.fredApiKey) {
    url += `&api_key=${CONFIG.fredApiKey}`;
  } else {
    // Without an API key, FRED returns limited data but still works for many series
    // The demo key below is the publicly documented one from FRED docs
    url += `&api_key=DEMO_KEY`;
  }

  log("fred", indicator, `Fetching series ${seriesId} (${start} to ${end})...`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(CONFIG.requestTimeout),
    headers: {
      "User-Agent": CONFIG.userAgent,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FRED HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();

  if (json.error_message) {
    throw new Error(`FRED API error: ${json.error_message}`);
  }

  const observations = json.observations;
  if (!observations || observations.length === 0) {
    throw new Error(`FRED returned no observations for ${seriesId}`);
  }

  const data = observations
    .filter((obs) => obs.value !== ".")  // FRED uses "." for missing values
    .map((obs) => ({
      date: obs.date,
      value: parseFloat(obs.value),
    }))
    .filter((d) => !isNaN(d.value))
    .sort((a, b) => a.date.localeCompare(b.date));

  log("fred", indicator, `Got ${data.length} observations (${data[0]?.date} to ${data[data.length - 1]?.date})`);
  return data;
}

// ─── Source Detection ────────────────────────────────────

/**
 * Determine the best data source for a given symbol.
 * @param {string} symbol
 * @returns {"yahoo" | "coingecko" | "fred"}
 */
function detectSource(symbol) {
  const upper = symbol.toUpperCase();

  // Explicit crypto symbols or CoinGecko IDs
  if (COINGECKO_ID_MAP[upper]) return "coingecko";
  if (Object.values(COINGECKO_ID_MAP).includes(symbol.toLowerCase())) return "coingecko";

  // FRED macro indicators
  if (FRED_SERIES_MAP[upper]) return "fred";

  // Yahoo Finance crypto pairs (contain -USD suffix)
  if (upper.endsWith("-USD") || upper.endsWith("-EUR") || upper.endsWith("-GBP")) return "yahoo";

  // Default to Yahoo for equities/ETFs
  return "yahoo";
}

// ─── Public API ──────────────────────────────────────────

/**
 * Fetch real OHLCV prices for a symbol.
 * Automatically selects the data source. Falls back to cache, then synthetic.
 *
 * @param {string} symbol - Ticker or crypto symbol
 * @param {string} [startDate="2020-01-01"] - Start date "YYYY-MM-DD"
 * @param {string} [endDate] - End date "YYYY-MM-DD" (default: today)
 * @param {string} [interval="1d"] - Bar interval: "1d", "1wk", "1mo", "1h"
 * @returns {Promise<{prices: Array, source: string, meta: Object}>}
 */
export async function fetchRealPrices(symbol, startDate = "2020-01-01", endDate, interval = "1d") {
  if (!endDate) {
    endDate = new Date().toISOString().split("T")[0];
  }

  const key = cacheKey(symbol, interval, startDate, endDate);
  const source = detectSource(symbol);

  // 1. Try cache first
  const cached = readCache(key);
  if (cached) {
    log("cache", symbol, `Serving from cache (${cached.prices?.length || cached.data?.length} records, age ${Math.round((Date.now() - cached.fetchedAt) / 60000)} min)`);
    return {
      prices: cached.prices || cached.data,
      source: "cache",
      meta: {
        originalSource: cached.source,
        fetchedAt: cached.fetchedAt,
        cacheAge: Date.now() - cached.fetchedAt,
        symbol: cached.symbol,
      },
    };
  }

  // 2. Try real data
  try {
    let prices;
    if (source === "yahoo") {
      prices = await fetchFromYahoo(symbol, startDate, endDate, interval);
    } else if (source === "coingecko") {
      prices = await fetchFromCoinGecko(symbol, startDate, endDate);
    } else if (source === "fred") {
      const data = await fetchFromFRED(symbol, startDate, endDate);
      // Convert FRED format to OHLCV-like format for consistency
      prices = data.map((d) => ({
        date: d.date,
        open: d.value,
        high: d.value,
        low: d.value,
        close: d.value,
        volume: 0,
      }));
    }

    if (prices && prices.length > 0) {
      // Write to cache
      writeCache(key, {
        symbol: symbol.toUpperCase(),
        source,
        interval,
        startDate,
        endDate,
        fetchedAt: Date.now(),
        fetchedAtISO: new Date().toISOString(),
        count: prices.length,
        prices,
      });

      return {
        prices,
        source: `real:${source}`,
        meta: {
          fetchedAt: Date.now(),
          count: prices.length,
          dateRange: `${prices[0].date} to ${prices[prices.length - 1].date}`,
        },
      };
    }

    throw new Error("No data returned");
  } catch (err) {
    log("error", symbol, `Real data fetch failed (${source}): ${err.message}`);

    // 3. Check for any stale cache (ignore TTL)
    const stalePath = join(CACHE_DIR, key);
    if (existsSync(stalePath)) {
      try {
        const stale = JSON.parse(readFileSync(stalePath, "utf-8"));
        log("cache", symbol, `Serving STALE cache (age ${Math.round((Date.now() - stale.fetchedAt) / 3600000)}h)`);
        return {
          prices: stale.prices || stale.data,
          source: "stale_cache",
          meta: {
            originalSource: stale.source,
            fetchedAt: stale.fetchedAt,
            cacheAge: Date.now() - stale.fetchedAt,
            stale: true,
            error: err.message,
          },
        };
      } catch { /* ignore parse errors */ }
    }

    // 4. Final fallback: synthetic data
    log("synthetic", symbol, "Falling back to synthetic data generation");
    const syntheticPrices = generateRealisticPrices(symbol, startDate, endDate);
    return {
      prices: syntheticPrices,
      source: "synthetic",
      meta: {
        reason: `Real data unavailable: ${err.message}`,
        generated: true,
      },
    };
  }
}

/**
 * Fetch prices for multiple symbols in batch.
 * Respects per-source throttling automatically.
 *
 * @param {string[]} symbols - Array of ticker symbols
 * @param {string} [startDate="2020-01-01"]
 * @param {string} [endDate] - Default: today
 * @returns {Promise<Object<string, {prices, source, meta}>>}
 */
export async function fetchMultipleSymbols(symbols, startDate = "2020-01-01", endDate) {
  if (!endDate) {
    endDate = new Date().toISOString().split("T")[0];
  }

  const results = {};
  const errors = [];

  for (const symbol of symbols) {
    try {
      results[symbol.toUpperCase()] = await fetchRealPrices(symbol, startDate, endDate);
    } catch (err) {
      errors.push({ symbol, error: err.message });
      log("error", symbol, `Batch fetch failed: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    log("batch", "SUMMARY", `${symbols.length - errors.length}/${symbols.length} symbols fetched, ${errors.length} errors`);
  } else {
    log("batch", "SUMMARY", `All ${symbols.length} symbols fetched successfully`);
  }

  return results;
}

/**
 * Fetch macro/economic data from FRED.
 *
 * @param {string} indicator - Indicator name or FRED series ID
 *   Supported names: GDP, REAL_GDP, CPI, CORE_CPI, PCE, CORE_PCE, UNEMPLOYMENT,
 *   PAYROLLS, FED_FUNDS, 10Y_YIELD, 2Y_YIELD, 30Y_YIELD, VIX, SP500, M2,
 *   HOUSING_STARTS, RETAIL_SALES, INDUSTRIAL_PROD, CONSUMER_SENT,
 *   INITIAL_CLAIMS, CONTINUING_CLAIMS, DXY, CRUDE_OIL, GOLD
 * @param {string} [startDate] - Default: 5 years ago
 * @param {string} [endDate] - Default: today
 * @returns {Promise<{data: Array<{date, value}>, source: string, meta: Object}>}
 */
export async function fetchMacroData(indicator, startDate, endDate) {
  const upper = indicator.toUpperCase();
  const seriesId = FRED_SERIES_MAP[upper] || indicator;
  const key = cacheKey(`FRED_${seriesId}`, "macro", startDate || "auto", endDate || "auto");

  // Check cache
  const cached = readCache(key);
  if (cached) {
    log("cache", indicator, `Serving macro data from cache (${cached.data?.length} records)`);
    return {
      data: cached.data,
      source: "cache",
      meta: {
        seriesId,
        originalSource: "fred",
        fetchedAt: cached.fetchedAt,
        cacheAge: Date.now() - cached.fetchedAt,
      },
    };
  }

  try {
    const data = await fetchFromFRED(indicator, startDate, endDate);

    writeCache(key, {
      symbol: `FRED:${seriesId}`,
      source: "fred",
      indicator: upper,
      seriesId,
      fetchedAt: Date.now(),
      fetchedAtISO: new Date().toISOString(),
      count: data.length,
      data,
    });

    return {
      data,
      source: "real:fred",
      meta: {
        seriesId,
        fetchedAt: Date.now(),
        count: data.length,
        dateRange: data.length > 0 ? `${data[0].date} to ${data[data.length - 1].date}` : "empty",
      },
    };
  } catch (err) {
    log("error", indicator, `FRED fetch failed: ${err.message}`);

    // Check stale cache
    const stalePath = join(CACHE_DIR, key);
    if (existsSync(stalePath)) {
      try {
        const stale = JSON.parse(readFileSync(stalePath, "utf-8"));
        log("cache", indicator, "Serving STALE macro cache");
        return {
          data: stale.data,
          source: "stale_cache",
          meta: { seriesId, stale: true, error: err.message },
        };
      } catch { /* ignore */ }
    }

    throw new Error(`Unable to fetch macro data for ${indicator}: ${err.message}`);
  }
}

/**
 * List all available macro indicators.
 * @returns {Object} Map of indicator name to FRED series ID
 */
export function listMacroIndicators() {
  return { ...FRED_SERIES_MAP };
}

/**
 * List all known crypto symbols for CoinGecko.
 * @returns {Object} Map of ticker to CoinGecko ID
 */
export function listCryptoSymbols() {
  return { ...COINGECKO_ID_MAP };
}

/**
 * Get cache statistics.
 * @returns {{ totalFiles: number, totalSizeBytes: number, symbols: string[], oldestAge: number, newestAge: number }}
 */
export function getCacheStats() {
  ensureCacheDir();
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  let totalSize = 0;
  let oldest = Infinity;
  let newest = 0;
  const symbols = new Set();

  for (const f of files) {
    try {
      const fpath = join(CACHE_DIR, f);
      const stat = statSync(fpath);
      totalSize += stat.size;
      const data = JSON.parse(readFileSync(fpath, "utf-8"));
      if (data.symbol) symbols.add(data.symbol);
      const age = Date.now() - (data.fetchedAt || 0);
      if (age < oldest) oldest = age;
      if (age > newest) newest = age;
    } catch { /* skip */ }
  }

  return {
    totalFiles: files.length,
    totalSizeBytes: totalSize,
    totalSizeMB: +(totalSize / 1048576).toFixed(2),
    symbols: [...symbols],
    oldestAgeHours: oldest === Infinity ? 0 : +(oldest / 3600000).toFixed(1),
    newestAgeHours: newest === 0 ? 0 : +(newest / 3600000).toFixed(1),
  };
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    const stats = getCacheStats();
    console.log("\nCache Status:");
    console.log(`  Files:     ${stats.totalFiles}`);
    console.log(`  Size:      ${stats.totalSizeMB} MB`);
    console.log(`  Symbols:   ${stats.symbols.join(", ") || "(none)"}`);
    console.log(`  Oldest:    ${stats.oldestAgeHours}h`);
    console.log(`  Newest:    ${stats.newestAgeHours}h`);
    return;
  }

  if (args.includes("--macro")) {
    const indicator = args.filter((a) => !a.startsWith("--"))[0] || "VIX";
    console.log(`\nFetching macro data: ${indicator}\n`);
    const result = await fetchMacroData(indicator);
    console.log(`\n  Source: ${result.source}`);
    console.log(`  Records: ${result.data.length}`);
    if (result.data.length > 0) {
      console.log(`  Latest: ${result.data[result.data.length - 1].date} = ${result.data[result.data.length - 1].value}`);
    }
    return;
  }

  if (args.includes("--crypto")) {
    const symbol = args.filter((a) => !a.startsWith("--"))[0] || "bitcoin";
    console.log(`\nFetching crypto data: ${symbol}\n`);
    const result = await fetchRealPrices(symbol, "2024-01-01");
    console.log(`\n  Source: ${result.source}`);
    console.log(`  Bars: ${result.prices.length}`);
    if (result.prices.length > 0) {
      const last = result.prices[result.prices.length - 1];
      console.log(`  Latest: ${last.date} close=${last.close}`);
    }
    return;
  }

  if (args.includes("--list-macro")) {
    console.log("\nAvailable macro indicators:");
    for (const [name, id] of Object.entries(FRED_SERIES_MAP)) {
      console.log(`  ${name.padEnd(20)} ${id}`);
    }
    return;
  }

  // Default: fetch equity/ETF symbols
  const symbols = args.filter((a) => !a.startsWith("--"));
  if (symbols.length === 0) {
    console.log("Usage:");
    console.log("  node real-data-collector.mjs SPY AAPL        # Fetch equities");
    console.log("  node real-data-collector.mjs --crypto BTC     # Fetch crypto");
    console.log("  node real-data-collector.mjs --macro VIX      # Fetch macro");
    console.log("  node real-data-collector.mjs --list-macro      # List indicators");
    console.log("  node real-data-collector.mjs --status          # Cache status");
    return;
  }

  console.log(`\nFetching ${symbols.length} symbol(s)...\n`);
  const results = await fetchMultipleSymbols(symbols, "2023-01-01");

  console.log("\nResults:");
  for (const [sym, result] of Object.entries(results)) {
    console.log(`  ${sym.padEnd(10)} ${String(result.prices.length).padStart(6)} bars  source=${result.source}`);
  }
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("real-data-collector.mjs") ||
  process.argv[1].endsWith("real-data-collector")
);

if (isMain) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
