/**
 * Capital Allocator — Central Fund Controller
 *
 * The single source of truth for capital deployment across the system.
 * ALL USDC flows through this module:
 *
 *   Revenue Sources:
 *     - x402 API payments (gateway)
 *     - Trading desk realized P&L
 *
 *   Expense Sinks:
 *     - Inference costs (LLM API calls)
 *     - Trading capital deployment
 *     - Creator tax distributions
 *
 *   Autonomous Operations:
 *     - Auto-rebalance on configurable schedule
 *     - Revenue-triggered deployment (new revenue → check allocation)
 *     - Drawdown clawback (protect treasury from trading losses)
 *     - Profit harvest (sweep trading gains back to treasury)
 *     - Survival tier gating (reduce exposure when funds are low)
 *
 * Fund flow:
 *   API Revenue (USDC) ─┐
 *                        ├──► Treasury ──► Capital Allocator ──► Trading Desk
 *   Trading P&L ─────────┘        ▲                                  │
 *                                 └── Harvest / Clawback ◄───────────┘
 *
 * All allocation decisions are logged to the accounting ledger
 * as "internal_treasury_move" transfer events for full auditability.
 */

import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getOnChainBalance, getSurvivalTierFromBalance, transferUSDC } from "../local/treasury.js";
import {
  logTransferEvent,
  logRevenue,
  logExpense,
  estimateDailyBurnCents,
  computePnl,
  computeDailyNetProfit,
} from "../local/accounting.js";
import { createLogger } from "../observability/logger.js";
import { ulid } from "ulid";
import type { Address, PrivateKeyAccount } from "viem";
import type { SurvivalTier } from "../types.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("capital-allocator");

// ── Configuration ───────────────────────────────────────────

export interface AllocationConfig {
  /** Master switch */
  enabled: boolean;
  /** Separate wallet for trading (empty = sub-account in same wallet) */
  trading_wallet_address: string;
  /** Minimum USDC to keep in treasury at all times */
  min_treasury_reserve_usd: number;
  /** Max % of surplus (above reserve) to allocate to trading */
  max_trading_allocation_pct: number;
  /** Hard cap on trading allocation in USD */
  max_trading_allocation_usd: number;
  /** Don't allocate less than this (not worth the gas) */
  min_allocation_usd: number;
  /** Hours between rebalance checks */
  rebalance_interval_hours: number;
  /** Per-tier allocation caps (fraction of max_trading_allocation_pct) */
  survival_tier_gates: Record<string, number>;
  /** Pull back capital if trading drawdown exceeds this % */
  drawdown_clawback_pct: number;
  /** Harvest this fraction of trading profits back to treasury */
  profit_harvest_pct: number;
  /** Only harvest when profits exceed this threshold */
  profit_harvest_threshold_usd: number;
}

const DEFAULT_CONFIG: AllocationConfig = {
  enabled: true,
  trading_wallet_address: "",
  min_treasury_reserve_usd: 50.0,
  max_trading_allocation_pct: 0.40,
  max_trading_allocation_usd: 10_000.0,
  min_allocation_usd: 5.0,
  rebalance_interval_hours: 24,
  survival_tier_gates: {
    high: 0.40,
    normal: 0.25,
    low_compute: 0.0,
    critical: 0.0,
    dead: 0.0,
  },
  drawdown_clawback_pct: 0.10,
  profit_harvest_pct: 0.50,
  profit_harvest_threshold_usd: 1.0,
};

export function loadAllocationConfig(): AllocationConfig {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(thisDir, "..", "..");
    const configPath = path.join(projectRoot, "config", "capital-allocation.json");

    if (!fs.existsSync(configPath)) {
      logger.warn("config/capital-allocation.json not found, using defaults");
      return { ...DEFAULT_CONFIG };
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AllocationConfig>;

    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      survival_tier_gates: {
        ...DEFAULT_CONFIG.survival_tier_gates,
        ...(parsed.survival_tier_gates || {}),
      },
    };
  } catch (err) {
    logger.warn("Failed to load capital-allocation config, using defaults", {
      error: String(err),
    });
    return { ...DEFAULT_CONFIG };
  }
}

