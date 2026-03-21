#!/usr/bin/env node
/**
 * Strategy Lifecycle Manager — Automated Promotion, Demotion & Retirement
 *
 * Manages quant strategies through: RESEARCH -> BACKTEST -> PAPER_TRADING -> LIVE -> RETIRED
 * Enforces gates at each transition with Sharpe, Sortino, drawdown, and trade-count thresholds.
 * Persists all state to agents/state/strategy-lifecycle.json.
 *
 * Usage:
 *   node agents/management/lifecycle-manager.mjs                     # print lifecycle report
 *   node agents/management/lifecycle-manager.mjs --evaluate <name>   # evaluate a single strategy
 *   node agents/management/lifecycle-manager.mjs --json              # machine-readable output
 *
 *   import { evaluateStrategy, getLifecycleStatus, promote, demote, retire, getLifecycleReport }
 *     from './management/lifecycle-manager.mjs';
 *
 * @module lifecycle-manager
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "state");
const STATE_PATH = join(STATE_DIR, "strategy-lifecycle.json");

// ─── Lifecycle Stages ───────────────────────────────────

/** @enum {string} */
const STAGES = Object.freeze({
  RESEARCH: "RESEARCH",
  BACKTEST: "BACKTEST",
  PAPER_TRADING: "PAPER_TRADING",
  LIVE: "LIVE",
  RETIRED: "RETIRED",
});

const PROMOTION_PATH = [STAGES.RESEARCH, STAGES.BACKTEST, STAGES.PAPER_TRADING, STAGES.LIVE];

// ─── Thresholds ─────────────────────────────────────────

const PROMOTION_GATES = {
  // RESEARCH -> BACKTEST: hypothesis documented, initial signal generated
  [STAGES.BACKTEST]: {
    check: (m) => {
      if (!m.hypothesisDocumented) return { pass: false, reason: "Hypothesis not documented" };
      if (!m.signalGenerated) return { pass: false, reason: "No initial signal generated" };
      return { pass: true };
    },
  },
  // BACKTEST -> PAPER_TRADING: Sharpe>1.0, Sortino>1.2, maxDD<15%, 100+ trades, walk-forward pass
  [STAGES.PAPER_TRADING]: {
    check: (m) => {
      if ((m.sharpe ?? 0) <= 1.0)
        return { pass: false, reason: `Sharpe ${fmt(m.sharpe)} <= 1.0` };
      if ((m.sortino ?? 0) <= 1.2)
        return { pass: false, reason: `Sortino ${fmt(m.sortino)} <= 1.2` };
      if ((m.maxDrawdownPct ?? 100) >= 15)
        return { pass: false, reason: `Max DD ${fmt(m.maxDrawdownPct)}% >= 15%` };
      if ((m.tradeCount ?? 0) < 100)
        return { pass: false, reason: `Trade count ${m.tradeCount ?? 0} < 100` };
      if (!m.walkForwardPass)
        return { pass: false, reason: "Walk-forward validation not passed" };
      return { pass: true };
    },
  },
  // PAPER_TRADING -> LIVE: 30+ days paper, tracking error <5% from backtest, positive P&L
  [STAGES.LIVE]: {
    check: (m) => {
      if ((m.paperTradingDays ?? 0) < 30)
        return { pass: false, reason: `Paper trading days ${m.paperTradingDays ?? 0} < 30` };
      if ((m.trackingErrorPct ?? 100) >= 5)
        return { pass: false, reason: `Tracking error ${fmt(m.trackingErrorPct)}% >= 5%` };
      if ((m.paperPnl ?? 0) <= 0)
        return { pass: false, reason: `Paper P&L ${fmt(m.paperPnl)} <= 0` };
      return { pass: true };
    },
  },
};

const DEMOTION_THRESHOLDS = {
  sharpeBelowDays: { sharpe: 0.5, days: 30 },
  maxDrawdownPct: 20,
  consecutiveLosingMonths: 3,
};

const RETIREMENT_RULES = {
  demotionsInWindowMonths: { count: 2, windowMonths: 6 },
  noPositivePnlDays: 90,
};

// ─── State Persistence ──────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { strategies: {}, version: 1, lastUpdated: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { strategies: {}, version: 1, lastUpdated: null };
  }
}

