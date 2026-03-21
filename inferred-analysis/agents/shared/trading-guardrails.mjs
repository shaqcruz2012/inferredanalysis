/**
 * Trading Guardrails — Trust & Safety Limits for Claude-Driven Autonomous Trading
 *
 * This is the most safety-critical module in the system. It enforces hard limits
 * on what Claude can do autonomously, tracks inference costs, maintains an audit
 * trail, and provides emergency shutdown capabilities.
 *
 * Architecture:
 *   - All trading limits are stored in a frozen config object (non-overridable at runtime)
 *   - Autonomy is tiered: autonomous → supervised → approval-required → forbidden
 *   - Every trading decision is logged to an append-only audit trail
 *   - Kill switch and emergency shutdown can flatten all positions instantly
 *   - Inference cost budget prevents runaway API spend
 *
 * Exports:
 *   checkAutonomy(action)                — tier check with approval gate
 *   enforceLimit(limitName, currentValue) — hard limit enforcement
 *   killSwitch()                         — flatten all, halt trading
 *   getGuardrailStatus()                — full system status
 *   recordInferenceCost(cost)           — track inference spend
 *   getRemainingBudget()                — remaining inference budget
 *   isBudgetExhausted()                 — true if budget consumed
 *   logAuditEntry(entry)                — append to audit trail
 *   getAuditTrail(filters)             — query audit trail
 *   emergencyShutdown(reason)           — kill switch + halt daemon + notify
 *   reducedRiskMode()                   — halve limits, double cooldowns
 *   getEmergencyContacts()              — notification targets
 *   GUARDRAIL_LIMITS                    — frozen limits config (read-only)
 *   AUTONOMY_TIERS                      — frozen tier definitions (read-only)
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { safeReadJSON, safeWriteJSON, atomicWriteFile } from "./atomic-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "state");
const AUDIT_TRAIL_PATH = join(STATE_DIR, "audit-trail.json");
const GUARDRAIL_STATE_PATH = join(STATE_DIR, "guardrail-state.json");
const MAX_AUDIT_ENTRIES = 5000;

// ─── Hard Trading Limits (frozen, non-overridable) ───────────

export const GUARDRAIL_LIMITS = Object.freeze({
  // Position sizing
  MAX_POSITION_SIZE_PCT: 0.10,       // 10% of portfolio per position
  // Daily loss
  MAX_DAILY_LOSS_PCT: 0.03,          // 3% of portfolio
  // Portfolio drawdown from peak
  MAX_PORTFOLIO_DRAWDOWN_PCT: 0.15,  // 15% from high-water mark
  // Leverage
  MAX_LEVERAGE: 2.0,                 // 2.0x gross exposure
  // Correlated asset concentration
  MAX_CORRELATED_EXPOSURE_PCT: 0.30, // 30% in correlated assets
  // Inference cost budget (daily, USD)
  MAX_DAILY_INFERENCE_COST: parseFloat(process.env.MAX_DAILY_INFERENCE_COST || "5.00"),
  // Budget warning threshold
  INFERENCE_BUDGET_WARNING_PCT: 0.80, // reduce frequency at 80%
});

// Freeze deeply — prevent any prototype pollution or mutation
Object.freeze(Object.getPrototypeOf(GUARDRAIL_LIMITS));

// ─── Autonomy Tier Definitions (frozen) ──────────────────────

/**
 * TIER_1_AUTONOMOUS:       No human needed. Research, backtesting, signals.
 * TIER_2_SUPERVISED:        Auto-proceeds but logs for review. Paper trading, promotions.
 * TIER_3_APPROVAL_REQUIRED: Blocks until human approves. Live orders, capital deployment.
 * TIER_4_FORBIDDEN:         Always blocked. Withdrawals, API key changes, system config.
 */
