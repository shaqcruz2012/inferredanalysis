#!/usr/bin/env node
/**
 * Portfolio Tracker — Live Portfolio State Management
 *
 * Central nervous system for position management. Maintains real-time
 * portfolio state: positions, cash, equity, P&L, and exposure metrics.
 * Persists state for crash recovery and emits events for downstream
 * consumers (risk gateway, circuit breakers, alerting).
 *
 * Exported API:
 *   PortfolioTracker          — main class (singleton via getTracker())
 *   getTracker(config?)       — get or create the singleton tracker
 *
 * Events emitted:
 *   'trade'          — on every trade added   { trade, position, portfolio }
 *   'position:opened' — new position created  { symbol, side, qty, price }
 *   'position:closed' — position fully closed { symbol, realizedPnl }
 *   'position:updated'— position size changed { symbol, qty, avgCost }
 *   'exposure:change' — exposure shifted       { long, short, net, gross }
 *   'drawdown:alert'  — drawdown threshold hit { drawdownPct, threshold }
 *   'state:saved'     — state persisted        { path }
 *
 * Usage:
 *   import { getTracker } from '../shared/portfolio-tracker.mjs';
 *   const tracker = getTracker({ initialCash: 100_000 });
 *   tracker.addTrade({ symbol: 'SPY', side: 'buy', qty: 10, price: 450.00, ... });
 *   const summary = tracker.getPortfolioSummary(currentPrices);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const STATE_DIR = join(AGENTS_DIR, "state");
const DEFAULT_STATE_PATH = join(STATE_DIR, "portfolio-state.json");

// ─── Position Class ────────────────────────────────────────

class Position {
  constructor(symbol) {
    this.symbol = symbol;
    this.qty = 0;              // signed: positive = long, negative = short
    this.avgCost = 0;          // average cost basis per share
    this.totalCost = 0;        // total cost basis
    this.realizedPnl = 0;      // lifetime realized P&L for this symbol
    this.todayRealizedPnl = 0; // today's realized P&L
    this.openedAt = null;      // ISO timestamp of first entry
    this.lastTradeAt = null;   // ISO timestamp of most recent trade
    this.tradeCount = 0;       // total trades in this position
  }

  /**
   * Apply a trade to this position. Returns realized P&L from the trade.
   *
   * @param {number} tradeQty - signed qty (positive = buy, negative = sell)
   * @param {number} price - execution price
   * @param {string} timestamp - ISO timestamp
   * @returns {number} realized P&L from this trade (0 if purely opening)
   */
  applyTrade(tradeQty, price, timestamp) {
    let realized = 0;
    const prevQty = this.qty;
    const newQty = prevQty + tradeQty;

    if (prevQty === 0) {
      // Opening a new position
      this.avgCost = price;
      this.totalCost = price * Math.abs(tradeQty);
      this.openedAt = timestamp;
    } else if (Math.sign(prevQty) === Math.sign(tradeQty)) {
      // Adding to existing position (same direction)
      const prevTotalCost = this.avgCost * Math.abs(prevQty);
      const addedCost = price * Math.abs(tradeQty);
      this.totalCost = prevTotalCost + addedCost;
      this.avgCost = this.totalCost / Math.abs(newQty);
    } else {
      // Reducing or reversing position
      const closingQty = Math.min(Math.abs(tradeQty), Math.abs(prevQty));

      // Realized P&L on closed portion
      if (prevQty > 0) {
        // Was long, selling
        realized = closingQty * (price - this.avgCost);
      } else {
        // Was short, buying to cover
        realized = closingQty * (this.avgCost - price);
      }

      if (Math.abs(newQty) < 1e-10) {
        // Position fully closed
        this.totalCost = 0;
        // avgCost preserved for reference
      } else if (Math.sign(newQty) === Math.sign(prevQty)) {
        // Partially closed, same direction remains
        this.totalCost = this.avgCost * Math.abs(newQty);
      } else {
        // Reversed direction — the excess becomes a new position at trade price
        this.avgCost = price;
        this.totalCost = price * Math.abs(newQty);
        this.openedAt = timestamp;
      }
    }

    this.qty = newQty;
    this.realizedPnl += realized;
    this.todayRealizedPnl += realized;
    this.lastTradeAt = timestamp;
    this.tradeCount++;

    return realized;
  }

  /**
   * Compute unrealized P&L given a current market price.
   */
  unrealizedPnl(currentPrice) {
    if (this.qty === 0) return 0;
    if (this.qty > 0) {
      return this.qty * (currentPrice - this.avgCost);
    } else {
      return Math.abs(this.qty) * (this.avgCost - currentPrice);
    }
  }

  /**
   * Market value (absolute) at a given price.
   */
  marketValue(currentPrice) {
    return Math.abs(this.qty) * currentPrice;
  }

  /**
   * Signed notional exposure at a given price.
   */
  notionalExposure(currentPrice) {
    return this.qty * currentPrice;
  }

  /**
   * Side of the position: 'long', 'short', or 'flat'.
   */
  get side() {
    if (this.qty > 0) return "long";
    if (this.qty < 0) return "short";
    return "flat";
  }

  /**
   * Whether this position is flat (zero qty).
   */
  get isFlat() {
    return Math.abs(this.qty) < 1e-10;
  }

  /**
   * Serialize for persistence.
   */
  toJSON() {
    return {
      symbol: this.symbol,
      qty: this.qty,
      avgCost: this.avgCost,
      totalCost: this.totalCost,
      realizedPnl: this.realizedPnl,
      todayRealizedPnl: this.todayRealizedPnl,
      openedAt: this.openedAt,
      lastTradeAt: this.lastTradeAt,
      tradeCount: this.tradeCount,
    };
  }

  /**
   * Restore from persisted JSON.
   */
  static fromJSON(data) {
    const pos = new Position(data.symbol);
    pos.qty = data.qty || 0;
    pos.avgCost = data.avgCost || 0;
    pos.totalCost = data.totalCost || 0;
    pos.realizedPnl = data.realizedPnl || 0;
    pos.todayRealizedPnl = data.todayRealizedPnl || 0;
    pos.openedAt = data.openedAt || null;
    pos.lastTradeAt = data.lastTradeAt || null;
    pos.tradeCount = data.tradeCount || 0;
    return pos;
  }
}