function saveState(state) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function fmt(v) {
  return (v ?? 0).toFixed(2);
}

// ─── Core Record Helpers ────────────────────────────────

function createStrategyRecord(name) {
  const now = new Date().toISOString();
  return {
    name,
    stage: STAGES.RESEARCH,
    createdAt: now,
    lastEvaluatedAt: null,
    metrics: {},
    history: [{ stage: STAGES.RESEARCH, at: now, reason: "Created" }],
    demotions: [],
    retireReason: null,
  };
}

function ensureStrategy(state, name) {
  if (!state.strategies[name]) {
    state.strategies[name] = createStrategyRecord(name);
  }
  return state.strategies[name];
}

// ─── Demotion & Retirement Checks ───────────────────────

function checkDemotionTriggers(metrics) {
  const reasons = [];

  // Sharpe below 0.5 for 30 days
  if (
    metrics.sharpeBelowDays !== undefined &&
    metrics.sharpeBelowDays >= DEMOTION_THRESHOLDS.sharpeBelowDays.days &&
    (metrics.sharpe ?? 1) < DEMOTION_THRESHOLDS.sharpeBelowDays.sharpe
  ) {
    reasons.push(
      `Sharpe ${fmt(metrics.sharpe)} < ${DEMOTION_THRESHOLDS.sharpeBelowDays.sharpe} for ${metrics.sharpeBelowDays} days`
    );
  }

  // Max drawdown exceeds 20%
  if ((metrics.maxDrawdownPct ?? 0) > DEMOTION_THRESHOLDS.maxDrawdownPct) {
    reasons.push(`Max DD ${fmt(metrics.maxDrawdownPct)}% > ${DEMOTION_THRESHOLDS.maxDrawdownPct}%`);
  }

  // 3 consecutive losing months
  if ((metrics.consecutiveLosingMonths ?? 0) >= DEMOTION_THRESHOLDS.consecutiveLosingMonths) {
    reasons.push(
      `${metrics.consecutiveLosingMonths} consecutive losing months (threshold: ${DEMOTION_THRESHOLDS.consecutiveLosingMonths})`
    );
  }

  return reasons;
}