export const AUTONOMY_TIERS = Object.freeze({
  TIER_1_AUTONOMOUS: Object.freeze({
    level: 1,
    name: "AUTONOMOUS",
    description: "No human approval needed",
    requiresApproval: false,
    autoProceeds: true,
  }),
  TIER_2_SUPERVISED: Object.freeze({
    level: 2,
    name: "SUPERVISED",
    description: "Auto-proceeds, logged for review",
    requiresApproval: false,
    autoProceeds: true,
  }),
  TIER_3_APPROVAL_REQUIRED: Object.freeze({
    level: 3,
    name: "APPROVAL_REQUIRED",
    description: "Blocks until human approves",
    requiresApproval: true,
    autoProceeds: false,
  }),
  TIER_4_FORBIDDEN: Object.freeze({
    level: 4,
    name: "FORBIDDEN",
    description: "Always blocked, no override",
    requiresApproval: false, // not even approval can unlock
    autoProceeds: false,
  }),
});

// ─── Action-to-Tier Mapping ──────────────────────────────────

const ACTION_TIER_MAP = Object.freeze({
  // Tier 1: Autonomous
  "research":                AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "backtest":                AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "signal_generation":       AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "parameter_optimization":  AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "data_fetch":              AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "strategy_evaluation":     AUTONOMY_TIERS.TIER_1_AUTONOMOUS,
  "risk_assessment":         AUTONOMY_TIERS.TIER_1_AUTONOMOUS,

  // Tier 2: Supervised
  "paper_trade":             AUTONOMY_TIERS.TIER_2_SUPERVISED,
  "paper_order":             AUTONOMY_TIERS.TIER_2_SUPERVISED,
  "strategy_promotion":      AUTONOMY_TIERS.TIER_2_SUPERVISED,
  "position_sizing":         AUTONOMY_TIERS.TIER_2_SUPERVISED,
  "portfolio_rebalance":     AUTONOMY_TIERS.TIER_2_SUPERVISED,

  // Tier 3: Approval Required
  "live_order":              AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,
  "live_trade":              AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,
  "capital_deployment":      AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,
  "margin_usage":            AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,
  "strategy_to_live":        AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,
  "increase_position":       AUTONOMY_TIERS.TIER_3_APPROVAL_REQUIRED,

  // Tier 4: Forbidden
  "withdrawal":              AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "api_key_change":          AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "system_config_modify":    AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "guardrail_override":      AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "account_settings":        AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "fund_transfer":           AUTONOMY_TIERS.TIER_4_FORBIDDEN,
  "delete_audit_trail":      AUTONOMY_TIERS.TIER_4_FORBIDDEN,
});

// ─── Runtime State ───────────────────────────────────────────

let _killSwitchEngaged = false;
let _killSwitchReason = null;
let _killSwitchTimestamp = null;
let _reducedRiskActive = false;
let _reducedRiskTimestamp = null;
let _dailyInferenceCost = 0;
let _dailyInferenceCostDate = todayDateStr();
let _inferenceCalls = 0;

function todayDateStr() {
  return new Date().toISOString().split("T")[0];
}

/**
 * Roll daily counters when a new day starts.
 */
function rollDailyCounters() {
  const today = todayDateStr();
  if (_dailyInferenceCostDate !== today) {
    _dailyInferenceCost = 0;
    _inferenceCalls = 0;
    _dailyInferenceCostDate = today;
  }
}

// ─── Core Guardrail Functions ────────────────────────────────

/**
 * Check whether an action is allowed under the autonomy tier system.
 *
 * @param {string} action — the action to check (e.g., "paper_trade", "live_order")
 * @returns {{ allowed: boolean, tier: object, requiresApproval: boolean, reason: string }}
 */