// ─── Portfolio Tracker ─────────────────────────────────────

export class PortfolioTracker extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number} config.initialCash        — starting cash (default 100_000)
   * @param {string} config.statePath          — path for state persistence
   * @param {number} config.drawdownAlertPct   — emit alert at this drawdown (default 0.05)
   * @param {number} config.autosaveIntervalMs — auto-save interval (default 60_000, 0 to disable)
   * @param {boolean} config.loadOnInit        — load from state file on construction (default true)
   */
  constructor(config = {}) {
    super();
    this.config = {
      initialCash: config.initialCash ?? 100_000,
      statePath: config.statePath ?? DEFAULT_STATE_PATH,
      drawdownAlertPct: config.drawdownAlertPct ?? 0.05,
      autosaveIntervalMs: config.autosaveIntervalMs ?? 60_000,
      loadOnInit: config.loadOnInit ?? true,
    };

    // Core state
    this.positions = new Map();   // symbol → Position
    this.cash = this.config.initialCash;
    this.tradeLog = [];           // recent trades (capped at 500)
    this.dayStartEquity = this.config.initialCash;
    this.highWaterMark = this.config.initialCash;
    this.tradingDay = todayISO();
    this.totalRealizedPnl = 0;
    this.createdAt = new Date().toISOString();
    this.lastUpdatedAt = this.createdAt;

    // Crash recovery: load persisted state
    if (this.config.loadOnInit) {
      this._loadState();
    }

    // Auto-save on interval
    this._autosaveTimer = null;
    if (this.config.autosaveIntervalMs > 0) {
      this._autosaveTimer = setInterval(() => {
        this.saveState();
      }, this.config.autosaveIntervalMs);
      // Allow process to exit even if timer is running
      if (this._autosaveTimer.unref) {
        this._autosaveTimer.unref();
      }
    }
  }

  // ─── Trade Processing ────────────────────────────────────

  /**
   * Record a trade execution and update portfolio state.
   *
   * @param {Object} trade
   * @param {string} trade.symbol       — ticker symbol
   * @param {string} trade.side         — 'buy' or 'sell'
   * @param {number} trade.qty          — quantity (always positive)
   * @param {number} trade.price        — execution price
   * @param {string} [trade.agent]      — agent/strategy that placed the trade
   * @param {string} [trade.orderId]    — order ID from broker
   * @param {string} [trade.timestamp]  — ISO timestamp (defaults to now)
   * @param {number} [trade.commission] — commission cost
   * @returns {{ position: Object, realized: number, portfolio: Object }}
   */
  addTrade(trade) {
    this._rollDayIfNeeded();

    const {
      symbol,
      side,
      qty: rawQty,
      price,
      agent = "unknown",
      orderId = "",
      timestamp = new Date().toISOString(),
      commission = 0,
    } = trade;

    if (!symbol || !side || !rawQty || !price) {
      throw new Error(`Invalid trade: missing required fields (symbol=${symbol}, side=${side}, qty=${rawQty}, price=${price})`);
    }

    const qty = Math.abs(rawQty);
    const signedQty = side === "buy" ? qty : -qty;
    const notional = qty * price;

    // Get or create position
    let position = this.positions.get(symbol);
    const isNewPosition = !position || position.isFlat;
    if (!position) {
      position = new Position(symbol);
      this.positions.set(symbol, position);
    }

    const prevQty = position.qty;

    // Apply trade to position
    const realized = position.applyTrade(signedQty, price, timestamp);

    // Update cash: buying costs cash, selling adds cash
    this.cash -= signedQty * price;
    this.cash -= commission;
    this.totalRealizedPnl += realized;

    // Update high water mark
    const currentEquity = this._estimateEquity(price);
    if (currentEquity > this.highWaterMark) {
      this.highWaterMark = currentEquity;
    }

    // Log trade
    const tradeRecord = {
      timestamp,
      symbol,
      side,
      qty,
      price,
      notional,
      agent,
      orderId,
      commission,
      realizedPnl: round2(realized),
      positionQty: position.qty,
      positionAvgCost: round2(position.avgCost),
    };
    this.tradeLog.push(tradeRecord);
    if (this.tradeLog.length > 500) {
      this.tradeLog = this.tradeLog.slice(-500);
    }

    this.lastUpdatedAt = timestamp;

    // Emit events
    this.emit("trade", {
      trade: tradeRecord,
      position: position.toJSON(),
      portfolio: { cash: round2(this.cash), equity: round2(currentEquity) },
    });

    if (isNewPosition && !position.isFlat) {
      this.emit("position:opened", {
        symbol,
        side: position.side,
        qty: position.qty,
        price,
      });
    } else if (position.isFlat && prevQty !== 0) {
      this.emit("position:closed", {
        symbol,
        realizedPnl: round2(realized),
        totalRealizedPnl: round2(position.realizedPnl),
      });
    } else if (!position.isFlat) {
      this.emit("position:updated", {
        symbol,
        qty: position.qty,
        avgCost: round2(position.avgCost),
      });
    }

    // Check drawdown alert
    const drawdownPct = this.highWaterMark > 0
      ? (this.highWaterMark - currentEquity) / this.highWaterMark
      : 0;
    if (drawdownPct >= this.config.drawdownAlertPct) {
      this.emit("drawdown:alert", {
        drawdownPct: round4(drawdownPct),
        threshold: this.config.drawdownAlertPct,
        equity: round2(currentEquity),
        highWaterMark: round2(this.highWaterMark),
      });
    }

    // Persist state
    this.saveState();

    return {
      position: position.toJSON(),
      realized: round2(realized),
      portfolio: {
        cash: round2(this.cash),
        equity: round2(currentEquity),
        dayPnl: round2(currentEquity - this.dayStartEquity),
      },
    };
  }

  // ─── Position Queries ────────────────────────────────────

  /**
   * Get all current holdings with unrealized P&L.
   *
   * @param {Object} [currentPrices] — map of symbol → current price
   * @returns {Array<Object>} positions with unrealized P&L
   */
  getPositions(currentPrices = {}) {
    const result = [];
    for (const [symbol, position] of this.positions) {
      if (position.isFlat) continue;

      const currentPrice = currentPrices[symbol] || position.avgCost;
      const unrealized = position.unrealizedPnl(currentPrice);
      const mktValue = position.marketValue(currentPrice);
      const unrealizedPct = position.totalCost > 0
        ? unrealized / position.totalCost
        : 0;

      result.push({
        symbol,
        side: position.side,
        qty: position.qty,
        avgCost: round2(position.avgCost),
        currentPrice: round2(currentPrice),
        marketValue: round2(mktValue),
        unrealizedPnl: round2(unrealized),
        unrealizedPnlPct: round4(unrealizedPct),
        realizedPnl: round2(position.realizedPnl),
        todayRealizedPnl: round2(position.todayRealizedPnl),
        openedAt: position.openedAt,
        lastTradeAt: position.lastTradeAt,
        tradeCount: position.tradeCount,
      });
    }

    // Sort by absolute market value descending
    result.sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));
    return result;
  }

  /**
   * Get a single position by symbol.
   *
   * @param {string} symbol
   * @param {number} [currentPrice] — for unrealized P&L computation
   * @returns {Object|null}
   */
  getPosition(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos || pos.isFlat) return null;

    const price = currentPrice || pos.avgCost;
    return {
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      avgCost: round2(pos.avgCost),
      currentPrice: round2(price),
      marketValue: round2(pos.marketValue(price)),
      unrealizedPnl: round2(pos.unrealizedPnl(price)),
      realizedPnl: round2(pos.realizedPnl),
      openedAt: pos.openedAt,
      tradeCount: pos.tradeCount,
    };
  }

  // ─── Exposure Metrics ────────────────────────────────────

  /**
   * Compute long/short/net/gross exposure.
   *
   * @param {Object} [currentPrices] — map of symbol → current price
   * @returns {{ long, short, net, gross, longPct, shortPct, netPct, grossPct, longSymbols, shortSymbols }}
   */
  getExposure(currentPrices = {}) {
    let longExposure = 0;
    let shortExposure = 0;
    const longSymbols = [];
    const shortSymbols = [];

    for (const [symbol, position] of this.positions) {
      if (position.isFlat) continue;

      const price = currentPrices[symbol] || position.avgCost;
      const notional = position.notionalExposure(price);

      if (notional > 0) {
        longExposure += notional;
        longSymbols.push({ symbol, exposure: round2(notional) });
      } else {
        shortExposure += Math.abs(notional);
        shortSymbols.push({ symbol, exposure: round2(Math.abs(notional)) });
      }
    }

    const netExposure = longExposure - shortExposure;
    const grossExposure = longExposure + shortExposure;
    const equity = this.getNAV(currentPrices);

    return {
      long: round2(longExposure),
      short: round2(shortExposure),
      net: round2(netExposure),
      gross: round2(grossExposure),
      longPct: equity > 0 ? round4(longExposure / equity) : 0,
      shortPct: equity > 0 ? round4(shortExposure / equity) : 0,
      netPct: equity > 0 ? round4(netExposure / equity) : 0,
      grossPct: equity > 0 ? round4(grossExposure / equity) : 0,
      longSymbols,
      shortSymbols,
    };
  }

  // ─── NAV Computation ─────────────────────────────────────

  /**
   * Net Asset Value with mark-to-market.
   *
   * @param {Object} [currentPrices] — map of symbol → current price
   * @returns {number} NAV = cash + sum(position market values)
   */
  getNAV(currentPrices = {}) {
    let positionValue = 0;
    for (const [symbol, position] of this.positions) {
      if (position.isFlat) continue;
      const price = currentPrices[symbol] || position.avgCost;
      // For long positions, market value is positive
      // For short positions, we need: short proceeds (already in cash) - current cover cost
      // Since cash already includes proceeds from the short sale,
      // the position contribution is the signed notional
      positionValue += position.notionalExposure(price);
    }
    return round2(this.cash + positionValue);
  }

  // ─── Daily P&L ───────────────────────────────────────────

  /**
   * Today's P&L breakdown by position.
   *
   * @param {Object} [currentPrices] — map of symbol → current price
   * @returns {{ totalPnl, realizedPnl, unrealizedPnl, byPosition, dayStartEquity }}
   */
  getDailyPnL(currentPrices = {}) {
    this._rollDayIfNeeded();

    const byPosition = [];
    let totalUnrealized = 0;
    let totalRealized = 0;

    for (const [symbol, position] of this.positions) {
      const currentPrice = currentPrices[symbol] || position.avgCost;
      const unrealized = position.isFlat ? 0 : position.unrealizedPnl(currentPrice);
      const realized = position.todayRealizedPnl;

      totalUnrealized += unrealized;
      totalRealized += realized;

      if (Math.abs(unrealized) > 0.005 || Math.abs(realized) > 0.005) {
        byPosition.push({
          symbol,
          unrealizedPnl: round2(unrealized),
          realizedPnl: round2(realized),
          totalPnl: round2(unrealized + realized),
          qty: position.qty,
          avgCost: round2(position.avgCost),
          currentPrice: round2(currentPrice),
        });
      }
    }

    byPosition.sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));

    const totalPnl = totalUnrealized + totalRealized;
    const nav = this.getNAV(currentPrices);

    return {
      tradingDay: this.tradingDay,
      totalPnl: round2(totalPnl),
      realizedPnl: round2(totalRealized),
      unrealizedPnl: round2(totalUnrealized),
      totalPnlPct: this.dayStartEquity > 0 ? round4(totalPnl / this.dayStartEquity) : 0,
      dayStartEquity: round2(this.dayStartEquity),
      currentEquity: round2(nav),
      byPosition,
    };
  }

  // ─── Portfolio Summary ───────────────────────────────────

  /**
   * Full portfolio snapshot for risk modules to consume.
   * This is the primary interface for risk-gateway.mjs and circuit-breaker.mjs.
   *
   * @param {Object} [currentPrices] — map of symbol → current price
   * @returns {Object} comprehensive portfolio state
   */
  getPortfolioSummary(currentPrices = {}) {
    this._rollDayIfNeeded();

    const nav = this.getNAV(currentPrices);
    const positions = this.getPositions(currentPrices);
    const exposure = this.getExposure(currentPrices);
    const dailyPnl = this.getDailyPnL(currentPrices);

    const drawdownPct = this.highWaterMark > 0
      ? (this.highWaterMark - nav) / this.highWaterMark
      : 0;

    const activePositionCount = positions.length;
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return {
      timestamp: new Date().toISOString(),
      tradingDay: this.tradingDay,

      // Top-level metrics
      nav: round2(nav),
      cash: round2(this.cash),
      equity: round2(nav),
      dayStartEquity: round2(this.dayStartEquity),
      highWaterMark: round2(this.highWaterMark),

      // P&L
      dailyPnl: dailyPnl.totalPnl,
      dailyPnlPct: dailyPnl.totalPnlPct,
      totalRealizedPnl: round2(this.totalRealizedPnl),
      totalUnrealizedPnl: round2(totalUnrealizedPnl),
      drawdownPct: round4(drawdownPct),

      // Positions
      activePositions: activePositionCount,
      positions,

      // Exposure
      exposure,

      // For risk-gateway compatibility: positions in the format it expects
      portfolioState: {
        equity: round2(nav),
        cash: round2(this.cash),
        positions: positions.map(p => ({
          symbol: p.symbol,
          qty: p.qty,
          value: Math.abs(p.marketValue),
          unrealizedPnl: p.unrealizedPnl,
          currentPrice: p.currentPrice,
        })),
        dailyPnl: dailyPnl.totalPnl,
      },

      // Daily breakdown
      dailyPnlBreakdown: dailyPnl,

      // Metadata
      tradeCount: this.tradeLog.length,
      lastTradeAt: this.lastUpdatedAt,
      createdAt: this.createdAt,
    };
  }

  // ─── Portfolio Reset / Sync ──────────────────────────────

  /**
   * Sync portfolio state from broker (Alpaca) positions.
   * Used to reconcile tracker state with actual broker state.
   *
   * @param {Array} brokerPositions — from alpaca.getPositions()
   * @param {number} cash — from account.cash
   * @param {number} equity — from account.equity
   */
  syncFromBroker(brokerPositions, cash, equity) {
    // Reset positions from broker
    this.positions.clear();

    for (const bp of brokerPositions) {
      const pos = new Position(bp.symbol);
      pos.qty = parseFloat(bp.qty);
      pos.avgCost = parseFloat(bp.avg_entry_price);
      pos.totalCost = Math.abs(pos.qty) * pos.avgCost;
      pos.openedAt = bp.created_at || new Date().toISOString();
      pos.lastTradeAt = new Date().toISOString();
      this.positions.set(bp.symbol, pos);
    }

    this.cash = parseFloat(cash);
    this.highWaterMark = Math.max(this.highWaterMark, parseFloat(equity));
    this.lastUpdatedAt = new Date().toISOString();

    this.saveState();
  }

  /**
   * Reset the portfolio to initial state.
   */
  reset(initialCash) {
    this.positions.clear();
    this.cash = initialCash ?? this.config.initialCash;
    this.tradeLog = [];
    this.dayStartEquity = this.cash;
    this.highWaterMark = this.cash;
    this.tradingDay = todayISO();
    this.totalRealizedPnl = 0;
    this.createdAt = new Date().toISOString();
    this.lastUpdatedAt = this.createdAt;
    this.saveState();
  }

  // ─── State Persistence ───────────────────────────────────

  /**
   * Save current state to disk for crash recovery.
   */
  saveState() {
    try {
      mkdirSync(dirname(this.config.statePath), { recursive: true });

      const state = {
        version: 1,
        savedAt: new Date().toISOString(),
        cash: this.cash,
        dayStartEquity: this.dayStartEquity,
        highWaterMark: this.highWaterMark,
        tradingDay: this.tradingDay,
        totalRealizedPnl: this.totalRealizedPnl,
        createdAt: this.createdAt,
        lastUpdatedAt: this.lastUpdatedAt,
        positions: {},
        tradeLog: this.tradeLog.slice(-100), // keep last 100 trades in state file
      };

      for (const [symbol, position] of this.positions) {
        state.positions[symbol] = position.toJSON();
      }

      writeFileSync(this.config.statePath, JSON.stringify(state, null, 2));
      this.emit("state:saved", { path: this.config.statePath });
    } catch (err) {
      // State save failure is non-fatal but should be logged
      console.error(`[portfolio-tracker] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Load state from disk. Returns true if state was loaded.
   */
  _loadState() {
    try {
      if (!existsSync(this.config.statePath)) return false;

      const raw = readFileSync(this.config.statePath, "utf-8");
      const state = JSON.parse(raw);

      if (!state || state.version !== 1) return false;

      this.cash = state.cash ?? this.config.initialCash;
      this.dayStartEquity = state.dayStartEquity ?? this.cash;
      this.highWaterMark = state.highWaterMark ?? this.cash;
      this.tradingDay = state.tradingDay ?? todayISO();
      this.totalRealizedPnl = state.totalRealizedPnl ?? 0;
      this.createdAt = state.createdAt ?? new Date().toISOString();
      this.lastUpdatedAt = state.lastUpdatedAt ?? this.createdAt;
      this.tradeLog = Array.isArray(state.tradeLog) ? state.tradeLog : [];

      // Restore positions
      this.positions.clear();
      if (state.positions && typeof state.positions === "object") {
        for (const [symbol, posData] of Object.entries(state.positions)) {
          this.positions.set(symbol, Position.fromJSON(posData));
        }
      }

      // Roll day if saved state is from a previous day
      this._rollDayIfNeeded();

      return true;
    } catch (err) {
      console.error(`[portfolio-tracker] Failed to load state: ${err.message}`);
      return false;
    }
  }

  // ─── Internal Helpers ────────────────────────────────────

  /**
   * Estimate current equity using avgCost as price fallback.
   * Used internally when currentPrices map isn't available.
   */
  _estimateEquity(lastTradePrice) {
    return this.getNAV({});
  }

  /**
   * Roll daily counters if the trading day has changed.
   */
  _rollDayIfNeeded() {
    const today = todayISO();
    if (today !== this.tradingDay) {
      // Snapshot equity at day start
      this.dayStartEquity = this.getNAV({});
      this.tradingDay = today;

      // Reset daily realized P&L for each position
      for (const [, position] of this.positions) {
        position.todayRealizedPnl = 0;
      }
    }
  }

  /**
   * Clean up timers on shutdown.
   */
  destroy() {
    if (this._autosaveTimer) {
      clearInterval(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    this.saveState();
    this.removeAllListeners();
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance = null;

/**
 * Get or create the singleton PortfolioTracker.
 *
 * @param {Object} [config] — passed to constructor on first call
 * @returns {PortfolioTracker}
 */
export function getTracker(config) {
  if (!_instance) {
    _instance = new PortfolioTracker(config);
  }
  return _instance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetTracker() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

// ─── Utilities ─────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function round2(n) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}