function checkRetirementTriggers(strategy) {
  const reasons = [];
  const now = Date.now();
  const windowMs = RETIREMENT_RULES.demotionsInWindowMonths.windowMonths * 30 * 24 * 60 * 60 * 1000;

  // Demoted twice within 6 months
  const recentDemotions = strategy.demotions.filter(
    (d) => now - new Date(d.at).getTime() < windowMs
  );
  if (recentDemotions.length >= RETIREMENT_RULES.demotionsInWindowMonths.count) {
    reasons.push(
      `Demoted ${recentDemotions.length}x within ${RETIREMENT_RULES.demotionsInWindowMonths.windowMonths} months`
    );
  }

  // No positive P&L in 90 days
  if (
    strategy.metrics.daysSincePositivePnl !== undefined &&
    strategy.metrics.daysSincePositivePnl >= RETIREMENT_RULES.noPositivePnlDays
  ) {
    reasons.push(
      `No positive P&L in ${strategy.metrics.daysSincePositivePnl} days (threshold: ${RETIREMENT_RULES.noPositivePnlDays})`
    );
  }

  return reasons;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Evaluate a strategy against promotion, demotion, and retirement criteria.
 * Automatically transitions when thresholds are met.
 *
 * @param {string} name — strategy identifier
 * @param {object} metrics — current performance metrics:
 *   For RESEARCH->BACKTEST: { hypothesisDocumented: bool, signalGenerated: bool }
 *   For BACKTEST->PAPER:    { sharpe, sortino, maxDrawdownPct, tradeCount, walkForwardPass }
 *   For PAPER->LIVE:        { paperTradingDays, trackingErrorPct, paperPnl }
 *   For demotion checks:    { sharpe, sharpeBelowDays, maxDrawdownPct, consecutiveLosingMonths }
 *   For retirement:         { daysSincePositivePnl }
 * @returns {{ action: string, from: string, to: string, reasons: string[] }}
 */
export function evaluateStrategy(name, metrics) {
  const state = loadState();
  const strategy = ensureStrategy(state, name);
  const now = new Date().toISOString();

  // Merge incoming metrics into stored metrics
  strategy.metrics = { ...strategy.metrics, ...metrics };
  strategy.lastEvaluatedAt = now;

  // Already retired — no further transitions
  if (strategy.stage === STAGES.RETIRED) {
    saveState(state);
    return { action: "HOLD", from: STAGES.RETIRED, to: STAGES.RETIRED, reasons: ["Strategy is retired"] };
  }

  // 1. Check retirement triggers first (highest severity)
  const retireReasons = checkRetirementTriggers(strategy);
  if (retireReasons.length > 0) {
    const from = strategy.stage;
    _doRetire(strategy, retireReasons.join("; "), now);
    saveState(state);
    return { action: "RETIRE", from, to: STAGES.RETIRED, reasons: retireReasons };
  }

  // 2. Check demotion triggers (for PAPER_TRADING and LIVE stages)
  if (strategy.stage === STAGES.PAPER_TRADING || strategy.stage === STAGES.LIVE) {
    const demotionReasons = checkDemotionTriggers(strategy.metrics);
    if (demotionReasons.length > 0) {
      const from = strategy.stage;
      _doDemote(strategy, demotionReasons.join("; "), now);
      saveState(state);
      return { action: "DEMOTE", from, to: strategy.stage, reasons: demotionReasons };
    }
  }

  // 3. Check promotion eligibility
  const stageIdx = PROMOTION_PATH.indexOf(strategy.stage);
  if (stageIdx >= 0 && stageIdx < PROMOTION_PATH.length - 1) {
    const nextStage = PROMOTION_PATH[stageIdx + 1];
    const gate = PROMOTION_GATES[nextStage];
    if (gate) {
      const result = gate.check(strategy.metrics);
      if (result.pass) {
        const from = strategy.stage;
        strategy.stage = nextStage;
        strategy.history.push({ stage: nextStage, at: now, reason: "Auto-promoted" });
        saveState(state);
        return { action: "PROMOTE", from, to: nextStage, reasons: [`All ${from}->${nextStage} gates passed`] };
      }
    }
  }

  // 4. No transition
  saveState(state);
  return { action: "HOLD", from: strategy.stage, to: strategy.stage, reasons: ["No threshold triggered"] };
}

/**
 * Get all strategies with their current lifecycle stage, metrics, and history.
 * @returns {Object<string, { stage: string, metrics: object, createdAt: string, lastEvaluatedAt: string|null }>}
 */
export function getLifecycleStatus() {
  const state = loadState();
  const result = {};
  for (const [name, s] of Object.entries(state.strategies)) {
    result[name] = {
      stage: s.stage,
      metrics: { ...s.metrics },
      createdAt: s.createdAt,
      lastEvaluatedAt: s.lastEvaluatedAt,
      historyLength: s.history.length,
      demotionCount: s.demotions.length,
      retireReason: s.retireReason,
    };
  }
  return result;
}

/**
 * Manually promote a strategy to the next lifecycle stage.
 * Skips gate checks — use for manual overrides only.
 *
 * @param {string} name
 * @returns {{ success: boolean, from: string, to: string, reason?: string }}
 */
export function promote(name) {
  const state = loadState();
  const strategy = ensureStrategy(state, name);
  const now = new Date().toISOString();

  if (strategy.stage === STAGES.RETIRED) {
    saveState(state);
    return { success: false, from: STAGES.RETIRED, to: STAGES.RETIRED, reason: "Cannot promote a retired strategy" };
  }

  const idx = PROMOTION_PATH.indexOf(strategy.stage);
  if (idx < 0 || idx >= PROMOTION_PATH.length - 1) {
    saveState(state);
    return { success: false, from: strategy.stage, to: strategy.stage, reason: `Already at terminal stage: ${strategy.stage}` };
  }

  const from = strategy.stage;
  const to = PROMOTION_PATH[idx + 1];
  strategy.stage = to;
  strategy.history.push({ stage: to, at: now, reason: "Manual promotion" });
  saveState(state);
  return { success: true, from, to };
}

/**
 * Manually demote a strategy to the previous lifecycle stage.
 *
 * @param {string} name
 * @param {string} reason — explanation for the demotion
 * @returns {{ success: boolean, from: string, to: string, reason?: string }}
 */
export function demote(name, reason = "Manual demotion") {
  const state = loadState();
  const strategy = ensureStrategy(state, name);
  const now = new Date().toISOString();

  if (strategy.stage === STAGES.RETIRED) {
    saveState(state);
    return { success: false, from: STAGES.RETIRED, to: STAGES.RETIRED, reason: "Cannot demote a retired strategy" };
  }

  const idx = PROMOTION_PATH.indexOf(strategy.stage);
  if (idx <= 0) {
    saveState(state);
    return { success: false, from: strategy.stage, to: strategy.stage, reason: `Already at lowest stage: ${strategy.stage}` };
  }

  const from = strategy.stage;
  _doDemote(strategy, reason, now);
  saveState(state);
  return { success: true, from, to: strategy.stage };
}

/**
 * Retire a strategy permanently.
 *
 * @param {string} name
 * @param {string} reason
 * @returns {{ success: boolean, from: string, reason?: string }}
 */
export function retire(name, reason = "Manual retirement") {
  const state = loadState();
  const strategy = ensureStrategy(state, name);
  const now = new Date().toISOString();

  if (strategy.stage === STAGES.RETIRED) {
    saveState(state);
    return { success: false, from: STAGES.RETIRED, reason: "Already retired" };
  }

  const from = strategy.stage;
  _doRetire(strategy, reason, now);
  saveState(state);
  return { success: true, from };
}

/**
 * Generate a formatted ASCII lifecycle report for all tracked strategies.
 * @returns {string}
 */
export function getLifecycleReport() {
  const state = loadState();
  const entries = Object.values(state.strategies);

  if (entries.length === 0) {
    return "No strategies tracked.";
  }

  const div = "=".repeat(100);
  const lines = [
    div,
    "  STRATEGY LIFECYCLE REPORT",
    `  Generated: ${new Date().toISOString()}`,
    div,
    "",
  ];

  // Stage counts
  const stageCounts = {};
  for (const s of Object.values(STAGES)) stageCounts[s] = 0;
  for (const s of entries) stageCounts[s.stage]++;

  lines.push(
    `  Stages: ` +
      Object.entries(stageCounts)
        .filter(([, c]) => c > 0)
        .map(([s, c]) => `${s}:${c}`)
        .join("  |  ")
  );
  lines.push("");

  // Table header
  const hdr =
    `  ${"Strategy".padEnd(25)} ${"Stage".padEnd(16)} ${"Sharpe".padEnd(8)} ${"Sortino".padEnd(9)} ` +
    `${"MaxDD%".padEnd(8)} ${"Trades".padEnd(8)} ${"Demotions".padEnd(10)} ${"Age (d)".padEnd(8)}`;
  lines.push(hdr);
  lines.push("  " + "-".repeat(96));

  // Sort: LIVE first, then PAPER_TRADING, BACKTEST, RESEARCH, RETIRED
  const stageOrder = { LIVE: 0, PAPER_TRADING: 1, BACKTEST: 2, RESEARCH: 3, RETIRED: 4 };
  const sorted = [...entries].sort(
    (a, b) => (stageOrder[a.stage] ?? 5) - (stageOrder[b.stage] ?? 5)
  );

  for (const s of sorted) {
    const m = s.metrics;
    const ageDays = Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 86400000);
    const sharpe = m.sharpe != null ? fmt(m.sharpe) : "--";
    const sortino = m.sortino != null ? fmt(m.sortino) : "--";
    const maxDD = m.maxDrawdownPct != null ? fmt(m.maxDrawdownPct) + "%" : "--";
    const trades = m.tradeCount != null ? String(m.tradeCount) : "--";
    const stageIcon = { RESEARCH: "[R]", BACKTEST: "[B]", PAPER_TRADING: "[P]", LIVE: "[L]", RETIRED: "[X]" };

    const row =
      `  ${s.name.padEnd(25)} ${((stageIcon[s.stage] || "[ ]") + " " + s.stage).padEnd(16)} ` +
      `${sharpe.padEnd(8)} ${sortino.padEnd(9)} ${maxDD.padEnd(8)} ${trades.padEnd(8)} ` +
      `${String(s.demotions.length).padEnd(10)} ${String(ageDays).padEnd(8)}`;
    lines.push(row);

    if (s.retireReason) {
      lines.push(`    Retired: ${s.retireReason}`);
    }
  }

  lines.push("  " + "-".repeat(96));

  // Promotion/demotion summary
  const promotable = sorted.filter((s) => {
    if (s.stage === STAGES.RETIRED) return false;
    const idx = PROMOTION_PATH.indexOf(s.stage);
    if (idx < 0 || idx >= PROMOTION_PATH.length - 1) return false;
    const nextStage = PROMOTION_PATH[idx + 1];
    const gate = PROMOTION_GATES[nextStage];
    return gate && gate.check(s.metrics).pass;
  });

  if (promotable.length > 0) {
    lines.push("");
    lines.push("  READY FOR PROMOTION:");
    for (const s of promotable) {
      const idx = PROMOTION_PATH.indexOf(s.stage);
      lines.push(`    ${s.name}: ${s.stage} -> ${PROMOTION_PATH[idx + 1]}`);
    }
  }

  const atRisk = sorted.filter((s) => {
    if (s.stage !== STAGES.PAPER_TRADING && s.stage !== STAGES.LIVE) return false;
    return checkDemotionTriggers(s.metrics).length > 0;
  });

  if (atRisk.length > 0) {
    lines.push("");
    lines.push("  AT RISK OF DEMOTION:");
    for (const s of atRisk) {
      const reasons = checkDemotionTriggers(s.metrics);
      lines.push(`    ${s.name}: ${reasons.join("; ")}`);
    }
  }

  lines.push("");
  lines.push(div);
  return lines.join("\n");
}