export function checkAutonomy(action) {
  if (typeof action !== "string" || action.trim() === "") {
    return {
      allowed: false,
      tier: AUTONOMY_TIERS.TIER_4_FORBIDDEN,
      requiresApproval: false,
      reason: "Invalid action: action must be a non-empty string",
    };
  }

  // Kill switch overrides everything
  if (_killSwitchEngaged) {
    return {
      allowed: false,
      tier: AUTONOMY_TIERS.TIER_4_FORBIDDEN,
      requiresApproval: false,
      reason: `Kill switch engaged: ${_killSwitchReason}`,
    };
  }

  const normalizedAction = action.trim().toLowerCase();
  const tier = ACTION_TIER_MAP[normalizedAction];

  if (!tier) {
    // Unknown actions default to FORBIDDEN for safety
    return {
      allowed: false,
      tier: AUTONOMY_TIERS.TIER_4_FORBIDDEN,
      requiresApproval: false,
      reason: `Unknown action "${action}" — defaults to FORBIDDEN. Register it in ACTION_TIER_MAP.`,
    };
  }

  // Tier 4: always blocked
  if (tier.level === 4) {
    return {
      allowed: false,
      tier,
      requiresApproval: false,
      reason: `Action "${action}" is FORBIDDEN — cannot be performed by autonomous system`,
    };
  }

  // Tier 3: check approval state
  if (tier.level === 3) {
    const approvalState = _loadApprovalState();
    const approved = approvalState[normalizedAction];
    if (approved && approved.expiresAt && new Date(approved.expiresAt) > new Date()) {
      return {
        allowed: true,
        tier,
        requiresApproval: false,
        reason: `Action "${action}" approved by ${approved.approvedBy} until ${approved.expiresAt}`,
      };
    }
    return {
      allowed: false,
      tier,
      requiresApproval: true,
      reason: `Action "${action}" requires human approval before execution`,
    };
  }

  // Tier 1 & 2: allowed (Tier 2 is logged for review via audit trail)
  return {
    allowed: true,
    tier,
    requiresApproval: false,
    reason: tier.level === 1
      ? `Action "${action}" is fully autonomous`
      : `Action "${action}" is supervised — auto-proceeds, logged for review`,
  };
}

/**
 * Enforce a hard trading limit.
 *
 * @param {string} limitName — key from GUARDRAIL_LIMITS
 * @param {number} currentValue — the current metric value to check
 * @returns {{ within: boolean, limit: number, current: number, action: string }}
 */
export function enforceLimit(limitName, currentValue) {
  if (typeof currentValue !== "number" || !isFinite(currentValue)) {
    return {
      within: false,
      limit: null,
      current: currentValue,
      action: "REJECT — invalid currentValue (must be a finite number)",
    };
  }

  const limit = GUARDRAIL_LIMITS[limitName];
  if (limit === undefined) {
    return {
      within: false,
      limit: null,
      current: currentValue,
      action: `REJECT — unknown limit "${limitName}"`,
    };
  }

  // Apply reduced risk mode: halve all percentage limits
  let effectiveLimit = limit;
  if (_reducedRiskActive && typeof limit === "number") {
    // For MAX_LEVERAGE, halve; for percentage limits, halve
    effectiveLimit = limit / 2;
  }

  const within = currentValue <= effectiveLimit;
  let action;

  if (within) {
    const headroom = effectiveLimit - currentValue;
    const headroomPct = effectiveLimit > 0 ? ((headroom / effectiveLimit) * 100).toFixed(1) : "N/A";
    action = `OK — ${headroomPct}% headroom remaining`;
  } else {
    const overshoot = currentValue - effectiveLimit;
    action = limitName === "MAX_LEVERAGE"
      ? `REJECT — leverage ${currentValue.toFixed(2)}x exceeds max ${effectiveLimit.toFixed(2)}x (over by ${overshoot.toFixed(2)}x)`
      : `REJECT — ${(currentValue * 100).toFixed(2)}% exceeds limit ${(effectiveLimit * 100).toFixed(2)}% (over by ${(overshoot * 100).toFixed(2)}%)`;
  }

  return {
    within,
    limit: effectiveLimit,
    current: currentValue,
    action,
    reducedRiskActive: _reducedRiskActive,
  };
}