// ── Allocation Ledger (SQLite) ──────────────────────────────

const ALLOCATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trading_allocations (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK(direction IN ('deploy','withdraw','harvest','clawback')),
    amount_usd REAL NOT NULL,
    treasury_balance_before_usd REAL NOT NULL,
    trading_balance_before_usd REAL NOT NULL,
    survival_tier TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alloc_direction ON trading_allocations(direction);
  CREATE INDEX IF NOT EXISTS idx_alloc_created ON trading_allocations(created_at);

  CREATE TABLE IF NOT EXISTS trading_desk_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export function initAllocationSchema(db: Database): void {
  db.exec(ALLOCATION_SCHEMA);

  // Seed initial state if empty
  const row = db.prepare("SELECT COUNT(*) as cnt FROM trading_desk_state").get() as { cnt: number };
  if (row.cnt === 0) {
    const seed = db.prepare(
      "INSERT OR IGNORE INTO trading_desk_state (key, value) VALUES (?, ?)"
    );
    seed.run("allocated_usd", "0");
    seed.run("high_water_mark_usd", "0");
    seed.run("total_deployed_usd", "0");
    seed.run("total_harvested_usd", "0");
    seed.run("total_clawback_usd", "0");
    seed.run("last_rebalance_at", "");
    seed.run("trading_pnl_usd", "0");
  }
}

// ── State Accessors ─────────────────────────────────────────

function getState(db: Database, key: string): string {
  const row = db.prepare(
    "SELECT value FROM trading_desk_state WHERE key = ?"
  ).get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

function setState(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO trading_desk_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

// ── Public API ──────────────────────────────────────────────

export interface AllocationState {
  allocatedUsd: number;
  highWaterMarkUsd: number;
  totalDeployedUsd: number;
  totalHarvestedUsd: number;
  totalClawbackUsd: number;
  tradingPnlUsd: number;
  lastRebalanceAt: string;
}

export function getAllocationState(db: Database): AllocationState {
  return {
    allocatedUsd: parseFloat(getState(db, "allocated_usd")) || 0,
    highWaterMarkUsd: parseFloat(getState(db, "high_water_mark_usd")) || 0,
    totalDeployedUsd: parseFloat(getState(db, "total_deployed_usd")) || 0,
    totalHarvestedUsd: parseFloat(getState(db, "total_harvested_usd")) || 0,
    totalClawbackUsd: parseFloat(getState(db, "total_clawback_usd")) || 0,
    tradingPnlUsd: parseFloat(getState(db, "trading_pnl_usd")) || 0,
    lastRebalanceAt: getState(db, "last_rebalance_at"),
  };
}

export interface AllocationDecision {
  action: "deploy" | "withdraw" | "harvest" | "clawback" | "hold" | "disabled" | "insufficient";
  amountUsd: number;
  reason: string;
  currentAllocatedUsd: number;
  targetAllocatedUsd: number;
  treasuryBalanceUsd: number;
  survivalTier: SurvivalTier;
}

/**
 * Compute how much capital should be allocated to the trading desk.
 * Does NOT execute any transfers — call executeAllocation() for that.
 */
export async function computeAllocation(
  db: Database,
  walletAddress: Address,
): Promise<AllocationDecision> {
  const config = loadAllocationConfig();

  if (!config.enabled) {
    return {
      action: "disabled",
      amountUsd: 0,
      reason: "Capital allocation is disabled",
      currentAllocatedUsd: 0,
      targetAllocatedUsd: 0,
      treasuryBalanceUsd: 0,
      survivalTier: "normal",
    };
  }

  // Get treasury state
  const balance = await getOnChainBalance(walletAddress);
  if (!balance.ok) {
    return {
      action: "hold",
      amountUsd: 0,
      reason: `Balance check failed: ${balance.error}`,
      currentAllocatedUsd: 0,
      targetAllocatedUsd: 0,
      treasuryBalanceUsd: 0,
      survivalTier: "normal",
    };
  }

  const dailyBurn = estimateDailyBurnCents(db);
  const tier = getSurvivalTierFromBalance(balance.balanceCents, dailyBurn);
  const state = getAllocationState(db);

  // Check survival tier gate
  const tierAllowedPct = config.survival_tier_gates[tier] ?? 0;
  if (tierAllowedPct <= 0) {
    // If we have capital deployed and tier dropped, trigger clawback
    if (state.allocatedUsd > 0) {
      return {
        action: "clawback",
        amountUsd: state.allocatedUsd,
        reason: `Survival tier "${tier}" does not allow trading — clawback all allocated capital`,
        currentAllocatedUsd: state.allocatedUsd,
        targetAllocatedUsd: 0,
        treasuryBalanceUsd: balance.balanceUsd,
        survivalTier: tier,
      };
    }
    return {
      action: "hold",
      amountUsd: 0,
      reason: `Survival tier "${tier}" does not allow capital allocation to trading`,
      currentAllocatedUsd: state.allocatedUsd,
      targetAllocatedUsd: 0,
      treasuryBalanceUsd: balance.balanceUsd,
      survivalTier: tier,
    };
  }

  // Calculate surplus above reserve
  const surplusUsd = Math.max(0, balance.balanceUsd - config.min_treasury_reserve_usd);

  // Calculate target allocation
  const allocationPct = Math.min(tierAllowedPct, config.max_trading_allocation_pct);
  let targetUsd = surplusUsd * allocationPct;
  targetUsd = Math.min(targetUsd, config.max_trading_allocation_usd);
  targetUsd = Math.round(targetUsd * 100) / 100;

  // Check for drawdown clawback
  if (state.allocatedUsd > 0 && state.highWaterMarkUsd > 0) {
    const currentValue = state.allocatedUsd + state.tradingPnlUsd;
    const drawdownPct = (state.highWaterMarkUsd - currentValue) / state.highWaterMarkUsd;

    if (drawdownPct >= config.drawdown_clawback_pct) {
      const clawbackAmount = Math.round(state.allocatedUsd * 0.5 * 100) / 100; // Pull 50%
      return {
        action: "clawback",
        amountUsd: clawbackAmount,
        reason: `Trading drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds limit ${(config.drawdown_clawback_pct * 100).toFixed(0)}% — clawback 50%`,
        currentAllocatedUsd: state.allocatedUsd,
        targetAllocatedUsd: state.allocatedUsd - clawbackAmount,
        treasuryBalanceUsd: balance.balanceUsd,
        survivalTier: tier,
      };
    }
  }

  // Check for profit harvest
  if (state.tradingPnlUsd >= config.profit_harvest_threshold_usd) {
    const harvestAmount = Math.round(state.tradingPnlUsd * config.profit_harvest_pct * 100) / 100;
    if (harvestAmount > 0) {
      return {
        action: "harvest",
        amountUsd: harvestAmount,
        reason: `Trading profit $${state.tradingPnlUsd.toFixed(2)} — harvesting ${(config.profit_harvest_pct * 100).toFixed(0)}%`,
        currentAllocatedUsd: state.allocatedUsd,
        targetAllocatedUsd: state.allocatedUsd,
        treasuryBalanceUsd: balance.balanceUsd,
        survivalTier: tier,
      };
    }
  }

  // Determine deploy or withdraw
  const delta = targetUsd - state.allocatedUsd;

  if (Math.abs(delta) < config.min_allocation_usd) {
    return {
      action: "hold",
      amountUsd: 0,
      reason: `Allocation delta $${delta.toFixed(2)} below minimum $${config.min_allocation_usd.toFixed(2)} — holding`,
      currentAllocatedUsd: state.allocatedUsd,
      targetAllocatedUsd: targetUsd,
      treasuryBalanceUsd: balance.balanceUsd,
      survivalTier: tier,
    };
  }

  if (delta > 0) {
    // Deploy more capital
    const deployAmount = Math.round(delta * 100) / 100;
    return {
      action: "deploy",
      amountUsd: deployAmount,
      reason: `Deploying $${deployAmount.toFixed(2)} to trading desk (target: $${targetUsd.toFixed(2)}, tier: ${tier}, surplus: $${surplusUsd.toFixed(2)})`,
      currentAllocatedUsd: state.allocatedUsd,
      targetAllocatedUsd: targetUsd,
      treasuryBalanceUsd: balance.balanceUsd,
      survivalTier: tier,
    };
  }

  // Withdraw excess
  const withdrawAmount = Math.round(Math.abs(delta) * 100) / 100;
  return {
    action: "withdraw",
    amountUsd: withdrawAmount,
    reason: `Withdrawing $${withdrawAmount.toFixed(2)} from trading desk (target reduced to $${targetUsd.toFixed(2)})`,
    currentAllocatedUsd: state.allocatedUsd,
    targetAllocatedUsd: targetUsd,
    treasuryBalanceUsd: balance.balanceUsd,
    survivalTier: tier,
  };
}

/**
 * Execute an allocation decision — updates the ledger and state.
 *
 * NOTE: On-chain USDC transfers between wallets are handled separately.
 * If trading_wallet_address is set, the caller must invoke transferUSDC()
 * after this function succeeds. If it's empty (sub-account mode), this
 * just updates the internal ledger and the paper trader reads the
 * allocated capital from the trading_desk_state table.
 */
export function executeAllocation(
  db: Database,
  decision: AllocationDecision,
  walletAddress: string,
): { success: boolean; newAllocatedUsd: number; error?: string } {
  if (decision.action === "hold" || decision.action === "disabled" || decision.action === "insufficient") {
    return { success: true, newAllocatedUsd: decision.currentAllocatedUsd };
  }

  if (decision.amountUsd <= 0) {
    return { success: false, newAllocatedUsd: decision.currentAllocatedUsd, error: "Amount must be positive" };
  }

  const state = getAllocationState(db);
  let newAllocated: number;
  let direction: string;

  switch (decision.action) {
    case "deploy":
      newAllocated = state.allocatedUsd + decision.amountUsd;
      direction = "deploy";
      break;
    case "withdraw":
      newAllocated = Math.max(0, state.allocatedUsd - decision.amountUsd);
      direction = "withdraw";
      break;
    case "harvest":
      newAllocated = state.allocatedUsd; // stays the same, just P&L moves
      direction = "harvest";
      break;
    case "clawback":
      newAllocated = Math.max(0, state.allocatedUsd - decision.amountUsd);
      direction = "clawback";
      break;
    default:
      return { success: false, newAllocatedUsd: state.allocatedUsd, error: `Unknown action: ${decision.action}` };
  }

  newAllocated = Math.round(newAllocated * 100) / 100;

  // Record the allocation event
  db.prepare(
    `INSERT INTO trading_allocations (id, direction, amount_usd, treasury_balance_before_usd,
     trading_balance_before_usd, survival_tier, reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ulid(),
    direction,
    decision.amountUsd,
    decision.treasuryBalanceUsd,
    state.allocatedUsd,
    decision.survivalTier,
    decision.reason,
    JSON.stringify({
      targetAllocatedUsd: decision.targetAllocatedUsd,
      tradingPnlUsd: state.tradingPnlUsd,
    }),
  );

  // Log as an internal treasury move in the transfers table
  logTransferEvent(db, {
    type: "internal_treasury_move",
    fromAccount: direction === "deploy" ? walletAddress : "trading_desk",
    toAccount: direction === "deploy" ? "trading_desk" : walletAddress,
    amountUsd: decision.amountUsd,
    metadata: {
      direction,
      survivalTier: decision.survivalTier,
      reason: decision.reason,
    },
  });

  // Update state
  setState(db, "allocated_usd", String(newAllocated));
  setState(db, "last_rebalance_at", new Date().toISOString());

  // Update high water mark
  if (newAllocated > state.highWaterMarkUsd) {
    setState(db, "high_water_mark_usd", String(newAllocated));
  }

  // Update cumulative totals
  if (direction === "deploy") {
    setState(db, "total_deployed_usd", String(state.totalDeployedUsd + decision.amountUsd));
  } else if (direction === "harvest") {
    setState(db, "total_harvested_usd", String(state.totalHarvestedUsd + decision.amountUsd));
    // Reset trading P&L after harvest
    const newPnl = state.tradingPnlUsd - decision.amountUsd;
    setState(db, "trading_pnl_usd", String(Math.max(0, newPnl)));
  } else if (direction === "clawback") {
    setState(db, "total_clawback_usd", String(state.totalClawbackUsd + decision.amountUsd));
  }

  logger.info(`Allocation executed: ${direction} $${decision.amountUsd.toFixed(2)} — new allocation: $${newAllocated.toFixed(2)}`, {
    direction,
    amount: decision.amountUsd,
    newAllocated,
    tier: decision.survivalTier,
  });

  return { success: true, newAllocatedUsd: newAllocated };
}

/**
 * Record trading P&L from the trading desk.
 * Called by the fund bridge when the paper trader reports P&L.
 */
export function recordTradingPnl(db: Database, pnlUsd: number): void {
  setState(db, "trading_pnl_usd", String(pnlUsd));

  // Update high water mark based on allocated + P&L
  const state = getAllocationState(db);
  const currentValue = state.allocatedUsd + pnlUsd;
  if (currentValue > state.highWaterMarkUsd) {
    setState(db, "high_water_mark_usd", String(currentValue));
  }
}

/**
 * Check if a rebalance is due based on the configured interval.
 */
export function isRebalanceDue(db: Database): boolean {
  const config = loadAllocationConfig();
  if (!config.enabled) return false;

  const lastRebalance = getState(db, "last_rebalance_at");
  if (!lastRebalance) return true;

  const lastTime = new Date(lastRebalance).getTime();
  const intervalMs = config.rebalance_interval_hours * 3600 * 1000;
  return Date.now() - lastTime >= intervalMs;
}

// ── Combined P&L Report ─────────────────────────────────────

export interface CombinedPnlReport {
  /** API service revenue */
  apiRevenueCents: number;
  /** API service expenses (inference, etc.) */
  apiExpenseCents: number;
  /** Net API P&L */
  apiNetCents: number;
  /** Trading desk P&L (from paper/live trading) */
  tradingPnlUsd: number;
  tradingPnlCents: number;
  /** Combined net P&L */
  combinedNetCents: number;
  combinedNetUsd: number;
  /** Capital currently allocated to trading */
  tradingAllocationUsd: number;
  /** Trading return on allocated capital */
  tradingRoiPct: number;
  /** Period */
  period: string;
}

export function computeCombinedPnl(
  db: Database,
  period: "day" | "week" | "month" | "all" = "day",
): CombinedPnlReport {
  const apiPnl = computePnl(db, period);
  const state = getAllocationState(db);

  const tradingPnlCents = Math.round(state.tradingPnlUsd * 100);
  const combinedNetCents = apiPnl.netCents + tradingPnlCents;

  const tradingRoi = state.allocatedUsd > 0
    ? (state.tradingPnlUsd / state.allocatedUsd) * 100
    : 0;

  return {
    apiRevenueCents: apiPnl.totalRevenueCents,
    apiExpenseCents: apiPnl.totalExpenseCents,
    apiNetCents: apiPnl.netCents,
    tradingPnlUsd: state.tradingPnlUsd,
    tradingPnlCents,
    combinedNetCents,
    combinedNetUsd: combinedNetCents / 100,
    tradingAllocationUsd: state.allocatedUsd,
    tradingRoiPct: Math.round(tradingRoi * 100) / 100,
    period,
  };
}

// ── Auto-Rebalance Runner ───────────────────────────────────

/**
 * Full rebalance cycle: compute → execute → write fund bridge state file.
 *
 * This is the function heartbeat tasks and the daemon call.
 * It handles the complete lifecycle:
 *   1. Check if rebalance is needed
 *   2. Compute allocation decision
 *   3. Execute it (update ledger)
 *   4. Write the fund bridge state file so the trading desk picks it up
 *   5. Optionally transfer USDC if using a separate trading wallet
 */
export async function runRebalanceCycle(
  db: Database,
  walletAddress: Address,
  account?: PrivateKeyAccount,
): Promise<{
  executed: boolean;
  decision: AllocationDecision;
  newAllocatedUsd: number;
  error?: string;
}> {
  const decision = await computeAllocation(db, walletAddress);

  if (decision.action === "hold" || decision.action === "disabled") {
    logger.info(`Rebalance: ${decision.action} — ${decision.reason}`);
    return { executed: false, decision, newAllocatedUsd: decision.currentAllocatedUsd };
  }

  // Execute the allocation
  const result = executeAllocation(db, decision, walletAddress);
  if (!result.success) {
    logger.error(`Rebalance failed: ${result.error}`);
    return { executed: false, decision, newAllocatedUsd: result.newAllocatedUsd, error: result.error };
  }

  // Write fund bridge state file for the trading desk to read
  writeFundBridgeState(result.newAllocatedUsd, decision);

  // If using a separate trading wallet, handle the on-chain USDC transfer
  const config = loadAllocationConfig();
  if (config.trading_wallet_address && account) {
    const tradingAddr = config.trading_wallet_address as Address;

    if (decision.action === "deploy") {
      const txResult = await transferUSDC(account, tradingAddr, decision.amountUsd);
      if (!txResult.success) {
        logger.error(`On-chain deploy transfer failed: ${txResult.error}`);
      } else {
        logger.info(`Deployed $${decision.amountUsd.toFixed(2)} USDC to trading wallet (tx: ${txResult.txHash})`);
      }
    }
    // For withdraw/clawback, the trading wallet would need to send back
    // This requires the trading wallet's private key — out of scope for sub-account mode
  }

  logger.info(`Rebalance complete: ${decision.action} $${decision.amountUsd.toFixed(2)} — allocated: $${result.newAllocatedUsd.toFixed(2)}`);
  return { executed: true, decision, newAllocatedUsd: result.newAllocatedUsd };
}

/**
 * Revenue-triggered allocation check.
 * Called by the gateway after successful x402 payment.
 * Only acts if the new revenue pushes us past a deployment threshold.
 */
export async function onRevenueReceived(
  db: Database,
  walletAddress: Address,
  amountCents: number,
): Promise<void> {
  const config = loadAllocationConfig();
  if (!config.enabled) return;

  const state = getAllocationState(db);

  // Only trigger rebalance if we have no allocation yet (first deployment)
  // or if accumulated revenue since last rebalance exceeds threshold
  const balance = await getOnChainBalance(walletAddress);
  if (!balance.ok) return;

  const surplusUsd = Math.max(0, balance.balanceUsd - config.min_treasury_reserve_usd);
  const dailyBurn = estimateDailyBurnCents(db);
  const tier = getSurvivalTierFromBalance(balance.balanceCents, dailyBurn);
  const tierGate = config.survival_tier_gates[tier] ?? 0;

  if (tierGate <= 0) return; // Can't allocate in this tier

  const potentialAllocation = surplusUsd * Math.min(tierGate, config.max_trading_allocation_pct);
  const undeployedDelta = potentialAllocation - state.allocatedUsd;

  // Deploy if delta exceeds minimum and it's been at least 1 hour since last rebalance
  if (undeployedDelta >= config.min_allocation_usd) {
    const lastRebalance = state.lastRebalanceAt;
    const hourAgo = Date.now() - 3_600_000;
    const lastRebalanceTime = lastRebalance ? new Date(lastRebalance).getTime() : 0;

    if (lastRebalanceTime < hourAgo) {
      logger.info(`Revenue trigger: $${(amountCents / 100).toFixed(2)} received, undeployed delta $${undeployedDelta.toFixed(2)} — running rebalance`);
      await runRebalanceCycle(db, walletAddress);
    }
  }
}

// ── Fund Bridge State File Writer ───────────────────────────

/**
 * Write the fund bridge state file that the trading desk reads.
 * This bridges the TypeScript treasury world with the MJS trading world.
 */
function writeFundBridgeState(allocatedUsd: number, decision: AllocationDecision): void {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(thisDir, "..", "..");
    const statePath = path.join(projectRoot, "inferred-analysis", "agents", "state", "fund-bridge-state.json");
    const stateDir = path.dirname(statePath);

    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    // Read existing state and merge
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(statePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      } catch { /* start fresh */ }
    }

    const updated = {
      ...existing,
      allocatedCapitalUsd: allocatedUsd,
      lastSyncTimestamp: new Date().toISOString(),
      lastAllocationAction: decision.action,
      lastAllocationReason: decision.reason,
      survivalTier: decision.survivalTier,
      treasuryBalanceUsd: decision.treasuryBalanceUsd,
      version: 2,
    };

    if (allocatedUsd > 0 && !existing.deployedAtTimestamp) {
      (updated as any).deployedAtTimestamp = new Date().toISOString();
    }

    fs.writeFileSync(statePath, JSON.stringify(updated, null, 2));
    logger.info(`Fund bridge state written: allocated=$${allocatedUsd.toFixed(2)}`);
  } catch (err) {
    logger.warn(`Failed to write fund bridge state: ${err}`);
  }
}

// ── Unified Financial Dashboard ─────────────────────────────

export interface UnifiedDashboard {
  timestamp: string;
  treasuryBalanceUsd: number;
  survivalTier: SurvivalTier;
  dailyBurnUsd: number;
  runwayDays: number;

  // API Revenue Engine
  api: {
    revenueTodayCents: number;
    expenseTodayCents: number;
    netTodayCents: number;
    revenueWeekCents: number;
    expenseWeekCents: number;
    netWeekCents: number;
  };

  // Trading Engine
  trading: {
    allocatedUsd: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalPnlUsd: number;
    roiPct: number;
    highWaterMarkUsd: number;
    maxDrawdownPct: number;
    totalDeployedUsd: number;
    totalHarvestedUsd: number;
    totalClawbackUsd: number;
  };

  // Combined
  combined: {
    netTodayUsd: number;
    netWeekUsd: number;
    totalRevenueAllTimeUsd: number;
    totalExpenseAllTimeUsd: number;
    netAllTimeUsd: number;
  };
}

export async function getUnifiedDashboard(
  db: Database,
  walletAddress: Address,
): Promise<UnifiedDashboard> {
  const balance = await getOnChainBalance(walletAddress);
  const dailyBurnCents = estimateDailyBurnCents(db);
  const tier = getSurvivalTierFromBalance(balance.balanceCents, dailyBurnCents);
  const state = getAllocationState(db);

  const today = new Date().toISOString().slice(0, 10);
  const dailyProfit = computeDailyNetProfit(db, today);
  const weekPnl = computePnl(db, "week");
  const allTimePnl = computePnl(db, "all");

  const dailyBurnUsd = dailyBurnCents / 100;
  const runwayDays = dailyBurnUsd > 0 ? balance.balanceUsd / dailyBurnUsd : 999;

  const tradingTotal = state.tradingPnlUsd;
  const tradingRoi = state.allocatedUsd > 0 ? (tradingTotal / state.allocatedUsd) * 100 : 0;

  // Read fund bridge state for unrealized P&L breakdown
  let unrealizedPnl = 0;
  let realizedPnl = tradingTotal;
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(thisDir, "..", "..");
    const bridgePath = path.join(projectRoot, "inferred-analysis", "agents", "state", "fund-bridge-state.json");
    if (fs.existsSync(bridgePath)) {
      const bridgeState = JSON.parse(fs.readFileSync(bridgePath, "utf-8"));
      unrealizedPnl = bridgeState.cumulativeUnrealizedPnl ?? 0;
      realizedPnl = bridgeState.cumulativeRealizedPnl ?? tradingTotal;
    }
  } catch { /* use defaults */ }

  // Read max drawdown from fund bridge
  let maxDrawdownPct = 0;
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(thisDir, "..", "..");
    const bridgePath = path.join(projectRoot, "inferred-analysis", "agents", "state", "fund-bridge-state.json");
    if (fs.existsSync(bridgePath)) {
      const bridgeState = JSON.parse(fs.readFileSync(bridgePath, "utf-8"));
      maxDrawdownPct = bridgeState.maxDrawdownPct ?? 0;
    }
  } catch { /* use default */ }

  return {
    timestamp: new Date().toISOString(),
    treasuryBalanceUsd: balance.balanceUsd,
    survivalTier: tier,
    dailyBurnUsd,
    runwayDays: Math.round(runwayDays),

    api: {
      revenueTodayCents: dailyProfit.revenueCents,
      expenseTodayCents: dailyProfit.expenseCents,
      netTodayCents: dailyProfit.netProfitCents,
      revenueWeekCents: weekPnl.totalRevenueCents,
      expenseWeekCents: weekPnl.totalExpenseCents,
      netWeekCents: weekPnl.netCents,
    },

    trading: {
      allocatedUsd: state.allocatedUsd,
      realizedPnlUsd: realizedPnl,
      unrealizedPnlUsd: unrealizedPnl,
      totalPnlUsd: tradingTotal,
      roiPct: Math.round(tradingRoi * 100) / 100,
      highWaterMarkUsd: state.highWaterMarkUsd,
      maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 10000,
      totalDeployedUsd: state.totalDeployedUsd,
      totalHarvestedUsd: state.totalHarvestedUsd,
      totalClawbackUsd: state.totalClawbackUsd,
    },

    combined: {
      netTodayUsd: dailyProfit.netProfitCents / 100 + tradingTotal,
      netWeekUsd: weekPnl.netCents / 100 + tradingTotal,
      totalRevenueAllTimeUsd: allTimePnl.totalRevenueCents / 100,
      totalExpenseAllTimeUsd: allTimePnl.totalExpenseCents / 100,
      netAllTimeUsd: allTimePnl.netCents / 100 + tradingTotal,
    },
  };
}

/**
 * Format the unified dashboard as a human-readable report.
 */
export function formatDashboard(d: UnifiedDashboard): string {
  return [
    "══════════════════════════════════════════════════════",
    "  UNIFIED FINANCIAL DASHBOARD",
    `  ${d.timestamp}`,
    "══════════════════════════════════════════════════════",
    "",
    `  Treasury:    $${d.treasuryBalanceUsd.toFixed(2)} USDC`,
    `  Tier:        ${d.survivalTier.toUpperCase()}`,
    `  Daily Burn:  $${d.dailyBurnUsd.toFixed(2)}/day`,
    `  Runway:      ${d.runwayDays} days`,
    "",
    "  ── API Revenue Engine ──",
    `  Today:       +$${(d.api.revenueTodayCents / 100).toFixed(2)} rev  -$${(d.api.expenseTodayCents / 100).toFixed(2)} exp  =$${(d.api.netTodayCents / 100).toFixed(2)} net`,
    `  This Week:   +$${(d.api.revenueWeekCents / 100).toFixed(2)} rev  -$${(d.api.expenseWeekCents / 100).toFixed(2)} exp  =$${(d.api.netWeekCents / 100).toFixed(2)} net`,
    "",
    "  ── Trading Engine ──",
    `  Allocated:   $${d.trading.allocatedUsd.toFixed(2)}`,
    `  Realized:    $${d.trading.realizedPnlUsd.toFixed(2)}`,
    `  Unrealized:  $${d.trading.unrealizedPnlUsd.toFixed(2)}`,
    `  Total P&L:   $${d.trading.totalPnlUsd.toFixed(2)} (${d.trading.roiPct.toFixed(2)}% ROI)`,
    `  HWM:         $${d.trading.highWaterMarkUsd.toFixed(2)}`,
    `  Max DD:      ${(d.trading.maxDrawdownPct * 100).toFixed(2)}%`,
    `  Deployed:    $${d.trading.totalDeployedUsd.toFixed(2)} total`,
    `  Harvested:   $${d.trading.totalHarvestedUsd.toFixed(2)} total`,
    `  Clawback:    $${d.trading.totalClawbackUsd.toFixed(2)} total`,
    "",
    "  ── Combined ──",
    `  Net Today:     $${d.combined.netTodayUsd.toFixed(2)}`,
    `  Net This Week: $${d.combined.netWeekUsd.toFixed(2)}`,
    `  Net All Time:  $${d.combined.netAllTimeUsd.toFixed(2)}`,
    "══════════════════════════════════════════════════════",
  ].join("\n");
}