// ─── Internal Transition Helpers ────────────────────────

function _doDemote(strategy, reason, now) {
  const idx = PROMOTION_PATH.indexOf(strategy.stage);
  if (idx <= 0) return; // can't demote below RESEARCH

  const prevStage = PROMOTION_PATH[idx - 1];
  strategy.stage = prevStage;
  strategy.demotions.push({ at: now, from: PROMOTION_PATH[idx], to: prevStage, reason });
  strategy.history.push({ stage: prevStage, at: now, reason: `Demoted: ${reason}` });
}

function _doRetire(strategy, reason, now) {
  strategy.stage = STAGES.RETIRED;
  strategy.retireReason = reason;
  strategy.history.push({ stage: STAGES.RETIRED, at: now, reason: `Retired: ${reason}` });
}

// ─── CLI ────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    evaluate: args.includes("--evaluate") ? args[args.indexOf("--evaluate") + 1] : null,
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log("Strategy Lifecycle Manager");
    console.log("");
    console.log("Usage:");
    console.log("  node lifecycle-manager.mjs                     # print lifecycle report");
    console.log("  node lifecycle-manager.mjs --evaluate <name>   # evaluate a single strategy");
    console.log("  node lifecycle-manager.mjs --json              # JSON output");
    console.log("  node lifecycle-manager.mjs --help              # this message");
    return;
  }

  if (opts.evaluate) {
    // Read metrics from stdin or use stored metrics for a re-evaluation
    const status = getLifecycleStatus();
    const current = status[opts.evaluate];
    if (!current) {
      console.log(`Strategy "${opts.evaluate}" not found. Creating in RESEARCH stage.`);
      const result = evaluateStrategy(opts.evaluate, {});
      console.log(`  Action: ${result.action} | Stage: ${result.to}`);
    } else {
      const result = evaluateStrategy(opts.evaluate, current.metrics);
      console.log(`  Strategy: ${opts.evaluate}`);
      console.log(`  Action:   ${result.action}`);
      console.log(`  From:     ${result.from}`);
      console.log(`  To:       ${result.to}`);
      if (result.reasons.length > 0) {
        console.log(`  Reasons:  ${result.reasons.join("; ")}`);
      }
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(getLifecycleStatus(), null, 2));
    return;
  }

  // Default: print full report
  console.log(getLifecycleReport());
}

main().catch((e) => {
  console.error(`Lifecycle manager error: ${e.message}`);
  process.exit(1);
});