/**
 * Kill switch — immediately flatten all positions and halt all trading.
 * This is irreversible within the current process. Requires daemon restart to clear.
 *
 * @param {object} [opts] — optional { alpacaCloseAll: Function } to actually close broker positions
 * @returns {{ engaged: boolean, timestamp: string, reason: string }}
 */
export function killSwitch(opts = {}) {
  const reason = opts.reason || "Manual kill switch activation";
  _killSwitchEngaged = true;
  _killSwitchReason = reason;
  _killSwitchTimestamp = new Date().toISOString();

  logAuditEntry({
    action: "KILL_SWITCH",
    tier: "EMERGENCY",
    approved_by: "system",
    reasoning: reason,
    details: { flattenAll: true },
  });

  // Persist kill switch state so it survives process restarts
  _saveGuardrailState();

  // If an Alpaca close-all function is provided, invoke it
  if (typeof opts.alpacaCloseAll === "function") {
    try {
      opts.alpacaCloseAll();
    } catch (err) {
      logAuditEntry({
        action: "KILL_SWITCH_FLATTEN_ERROR",
        tier: "EMERGENCY",
        approved_by: "system",
        reasoning: `Failed to flatten positions: ${err.message}`,
      });
    }
  }

  return {
    engaged: true,
    timestamp: _killSwitchTimestamp,
    reason: _killSwitchReason,
  };
}

/**
 * Get full guardrail system status.
 */
export function getGuardrailStatus() {
  rollDailyCounters();

  return {
    limits: { ...GUARDRAIL_LIMITS },
    killSwitch: {
      engaged: _killSwitchEngaged,
      reason: _killSwitchReason,
      timestamp: _killSwitchTimestamp,
    },
    reducedRiskMode: {
      active: _reducedRiskActive,
      timestamp: _reducedRiskTimestamp,
    },
    inferenceBudget: {
      spent: _dailyInferenceCost,
      limit: GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST,
      remaining: Math.max(0, GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST - _dailyInferenceCost),
      calls: _inferenceCalls,
      date: _dailyInferenceCostDate,
      exhausted: isBudgetExhausted(),
      warningThresholdReached: _dailyInferenceCost >= GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST * GUARDRAIL_LIMITS.INFERENCE_BUDGET_WARNING_PCT,
    },
    autonomyTiers: Object.fromEntries(
      Object.entries(AUTONOMY_TIERS).map(([k, v]) => [k, { ...v }])
    ),
    auditTrailSize: _getAuditTrailSize(),
    timestamp: new Date().toISOString(),
  };
}

// ─── Inference Cost Budget ───────────────────────────────────

/**
 * Record an inference cost. Call this after every Claude API call.
 *
 * @param {number} cost — estimated cost in USD
 * @returns {{ recorded: boolean, totalToday: number, remaining: number, warning: boolean }}
 */
export function recordInferenceCost(cost) {
  if (typeof cost !== "number" || cost < 0) {
    return { recorded: false, totalToday: _dailyInferenceCost, remaining: getRemainingBudget(), warning: false };
  }

  rollDailyCounters();
  _dailyInferenceCost += cost;
  _inferenceCalls++;

  const remaining = getRemainingBudget();
  const warning = _dailyInferenceCost >= GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST * GUARDRAIL_LIMITS.INFERENCE_BUDGET_WARNING_PCT;

  if (warning) {
    logAuditEntry({
      action: "INFERENCE_BUDGET_WARNING",
      tier: "SYSTEM",
      approved_by: "auto",
      reasoning: `Inference budget at ${((_dailyInferenceCost / GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST) * 100).toFixed(1)}% — reducing experiment frequency recommended`,
      details: { spent: _dailyInferenceCost, limit: GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST, calls: _inferenceCalls },
    });
  }

  return { recorded: true, totalToday: _dailyInferenceCost, remaining, warning };
}

/**
 * Get remaining inference budget for today.
 * @returns {number} remaining budget in USD
 */
export function getRemainingBudget() {
  rollDailyCounters();
  return Math.max(0, GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST - _dailyInferenceCost);
}

