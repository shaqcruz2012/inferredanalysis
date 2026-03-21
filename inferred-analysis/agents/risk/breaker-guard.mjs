/**
 * Breaker Guard — Circuit Breaker State Reader
 *
 * Reads breaker-state.json and exposes simple query functions for use by
 * paper-trader, agent-runner, daemon, and backtest-engine.
 *
 * SAFETY PRINCIPLE: If the state file is missing, corrupt, or unreadable,
 * all functions default to HALT (fail-closed). Trading only proceeds when
 * breaker state is explicitly readable and clear.
 *
 * Usage:
 *   import { isTradingHalted, isPortfolioHalted, getBreakerStatus } from '../risk/breaker-guard.mjs';
 *
 *   const halted = isTradingHalted('alpha_researcher');
 *   if (halted.halted) {
 *     console.log(`Trading blocked: ${halted.reason}`);
 *   }
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const OUTPUTS_DIR = join(AGENTS_DIR, "outputs");

const STATE_PATH = process.env.BREAKER_STATE_PATH ||
  join(OUTPUTS_DIR, "breaker-state.json");

// ─── Internal State Reader ───────────────────────────────

/**
 * Read and parse breaker-state.json. Returns null on any failure.
 * Callers must treat null as "state unknown = halt".
 */
function readBreakerState() {
  try {
    if (!existsSync(STATE_PATH)) {
      return null;
    }
    const raw = readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object") return null;
    if (!state.breakers || typeof state.breakers !== "object") return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Compute recovery scale for a breaker entry.
 * Returns 0 if still in cooldown/paused, 0..1 if recovering, 1 if clear.
 */
function computeRecoveryScale(breaker) {
  if (!breaker || !breaker.tripped) return 1.0;

  // Still in cooldown?
  if (breaker.cooldownUntil) {
    const cooldownEnd = new Date(breaker.cooldownUntil).getTime();
    if (Date.now() < cooldownEnd) return 0;
  }

  // In recovery: partial scale
  if (breaker.recoveryStatus === "recovering") {
    const profitCount = breaker.recoveryProfitableCount || 0;
    const rampTarget = 5; // matches circuit-breaker.mjs DEFAULTS.recoveryRampExperiments
    if (profitCount >= rampTarget) return 1.0;
    const base = 0.50; // matches DEFAULTS.recoveryPositionScale
    return base + (1.0 - base) * (profitCount / rampTarget);
  }

  return 0; // paused
}

// ─── Public API ──────────────────────────────────────────

/**
 * Check whether trading is halted for a specific strategy/agent.
 *
 * Checks portfolio-level breaker first (blocks everything), then
 * agent-level breaker for the given agent name.
 *
 * Returns { halted: boolean, reason: string, positionScale: number }
 *
 * FAIL-CLOSED: Returns halted=true if state file is missing or corrupt.
 */
export function isTradingHalted(agentRole) {
  const state = readBreakerState();

  if (!state) {
    return {
      halted: true,
      reason: "Circuit breaker state file missing or corrupt — defaulting to HALT for safety",
      positionScale: 0,
    };
  }

  // Portfolio-level breaker blocks everything
  const portfolio = state.breakers["portfolio"];
  if (portfolio && portfolio.tripped) {
    const scale = computeRecoveryScale(portfolio);
    if (scale === 0) {
      return {
        halted: true,
        reason: `Portfolio halted: ${portfolio.reason}`,
        positionScale: 0,
      };
    }
    // In recovery — allow with reduced scale
    return {
      halted: false,
      reason: `Portfolio in recovery mode`,
      positionScale: scale,
    };
  }

  // Agent-level breaker
  const agentKey = `agent:${agentRole}`;
  const agent = state.breakers[agentKey];
  if (agent && agent.tripped) {
    const scale = computeRecoveryScale(agent);
    if (scale === 0) {
      return {
        halted: true,
        reason: `Agent ${agentRole} paused: ${agent.reason}`,
        positionScale: 0,
      };
    }
    return {
      halted: false,
      reason: `Agent ${agentRole} in recovery`,
      positionScale: scale,
    };
  }

  return {
    halted: false,
    reason: "",
    positionScale: 1.0,
  };
}

/**
 * Check whether the portfolio-level breaker is active.
 * This blocks ALL trading across all agents.
 *
 * Returns { halted: boolean, reason: string }
 *
 * FAIL-CLOSED: Returns halted=true if state file is missing or corrupt.
 */
export function isPortfolioHalted() {
  const state = readBreakerState();

  if (!state) {
    return {
      halted: true,
      reason: "Circuit breaker state file missing or corrupt — defaulting to HALT for safety",
    };
  }

  const portfolio = state.breakers["portfolio"];
  if (portfolio && portfolio.tripped) {
    const scale = computeRecoveryScale(portfolio);
    if (scale === 0) {
      return {
        halted: true,
        reason: `Portfolio halted: ${portfolio.reason}`,
      };
    }
    return {
      halted: false,
      reason: `Portfolio in recovery (scale: ${(scale * 100).toFixed(0)}%)`,
    };
  }

  return {
    halted: false,
    reason: "",
  };
}

/**
 * Check whether a specific strategy is halted.
 *
 * @param {string} agentRole - e.g. "alpha_researcher"
 * @param {string} strategyName - e.g. "momentum_crossover"
 * @returns {{ halted: boolean, reason: string, positionScale: number }}
 */
export function isStrategyHalted(agentRole, strategyName) {
  // First check agent/portfolio level
  const agentCheck = isTradingHalted(agentRole);
  if (agentCheck.halted) return agentCheck;

  const state = readBreakerState();
  if (!state) {
    return {
      halted: true,
      reason: "Circuit breaker state file missing or corrupt — defaulting to HALT for safety",
      positionScale: 0,
    };
  }

  const stratKey = `strategy:${agentRole}/${strategyName}`;
  const strat = state.breakers[stratKey];
  if (strat && strat.tripped) {
    const scale = computeRecoveryScale(strat);
    if (scale === 0) {
      return {
        halted: true,
        reason: `Strategy ${agentRole}/${strategyName} paused: ${strat.reason}`,
        positionScale: 0,
      };
    }
    return {
      halted: false,
      reason: `Strategy ${agentRole}/${strategyName} in recovery`,
      positionScale: Math.min(agentCheck.positionScale, scale),
    };
  }

  return agentCheck;
}

/**
 * Get a full summary of all breaker states for monitoring/logging.
 *
 * Returns {
 *   readable: boolean,
 *   activeBreakerCount: number,
 *   portfolioHalted: boolean,
 *   breakers: { [key]: { level, name, reason, tripped, recoveryStatus, currentScale, cooldownRemaining } },
 *   lastUpdated: string,
 *   staleMs: number,        // milliseconds since last state update
 * }
 */
export function getBreakerSummary() {
  const state = readBreakerState();

  if (!state) {
    return {
      readable: false,
      activeBreakerCount: -1,
      portfolioHalted: true,
      breakers: {},
      lastUpdated: "unknown",
      staleMs: Infinity,
    };
  }

  const enriched = {};
  for (const [key, breaker] of Object.entries(state.breakers)) {
    enriched[key] = {
      level: breaker.level,
      name: breaker.name,
      reason: breaker.reason,
      tripped: breaker.tripped,
      recoveryStatus: breaker.recoveryStatus,
      currentScale: computeRecoveryScale(breaker),
      cooldownRemaining: breaker.cooldownUntil
        ? Math.max(0, new Date(breaker.cooldownUntil).getTime() - Date.now())
        : 0,
    };
  }

  const portfolio = state.breakers["portfolio"];
  const portfolioHalted = portfolio?.tripped && computeRecoveryScale(portfolio) === 0;

  const staleMs = state.lastUpdated
    ? Date.now() - new Date(state.lastUpdated).getTime()
    : Infinity;

  return {
    readable: true,
    activeBreakerCount: Object.keys(enriched).length,
    portfolioHalted: !!portfolioHalted,
    breakers: enriched,
    lastUpdated: state.lastUpdated || "unknown",
    staleMs,
  };
}

/**
 * Format a breaker halt event for logging. Returns a human-readable string.
 */
export function formatBreakerBlock(context, checkResult) {
  const ts = new Date().toISOString();
  return `[${ts}] [CIRCUIT BREAKER] ${context} — BLOCKED: ${checkResult.reason}` +
    (checkResult.positionScale !== undefined ? ` (scale: ${checkResult.positionScale})` : "");
}
