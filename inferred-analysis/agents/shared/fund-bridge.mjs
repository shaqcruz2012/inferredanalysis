#!/usr/bin/env node
/**
 * Fund Bridge — Connects Treasury Capital Allocator to Trading Desk
 *
 * This module bridges the Datchi treasury (USDC on Base L2) with the
 * quant trading desk (Alpaca paper/live). It:
 *
 *   1. Reads allocation state from the treasury's SQLite database
 *   2. Maps allocated capital to trading desk buying power
 *   3. Reports trading P&L back to the treasury allocator
 *   4. Enforces capital limits on the paper trader
 *
 * The fund bridge operates in two modes:
 *   - Sub-account mode (default): Same wallet, internal ledger tracking.
 *     The paper trader reads allocated capital from a state file.
 *   - Separate wallet mode: USDC is transferred to a dedicated trading wallet.
 *
 * Usage:
 *   import { FundBridge } from '../shared/fund-bridge.mjs';
 *   const bridge = new FundBridge();
 *   const capital = bridge.getAllocatedCapital();
 *   bridge.reportPnl(dailyPnl);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getTracker } from "./portfolio-tracker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const STATE_DIR = join(AGENTS_DIR, "state");
const BRIDGE_STATE_PATH = join(STATE_DIR, "fund-bridge-state.json");

// Path to the main project's config
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const ALLOC_CONFIG_PATH = join(PROJECT_ROOT, "config", "capital-allocation.json");

// ─── Default State ────────────────────────────────────────

const DEFAULT_STATE = {
  allocatedCapitalUsd: 0,
  deployedAtTimestamp: null,
  lastPnlReportUsd: 0,
  cumulativeRealizedPnl: 0,
  cumulativeUnrealizedPnl: 0,
  totalTradesExecuted: 0,
  highWaterMarkUsd: 0,
  maxDrawdownPct: 0,
  lastSyncTimestamp: null,
  version: 1,
};

// ─── Fund Bridge ──────────────────────────────────────────

export class FundBridge {
  constructor(options = {}) {
    this.statePath = options.statePath || BRIDGE_STATE_PATH;
    this.configPath = options.configPath || ALLOC_CONFIG_PATH;
    this.state = this._loadState();
    this.config = this._loadConfig();
  }

  // ── State Persistence ───────────────────────────────────

  _loadState() {
    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, "utf-8");
        return { ...DEFAULT_STATE, ...JSON.parse(raw) };
      }
    } catch (err) {
      console.warn(`[fund-bridge] Failed to load state: ${err.message}`);
    }
    return { ...DEFAULT_STATE };
  }

  _saveState() {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[fund-bridge] Failed to save state: ${err.message}`);
    }
  }

  _loadConfig() {
    try {
      if (existsSync(this.configPath)) {
        return JSON.parse(readFileSync(this.configPath, "utf-8"));
      }
    } catch (err) {
      console.warn(`[fund-bridge] Failed to load config: ${err.message}`);
    }
    return {
      enabled: false,
      min_treasury_reserve_usd: 50,
      max_trading_allocation_pct: 0.40,
      max_trading_allocation_usd: 10_000,
      drawdown_clawback_pct: 0.10,
    };
  }

  // ── Capital Queries ─────────────────────────────────────

  /**
   * Get the current capital allocated to the trading desk.
   * This is the amount the paper trader is allowed to use.
   */
  getAllocatedCapital() {
    return this.state.allocatedCapitalUsd;
  }

  /**
   * Check if there is any capital allocated for trading.
   */
  isCapitalAvailable() {
    return this.config.enabled && this.state.allocatedCapitalUsd > 0;
  }

  /**
   * Get the maximum position size allowed, given allocated capital.
   * Respects both the per-position risk limit and total allocation.
   */
  getMaxPositionSize(riskPct = 0.25) {
    const allocated = this.state.allocatedCapitalUsd;
    return Math.floor(allocated * riskPct * 100) / 100;
  }

  /**
   * Get the effective buying power for the trading desk.
   * Takes into account current positions and unrealized P&L.
   */
  getEffectiveBuyingPower(currentPositionValueUsd = 0) {
    const allocated = this.state.allocatedCapitalUsd;
    const available = allocated - currentPositionValueUsd + this.state.cumulativeUnrealizedPnl;
    return Math.max(0, Math.floor(available * 100) / 100);
  }

  // ── Capital Updates (called by allocator) ───────────────

  /**
   * Update the allocated capital. Called when the capital allocator
   * deploys or withdraws funds.
   */
  updateAllocation(newAmountUsd, reason = "") {
    const prev = this.state.allocatedCapitalUsd;
    this.state.allocatedCapitalUsd = newAmountUsd;
    this.state.lastSyncTimestamp = new Date().toISOString();

    if (newAmountUsd > this.state.highWaterMarkUsd) {
      this.state.highWaterMarkUsd = newAmountUsd;
    }

    if (!this.state.deployedAtTimestamp && newAmountUsd > 0) {
      this.state.deployedAtTimestamp = new Date().toISOString();
    }

    this._saveState();

    const delta = newAmountUsd - prev;
    const direction = delta > 0 ? "deployed" : delta < 0 ? "withdrawn" : "unchanged";
    console.log(
      `[fund-bridge] Capital ${direction}: $${prev.toFixed(2)} → $${newAmountUsd.toFixed(2)}` +
      (reason ? ` (${reason})` : "")
    );

    return { previous: prev, current: newAmountUsd, delta, direction };
  }

  // ── P&L Reporting (called by paper trader) ──────────────

  /**
   * Report current P&L from the trading desk back to the bridge.
   * The capital allocator reads this to decide on harvests/clawbacks.
   *
   * @param {object} pnl
   * @param {number} pnl.realizedPnl - Total realized P&L
   * @param {number} pnl.unrealizedPnl - Current unrealized P&L
   * @param {number} pnl.totalTrades - Total trades executed
   */
  reportPnl(pnl) {
    this.state.cumulativeRealizedPnl = pnl.realizedPnl ?? this.state.cumulativeRealizedPnl;
    this.state.cumulativeUnrealizedPnl = pnl.unrealizedPnl ?? this.state.cumulativeUnrealizedPnl;
    this.state.totalTradesExecuted = pnl.totalTrades ?? this.state.totalTradesExecuted;

    const totalPnl = this.state.cumulativeRealizedPnl + this.state.cumulativeUnrealizedPnl;
    this.state.lastPnlReportUsd = totalPnl;

    // Track max drawdown
    const currentValue = this.state.allocatedCapitalUsd + totalPnl;
    if (this.state.highWaterMarkUsd > 0 && currentValue < this.state.highWaterMarkUsd) {
      const drawdownPct = (this.state.highWaterMarkUsd - currentValue) / this.state.highWaterMarkUsd;
      if (drawdownPct > this.state.maxDrawdownPct) {
        this.state.maxDrawdownPct = drawdownPct;
      }
    }

    this.state.lastSyncTimestamp = new Date().toISOString();
    this._saveState();

    return {
      totalPnl,
      drawdownPct: this.state.maxDrawdownPct,
      capitalReturn: this.state.allocatedCapitalUsd > 0
        ? (totalPnl / this.state.allocatedCapitalUsd) * 100
        : 0,
    };
  }

  /**
   * Sync P&L from the portfolio tracker automatically.
   * Reads current positions and computes P&L against allocated capital.
   */
  syncFromTracker(currentPrices = {}) {
    const tracker = getTracker();
    const positions = tracker.getPositions();
    const summary = tracker.getPortfolioSummary(currentPrices);

    let totalRealized = 0;
    let totalUnrealized = 0;

    for (const pos of positions) {
      totalRealized += pos.realizedPnl || 0;
      const price = currentPrices[pos.symbol];
      if (price && pos.qty !== 0) {
        totalUnrealized += pos.unrealizedPnl(price);
      }
    }

    return this.reportPnl({
      realizedPnl: totalRealized,
      unrealizedPnl: totalUnrealized,
      totalTrades: summary.totalTrades ?? this.state.totalTradesExecuted,
    });
  }

  // ── Drawdown Check ──────────────────────────────────────

  /**
   * Check if the trading desk has breached the drawdown limit.
   * Returns true if the capital allocator should clawback funds.
   */
  isDrawdownBreached() {
    const limit = this.config.drawdown_clawback_pct || 0.10;
    return this.state.maxDrawdownPct >= limit;
  }

  // ── Bidirectional Sync ────────────────────────────────────

  /**
   * Pull latest allocation from the allocator's state file.
   * The capital allocator writes fund-bridge-state.json when
   * it makes allocation decisions. This method reads it and
   * updates the bridge state to stay in sync.
   */
  pullFromAllocator() {
    try {
      if (!existsSync(this.statePath)) return false;

      const raw = readFileSync(this.statePath, "utf-8");
      const allocatorState = JSON.parse(raw);

      // Only update if allocator has written to this file (version 2+)
      if (allocatorState.version >= 2 && allocatorState.allocatedCapitalUsd !== undefined) {
        const prevAllocated = this.state.allocatedCapitalUsd;
        this.state.allocatedCapitalUsd = allocatorState.allocatedCapitalUsd;
        this.state.lastSyncTimestamp = new Date().toISOString();

        if (allocatorState.allocatedCapitalUsd > this.state.highWaterMarkUsd) {
          this.state.highWaterMarkUsd = allocatorState.allocatedCapitalUsd;
        }

        if (!this.state.deployedAtTimestamp && allocatorState.allocatedCapitalUsd > 0) {
          this.state.deployedAtTimestamp = allocatorState.deployedAtTimestamp || new Date().toISOString();
        }

        // Don't save yet — caller may want to also report P&L before saving
        const delta = allocatorState.allocatedCapitalUsd - prevAllocated;
        if (Math.abs(delta) > 0.01) {
          console.log(
            `[fund-bridge] Pulled allocation from allocator: $${prevAllocated.toFixed(2)} → $${allocatorState.allocatedCapitalUsd.toFixed(2)}` +
            ` (${allocatorState.lastAllocationAction || "sync"}: ${allocatorState.lastAllocationReason || ""})`
          );
        }

        return true;
      }
    } catch (err) {
      console.warn(`[fund-bridge] Failed to pull from allocator: ${err.message}`);
    }
    return false;
  }

  /**
   * Full sync cycle: pull allocation, sync P&L, write back.
   * This is the recommended way to keep the bridge in sync.
   */
  fullSync(currentPrices = {}) {
    // 1. Pull latest allocation from the capital allocator
    this.pullFromAllocator();

    // 2. Sync P&L from the portfolio tracker
    const pnlReport = this.syncFromTracker(currentPrices);

    // 3. Save state
    this._saveState();

    return {
      allocatedCapital: this.state.allocatedCapitalUsd,
      ...pnlReport,
      drawdownBreached: this.isDrawdownBreached(),
    };
  }

  // ── Status Report ───────────────────────────────────────

  /**
   * Generate a human-readable status report for the fund bridge.
   */
  getStatusReport() {
    const s = this.state;
    const totalPnl = s.cumulativeRealizedPnl + s.cumulativeUnrealizedPnl;
    const roi = s.allocatedCapitalUsd > 0
      ? ((totalPnl / s.allocatedCapitalUsd) * 100).toFixed(2)
      : "0.00";

    return [
      "═══════════════════════════════════════════",
      "  FUND BRIDGE STATUS",
      "═══════════════════════════════════════════",
      `  Allocated Capital:   $${s.allocatedCapitalUsd.toFixed(2)}`,
      `  Realized P&L:        $${s.cumulativeRealizedPnl.toFixed(2)}`,
      `  Unrealized P&L:      $${s.cumulativeUnrealizedPnl.toFixed(2)}`,
      `  Total P&L:           $${totalPnl.toFixed(2)}`,
      `  ROI:                 ${roi}%`,
      `  High Water Mark:     $${s.highWaterMarkUsd.toFixed(2)}`,
      `  Max Drawdown:        ${(s.maxDrawdownPct * 100).toFixed(2)}%`,
      `  Total Trades:        ${s.totalTradesExecuted}`,
      `  Deployed At:         ${s.deployedAtTimestamp || "never"}`,
      `  Last Sync:           ${s.lastSyncTimestamp || "never"}`,
      `  Drawdown Breached:   ${this.isDrawdownBreached() ? "YES" : "no"}`,
      "═══════════════════════════════════════════",
    ].join("\n");
  }
}

// ─── Singleton ────────────────────────────────────────────

let _instance = null;

/**
 * Get or create the singleton FundBridge instance.
 */
export function getBridge(options) {
  if (!_instance) {
    _instance = new FundBridge(options);
  }
  return _instance;
}