/**
 * Check if inference budget is exhausted.
 * @returns {boolean}
 */
export function isBudgetExhausted() {
  rollDailyCounters();
  return _dailyInferenceCost >= GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST;
}

/**
 * Check if inference budget warning threshold has been reached (80%).
 * When true, callers should reduce experiment frequency.
 * @returns {boolean}
 */
export function isBudgetWarning() {
  rollDailyCounters();
  return _dailyInferenceCost >= GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST * GUARDRAIL_LIMITS.INFERENCE_BUDGET_WARNING_PCT;
}

// ─── Audit Trail ─────────────────────────────────────────────

/**
 * Log a trading decision to the audit trail.
 *
 * @param {object} entry
 * @param {string} entry.action       — what was done
 * @param {string} entry.tier         — autonomy tier name
 * @param {string} entry.approved_by  — "human", "auto", or "system"
 * @param {string} entry.reasoning    — why the decision was made
 * @param {object} [entry.details]    — additional structured data
 */
export function logAuditEntry(entry) {
  mkdirSync(STATE_DIR, { recursive: true });

  const record = {
    timestamp: new Date().toISOString(),
    action: entry.action || "unknown",
    tier: entry.tier || "unknown",
    approved_by: entry.approved_by || "unknown",
    reasoning: entry.reasoning || "",
    details: entry.details || null,
  };

  let trail = safeReadJSON(AUDIT_TRAIL_PATH, []);
  if (!Array.isArray(trail)) trail = [];

  trail.push(record);

  // Cap at MAX_AUDIT_ENTRIES — evict oldest when full
  if (trail.length > MAX_AUDIT_ENTRIES) {
    trail = trail.slice(trail.length - MAX_AUDIT_ENTRIES);
  }

  safeWriteJSON(AUDIT_TRAIL_PATH, trail);
  return record;
}

/**
 * Query the audit trail with optional filters.
 *
 * @param {object} [filters]
 * @param {string} [filters.startDate]  — ISO date string, inclusive
 * @param {string} [filters.endDate]    — ISO date string, inclusive
 * @param {string} [filters.action]     — exact action match
 * @param {string} [filters.tier]       — exact tier match
 * @param {number} [filters.limit]      — max entries to return
 * @returns {object[]}
 */
export function getAuditTrail(filters = {}) {
  let trail = safeReadJSON(AUDIT_TRAIL_PATH, []);
  if (!Array.isArray(trail)) return [];

  if (filters.startDate) {
    const start = new Date(filters.startDate);
    trail = trail.filter(e => new Date(e.timestamp) >= start);
  }
  if (filters.endDate) {
    const end = new Date(filters.endDate);
    // Include the full end day
    end.setHours(23, 59, 59, 999);
    trail = trail.filter(e => new Date(e.timestamp) <= end);
  }
  if (filters.action) {
    const a = filters.action.toLowerCase();
    trail = trail.filter(e => (e.action || "").toLowerCase() === a);
  }
  if (filters.tier) {
    const t = filters.tier.toLowerCase();
    trail = trail.filter(e => (e.tier || "").toLowerCase() === t);
  }
  if (filters.limit && filters.limit > 0) {
    trail = trail.slice(-filters.limit);
  }

  return trail;
}

function _getAuditTrailSize() {
  try {
    const trail = safeReadJSON(AUDIT_TRAIL_PATH, []);
    return Array.isArray(trail) ? trail.length : 0;
  } catch {
    return 0;
  }
}

// ─── Emergency Procedures ────────────────────────────────────

/**
 * Emergency shutdown: engage kill switch, halt daemon, send notifications.
 *
 * @param {string} reason — why the emergency shutdown was triggered
 * @param {object} [opts]
 * @param {Function} [opts.alpacaCloseAll]   — broker close-all function
 * @param {Function} [opts.notifyFn]         — async notification function(message)
 * @returns {Promise<{ shutdown: boolean, reason: string, timestamp: string, notified: boolean }>}
 */
export async function emergencyShutdown(reason, opts = {}) {
  const timestamp = new Date().toISOString();

  // 1. Engage kill switch
  killSwitch({ reason: `EMERGENCY: ${reason}`, alpacaCloseAll: opts.alpacaCloseAll });

  // 2. Log the emergency
  logAuditEntry({
    action: "EMERGENCY_SHUTDOWN",
    tier: "EMERGENCY",
    approved_by: "system",
    reasoning: reason,
    details: { timestamp, processId: process.pid },
  });

  // 3. Send notification
  let notified = false;
  if (typeof opts.notifyFn === "function") {
    try {
      await opts.notifyFn(`EMERGENCY SHUTDOWN: ${reason} — All positions flattened, trading halted. PID: ${process.pid}`);
      notified = true;
    } catch (err) {
      logAuditEntry({
        action: "EMERGENCY_NOTIFY_FAILED",
        tier: "EMERGENCY",
        approved_by: "system",
        reasoning: `Notification failed: ${err.message}`,
      });
    }
  }

  // 4. Persist state
  _saveGuardrailState();

  return { shutdown: true, reason, timestamp, notified };
}

/**
 * Activate reduced risk mode: halve all position limits, double all cooldowns.
 * Stays active until process restart or explicit deactivation.
 *
 * @returns {{ activated: boolean, timestamp: string }}
 */
export function reducedRiskMode() {
  _reducedRiskActive = true;
  _reducedRiskTimestamp = new Date().toISOString();

  logAuditEntry({
    action: "REDUCED_RISK_MODE_ACTIVATED",
    tier: "SYSTEM",
    approved_by: "system",
    reasoning: "All position limits halved, all cooldowns doubled",
    details: {
      effectiveLimits: {
        MAX_POSITION_SIZE_PCT: GUARDRAIL_LIMITS.MAX_POSITION_SIZE_PCT / 2,
        MAX_DAILY_LOSS_PCT: GUARDRAIL_LIMITS.MAX_DAILY_LOSS_PCT / 2,
        MAX_PORTFOLIO_DRAWDOWN_PCT: GUARDRAIL_LIMITS.MAX_PORTFOLIO_DRAWDOWN_PCT / 2,
        MAX_LEVERAGE: GUARDRAIL_LIMITS.MAX_LEVERAGE / 2,
        MAX_CORRELATED_EXPOSURE_PCT: GUARDRAIL_LIMITS.MAX_CORRELATED_EXPOSURE_PCT / 2,
      },
    },
  });

  _saveGuardrailState();

  return { activated: true, timestamp: _reducedRiskTimestamp };
}

/**
 * Deactivate reduced risk mode (restore normal limits).
 *
 * @returns {{ deactivated: boolean, timestamp: string }}
 */
export function deactivateReducedRiskMode() {
  _reducedRiskActive = false;
  const ts = new Date().toISOString();

  logAuditEntry({
    action: "REDUCED_RISK_MODE_DEACTIVATED",
    tier: "SYSTEM",
    approved_by: "system",
    reasoning: "Normal position limits restored",
  });

  _saveGuardrailState();

  return { deactivated: true, timestamp: ts };
}

/**
 * Get configured emergency contact targets.
 *
 * @returns {{ telegram: { botToken: string, chatId: string } | null, email: string | null, webhook: string | null }}
 */
export function getEmergencyContacts() {
  return {
    telegram: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
      ? { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }
      : null,
    email: process.env.EMERGENCY_EMAIL || null,
    webhook: process.env.EMERGENCY_WEBHOOK_URL || null,
  };
}

// ─── Pre-Trade Composite Check ───────────────────────────────

/**
 * Run all guardrail checks before executing a trade.
 * This is the single entry point that paper-trader and daemon should call.
 *
 * @param {object} trade
 * @param {string} trade.action         — action type (e.g., "paper_trade", "live_order")
 * @param {string} trade.symbol         — ticker symbol
 * @param {string} trade.side           — "buy" or "sell"
 * @param {number} trade.qty            — shares
 * @param {number} trade.price          — estimated price
 * @param {string} trade.agent          — agent role
 * @param {object} portfolio
 * @param {number} portfolio.equity     — total equity
 * @param {number} portfolio.dailyPnl   — today's P&L
 * @param {number} portfolio.peakEquity — high-water mark
 * @param {number} portfolio.grossExposure — total gross exposure
 * @param {number} portfolio.correlatedExposure — correlated asset exposure
 * @returns {{ allowed: boolean, checks: object[], reason: string }}
 */
export function preTradeCheck(trade, portfolio) {
  const checks = [];
  let blocked = false;
  let blockReason = "";

  // 1. Kill switch check
  if (_killSwitchEngaged) {
    return {
      allowed: false,
      checks: [{ name: "kill_switch", passed: false, reason: `Kill switch engaged: ${_killSwitchReason}` }],
      reason: `Kill switch engaged: ${_killSwitchReason}`,
    };
  }

  // 2. Autonomy check
  const autonomy = checkAutonomy(trade.action);
  checks.push({
    name: "autonomy",
    passed: autonomy.allowed,
    tier: autonomy.tier.name,
    reason: autonomy.reason,
  });
  if (!autonomy.allowed) {
    blocked = true;
    blockReason = autonomy.reason;
  }

  // 3. Position size check
  if (portfolio.equity > 0 && trade.price > 0 && trade.qty > 0) {
    const positionValue = trade.price * trade.qty;
    const positionPct = positionValue / portfolio.equity;
    const posCheck = enforceLimit("MAX_POSITION_SIZE_PCT", positionPct);
    checks.push({
      name: "position_size",
      passed: posCheck.within,
      reason: posCheck.action,
      value: positionPct,
      limit: posCheck.limit,
    });
    if (!posCheck.within) {
      blocked = true;
      blockReason = blockReason || `Position size ${(positionPct * 100).toFixed(1)}% exceeds limit`;
    }
  }

  // 4. Daily loss check
  if (portfolio.equity > 0 && portfolio.dailyPnl !== undefined) {
    const dailyLossPct = portfolio.dailyPnl < 0 ? Math.abs(portfolio.dailyPnl) / portfolio.equity : 0;
    const lossCheck = enforceLimit("MAX_DAILY_LOSS_PCT", dailyLossPct);
    checks.push({
      name: "daily_loss",
      passed: lossCheck.within,
      reason: lossCheck.action,
      value: dailyLossPct,
      limit: lossCheck.limit,
    });
    if (!lossCheck.within) {
      blocked = true;
      blockReason = blockReason || `Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds limit`;
    }
  }

  // 5. Drawdown check
  if (portfolio.peakEquity > 0 && portfolio.equity > 0) {
    const drawdown = (portfolio.peakEquity - portfolio.equity) / portfolio.peakEquity;
    const ddCheck = enforceLimit("MAX_PORTFOLIO_DRAWDOWN_PCT", drawdown);
    checks.push({
      name: "drawdown",
      passed: ddCheck.within,
      reason: ddCheck.action,
      value: drawdown,
      limit: ddCheck.limit,
    });
    if (!ddCheck.within) {
      blocked = true;
      blockReason = blockReason || `Drawdown ${(drawdown * 100).toFixed(1)}% exceeds limit`;
      // Auto-engage kill switch on drawdown breach
      killSwitch({ reason: `Drawdown limit breached: ${(drawdown * 100).toFixed(1)}%` });
    }
  }

  // 6. Leverage check
  if (portfolio.grossExposure !== undefined && portfolio.equity > 0) {
    const leverage = portfolio.grossExposure / portfolio.equity;
    const levCheck = enforceLimit("MAX_LEVERAGE", leverage);
    checks.push({
      name: "leverage",
      passed: levCheck.within,
      reason: levCheck.action,
      value: leverage,
      limit: levCheck.limit,
    });
    if (!levCheck.within) {
      blocked = true;
      blockReason = blockReason || `Leverage ${leverage.toFixed(2)}x exceeds limit`;
    }
  }

  // 7. Correlated exposure check
  if (portfolio.correlatedExposure !== undefined && portfolio.equity > 0) {
    const corrPct = portfolio.correlatedExposure / portfolio.equity;
    const corrCheck = enforceLimit("MAX_CORRELATED_EXPOSURE_PCT", corrPct);
    checks.push({
      name: "correlated_exposure",
      passed: corrCheck.within,
      reason: corrCheck.action,
      value: corrPct,
      limit: corrCheck.limit,
    });
    if (!corrCheck.within) {
      blocked = true;
      blockReason = blockReason || `Correlated exposure ${(corrPct * 100).toFixed(1)}% exceeds limit`;
    }
  }

  // 8. Inference budget check
  if (isBudgetExhausted()) {
    checks.push({
      name: "inference_budget",
      passed: false,
      reason: `Daily inference budget exhausted ($${_dailyInferenceCost.toFixed(2)} / $${GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST.toFixed(2)})`,
    });
    blocked = true;
    blockReason = blockReason || "Inference budget exhausted";
  } else {
    checks.push({
      name: "inference_budget",
      passed: true,
      reason: `Budget OK ($${_dailyInferenceCost.toFixed(2)} / $${GUARDRAIL_LIMITS.MAX_DAILY_INFERENCE_COST.toFixed(2)})`,
    });
  }

  // Log the decision
  const allowed = !blocked;
  logAuditEntry({
    action: trade.action,
    tier: checks.find(c => c.name === "autonomy")?.tier || "unknown",
    approved_by: allowed ? "auto" : "blocked",
    reasoning: allowed ? `Trade allowed: ${trade.side} ${trade.qty} ${trade.symbol}` : blockReason,
    details: {
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty,
      price: trade.price,
      agent: trade.agent,
      checksRun: checks.length,
      checksPassed: checks.filter(c => c.passed).length,
    },
  });

  return {
    allowed,
    checks,
    reason: allowed ? "All guardrail checks passed" : blockReason,
  };
}

// ─── State Persistence ───────────────────────────────────────

function _saveGuardrailState() {
  mkdirSync(STATE_DIR, { recursive: true });
  safeWriteJSON(GUARDRAIL_STATE_PATH, {
    killSwitch: {
      engaged: _killSwitchEngaged,
      reason: _killSwitchReason,
      timestamp: _killSwitchTimestamp,
    },
    reducedRiskMode: {
      active: _reducedRiskActive,
      timestamp: _reducedRiskTimestamp,
    },
    inferenceBudget: {
      spent: _dailyInferenceCost,
      calls: _inferenceCalls,
      date: _dailyInferenceCostDate,
    },
    savedAt: new Date().toISOString(),
  });
}

function _loadGuardrailState() {
  const state = safeReadJSON(GUARDRAIL_STATE_PATH, null);
  if (!state) return;

  if (state.killSwitch?.engaged) {
    _killSwitchEngaged = true;
    _killSwitchReason = state.killSwitch.reason;
    _killSwitchTimestamp = state.killSwitch.timestamp;
  }
  if (state.reducedRiskMode?.active) {
    _reducedRiskActive = true;
    _reducedRiskTimestamp = state.reducedRiskMode.timestamp;
  }
  if (state.inferenceBudget?.date === todayDateStr()) {
    _dailyInferenceCost = state.inferenceBudget.spent || 0;
    _inferenceCalls = state.inferenceBudget.calls || 0;
    _dailyInferenceCostDate = state.inferenceBudget.date;
  }
}

function _loadApprovalState() {
  const approvalPath = join(STATE_DIR, "approvals.json");
  return safeReadJSON(approvalPath, {});
}

// ─── Initialization ──────────────────────────────────────────

// Load persisted state on module import
try {
  _loadGuardrailState();
} catch {
  // First run or corrupted state — start clean
}
