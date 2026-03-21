#!/usr/bin/env node
/**
 * Position Reconciler — Drift Detection & Auto-Resolution
 *
 * Compares local portfolio tracker state against broker (Alpaca) positions
 * to detect and resolve drift caused by manual trades, API failures, or
 * missed fills. Persists reconciliation history for audit trail.
 *
 * Exported API:
 *   reconcile(trackerPositions, brokerPositions)  — compare and find discrepancies
 *   autoResolve(discrepancies, strategy, tracker) — fix based on strategy
 *   getReconciliationReport()                     — formatted report of last run
 *   scheduleReconciliation(intervalMs, fetchFns)  — periodic reconciliation
 *   getReconciliationHistory(limit)               — audit trail
 *
 * Usage:
 *   import { reconcile, autoResolve } from './reconciler.mjs';
 *   const result = reconcile(tracker.getPositions(), await alpaca.getPositions());
 *   if (result.mismatched.length || result.trackerOnly.length || result.brokerOnly.length) {
 *     autoResolve(result, 'broker-wins', tracker);
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const STATE_DIR = join(AGENTS_DIR, "state");
const HISTORY_PATH = join(STATE_DIR, "reconciliation-history.json");
const MAX_HISTORY = 200;

// ─── Helpers ──────────────────────────────────────────────

function round2(n) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * Normalize a position object to a common shape for comparison.
 * Handles both tracker format (from getPositions()) and broker format (Alpaca API).
 *
 * @param {Object} pos - Position from tracker or broker
 * @param {string} source - 'tracker' or 'broker'
 * @returns {{ symbol: string, qty: number, avgCost: number, marketValue: number, side: string }}
 */
function normalizePosition(pos, source) {
  if (source === "broker") {
    return {
      symbol: pos.symbol,
      qty: parseFloat(pos.qty),
      avgCost: parseFloat(pos.avg_entry_price || pos.avgCost || 0),
      marketValue: parseFloat(pos.market_value || 0),
      currentPrice: parseFloat(pos.current_price || 0),
      side: parseFloat(pos.qty) > 0 ? "long" : parseFloat(pos.qty) < 0 ? "short" : "flat",
    };
  }
  // tracker format — already numeric
  return {
    symbol: pos.symbol,
    qty: pos.qty,
    avgCost: pos.avgCost || 0,
    marketValue: pos.marketValue || 0,
    currentPrice: pos.currentPrice || 0,
    side: pos.side || (pos.qty > 0 ? "long" : pos.qty < 0 ? "short" : "flat"),
  };
}

// ─── Persistence ──────────────────────────────────────────

let _history = null;

function loadHistory() {
  if (_history !== null) return _history;
  try {
    if (existsSync(HISTORY_PATH)) {
      _history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
      if (!Array.isArray(_history)) _history = [];
    } else {
      _history = [];
    }
  } catch {
    _history = [];
  }
  return _history;
}

function saveHistory() {
  try {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    // Trim to max entries
    if (_history && _history.length > MAX_HISTORY) {
      _history = _history.slice(-MAX_HISTORY);
    }
    writeFileSync(HISTORY_PATH, JSON.stringify(_history, null, 2));
  } catch (err) {
    console.error(`[reconciler] Failed to save history: ${err.message}`);
  }
}

function appendHistoryEntry(entry) {
  const history = loadHistory();
  history.push(entry);
  saveHistory();
}

// ─── Last reconciliation result (in-memory) ──────────────

let _lastResult = null;
let _lastResolution = null;

// ─── Core: reconcile() ───────────────────────────────────

/**
 * Compare tracker positions against broker positions and identify discrepancies.
 *
 * @param {Array} trackerPositions - From tracker.getPositions() (non-flat positions)
 * @param {Array} brokerPositions  - From alpaca.getPositions() (Alpaca API format)
 * @returns {{
 *   matched: Array,
 *   mismatched: Array,
 *   trackerOnly: Array,
 *   brokerOnly: Array,
 *   totalDrift: number,
 *   driftPct: number,
 *   timestamp: string
 * }}
 */
export function reconcile(trackerPositions, brokerPositions) {
  const timestamp = nowISO();

  // Build maps keyed by symbol
  const trackerMap = new Map();
  for (const tp of trackerPositions) {
    const norm = normalizePosition(tp, "tracker");
    if (norm.qty !== 0) trackerMap.set(norm.symbol, norm);
  }

  const brokerMap = new Map();
  for (const bp of brokerPositions) {
    const norm = normalizePosition(bp, "broker");
    if (norm.qty !== 0) brokerMap.set(norm.symbol, norm);
  }

  const matched = [];
  const mismatched = [];
  const trackerOnly = [];
  const brokerOnly = [];
  let totalDrift = 0;
  let totalBrokerValue = 0;

  // Walk all symbols present in either source
  const allSymbols = new Set([...trackerMap.keys(), ...brokerMap.keys()]);

  for (const symbol of allSymbols) {
    const tPos = trackerMap.get(symbol);
    const bPos = brokerMap.get(symbol);

    if (tPos && bPos) {
      const qtyDiff = round2(bPos.qty - tPos.qty);
      const costDiff = round2(bPos.avgCost - tPos.avgCost);
      const valueDiff = round2(Math.abs(bPos.marketValue) - Math.abs(tPos.marketValue));

      // Qty tolerance: consider matched if within 0.01 shares (fractional share rounding)
      const qtyMatch = Math.abs(qtyDiff) < 0.01;
      // Cost tolerance: within $0.01
      const costMatch = Math.abs(costDiff) < 0.01;

      if (qtyMatch && costMatch) {
        matched.push({
          symbol,
          qty: bPos.qty,
          avgCost: round2(bPos.avgCost),
          side: bPos.side,
        });
      } else {
        const driftValue = Math.abs(qtyDiff * (bPos.currentPrice || bPos.avgCost));
        totalDrift += driftValue;
        mismatched.push({
          symbol,
          tracker: { qty: tPos.qty, avgCost: round2(tPos.avgCost), side: tPos.side },
          broker: { qty: bPos.qty, avgCost: round2(bPos.avgCost), side: bPos.side },
          qtyDiff,
          costDiff,
          driftValue: round2(driftValue),
        });
      }
      totalBrokerValue += Math.abs(bPos.marketValue || bPos.qty * bPos.avgCost);
    } else if (tPos && !bPos) {
      // Tracker has it, broker does not — phantom position
      const driftValue = Math.abs(tPos.qty * (tPos.currentPrice || tPos.avgCost));
      totalDrift += driftValue;
      trackerOnly.push({
        symbol,
        qty: tPos.qty,
        avgCost: round2(tPos.avgCost),
        side: tPos.side,
        driftValue: round2(driftValue),
      });
    } else if (!tPos && bPos) {
      // Broker has it, tracker does not — untracked position
      const driftValue = Math.abs(bPos.qty * (bPos.currentPrice || bPos.avgCost));
      totalDrift += driftValue;
      totalBrokerValue += Math.abs(bPos.marketValue || bPos.qty * bPos.avgCost);
      brokerOnly.push({
        symbol,
        qty: bPos.qty,
        avgCost: round2(bPos.avgCost),
        side: bPos.side,
        driftValue: round2(driftValue),
      });
    }
  }

  totalDrift = round2(totalDrift);
  const driftPct = totalBrokerValue > 0 ? round4(totalDrift / totalBrokerValue) : 0;

  const result = {
    matched,
    mismatched,
    trackerOnly,
    brokerOnly,
    totalDrift,
    driftPct,
    timestamp,
    clean: mismatched.length === 0 && trackerOnly.length === 0 && brokerOnly.length === 0,
  };

  _lastResult = result;

  // Persist to audit trail
  appendHistoryEntry({
    timestamp,
    matchedCount: matched.length,
    mismatchedCount: mismatched.length,
    trackerOnlyCount: trackerOnly.length,
    brokerOnlyCount: brokerOnly.length,
    totalDrift,
    driftPct,
    clean: result.clean,
    details: result.clean ? null : { mismatched, trackerOnly, brokerOnly },
  });

  return result;
}

// ─── Core: autoResolve() ─────────────────────────────────

/**
 * Auto-resolve discrepancies based on a strategy.
 *
 * @param {Object} discrepancies - Output of reconcile()
 * @param {string} strategy - 'broker-wins' | 'tracker-wins' | 'conservative'
 * @param {Object} tracker - PortfolioTracker instance (needed for broker-wins & conservative)
 * @returns {{ actions: Array, strategy: string, timestamp: string }}
 */
export function autoResolve(discrepancies, strategy, tracker) {
  const timestamp = nowISO();
  const actions = [];

  if (discrepancies.clean) {
    _lastResolution = { actions: [], strategy, timestamp, message: "No discrepancies to resolve" };
    return _lastResolution;
  }

  switch (strategy) {
    case "broker-wins": {
      // Trust the broker — update tracker to match broker state.
      // This is the safest strategy because the broker is the source of truth
      // for actual fills and settlements.

      for (const m of discrepancies.mismatched) {
        actions.push({
          type: "update_position",
          symbol: m.symbol,
          from: m.tracker,
          to: m.broker,
          reason: `Qty drift ${m.qtyDiff}, cost drift $${m.costDiff}`,
        });
      }

      for (const t of discrepancies.trackerOnly) {
        actions.push({
          type: "remove_position",
          symbol: t.symbol,
          removed: { qty: t.qty, avgCost: t.avgCost },
          reason: "Phantom position — exists in tracker but not at broker",
        });
      }

      for (const b of discrepancies.brokerOnly) {
        actions.push({
          type: "add_position",
          symbol: b.symbol,
          added: { qty: b.qty, avgCost: b.avgCost },
          reason: "Untracked position — exists at broker but not in tracker",
        });
      }

      // Apply to tracker if provided
      if (tracker && typeof tracker.syncFromBroker === "function") {
        // Build the broker positions array the tracker expects
        const brokerPositions = [];

        // Matched positions stay as-is from broker
        for (const m of discrepancies.matched) {
          brokerPositions.push({
            symbol: m.symbol,
            qty: String(m.qty),
            avg_entry_price: String(m.avgCost),
          });
        }

        // Mismatched — use broker values
        for (const m of discrepancies.mismatched) {
          brokerPositions.push({
            symbol: m.symbol,
            qty: String(m.broker.qty),
            avg_entry_price: String(m.broker.avgCost),
          });
        }

        // Broker-only positions — add them
        for (const b of discrepancies.brokerOnly) {
          brokerPositions.push({
            symbol: b.symbol,
            qty: String(b.qty),
            avg_entry_price: String(b.avgCost),
          });
        }

        // trackerOnly positions are implicitly removed (not in brokerPositions list)
        // We pass cash/equity as current values since syncFromBroker resets from broker
        // The caller should provide these; we preserve tracker's current cash as fallback
        const cash = tracker.cash || 0;
        const equity = tracker.getNAV ? tracker.getNAV({}) : cash;
        tracker.syncFromBroker(brokerPositions, cash, equity);
      }

      break;
    }

    case "tracker-wins": {
      // Trust the tracker — flag discrepancies for manual review.
      // Does NOT modify any state. Returns actions that describe what a human
      // should investigate.

      for (const m of discrepancies.mismatched) {
        actions.push({
          type: "review_required",
          symbol: m.symbol,
          tracker: m.tracker,
          broker: m.broker,
          reason: `Position mismatch — tracker says ${m.tracker.qty} shares, broker says ${m.broker.qty}. Manual review needed.`,
        });
      }

      for (const t of discrepancies.trackerOnly) {
        actions.push({
          type: "review_required",
          symbol: t.symbol,
          trackerQty: t.qty,
          reason: "Tracker has position not at broker — may need manual trade or tracker cleanup",
        });
      }

      for (const b of discrepancies.brokerOnly) {
        actions.push({
          type: "review_required",
          symbol: b.symbol,
          brokerQty: b.qty,
          reason: "Broker has position not in tracker — may need tracker update or position close",
        });
      }

      break;
    }

    case "conservative": {
      // Use the smaller position of the two — reduces risk exposure when uncertain.
      // For tracker-only or broker-only, treat the missing side as zero.

      for (const m of discrepancies.mismatched) {
        const trackerAbs = Math.abs(m.tracker.qty);
        const brokerAbs = Math.abs(m.broker.qty);
        const useQty = Math.min(trackerAbs, brokerAbs);
        // Preserve the sign from whichever side we're using
        const sign = m.broker.qty >= 0 ? 1 : -1;
        const resolvedQty = useQty * sign;
        const source = trackerAbs <= brokerAbs ? "tracker" : "broker";

        actions.push({
          type: "conservative_update",
          symbol: m.symbol,
          resolvedQty,
          source,
          tracker: m.tracker,
          broker: m.broker,
          reason: `Using smaller position (${useQty} shares from ${source})`,
        });
      }

      // Tracker-only: conservative = remove (smaller of tracker vs 0 = 0)
      for (const t of discrepancies.trackerOnly) {
        actions.push({
          type: "remove_position",
          symbol: t.symbol,
          removed: { qty: t.qty, avgCost: t.avgCost },
          reason: "Conservative: removing phantom position (broker has 0)",
        });
      }

      // Broker-only: conservative = ignore (don't add unverified positions)
      for (const b of discrepancies.brokerOnly) {
        actions.push({
          type: "review_required",
          symbol: b.symbol,
          brokerQty: b.qty,
          reason: "Conservative: broker-only position left for manual review (not auto-added)",
        });
      }

      break;
    }

    default:
      throw new Error(`Unknown reconciliation strategy: '${strategy}'. Use 'broker-wins', 'tracker-wins', or 'conservative'.`);
  }

  const resolution = {
    actions,
    strategy,
    timestamp,
    actionCount: actions.length,
  };

  _lastResolution = resolution;

  // Persist resolution to audit trail
  appendHistoryEntry({
    timestamp,
    type: "resolution",
    strategy,
    actionCount: actions.length,
    actions: actions.map(a => ({ type: a.type, symbol: a.symbol, reason: a.reason })),
  });

  return resolution;
}

// ─── Core: getReconciliationReport() ─────────────────────

/**
 * Generate a formatted text report of the last reconciliation.
 *
 * @returns {string} Human-readable report
 */
export function getReconciliationReport() {
  if (!_lastResult) {
    return "[reconciler] No reconciliation has been run yet.";
  }

  const r = _lastResult;
  const lines = [];

  lines.push("═══════════════════════════════════════════════════");
  lines.push("  POSITION RECONCILIATION REPORT");
  lines.push(`  ${r.timestamp}`);
  lines.push("═══════════════════════════════════════════════════");
  lines.push("");

  if (r.clean) {
    lines.push("  STATUS: CLEAN — all positions match");
    lines.push(`  Matched positions: ${r.matched.length}`);
  } else {
    const driftAlert = r.driftPct > 0.05 ? " *** SIGNIFICANT DRIFT ***" : "";
    lines.push(`  STATUS: DISCREPANCIES FOUND${driftAlert}`);
    lines.push(`  Total drift: $${r.totalDrift.toFixed(2)} (${(r.driftPct * 100).toFixed(2)}% of portfolio)`);
    lines.push(`  Matched:      ${r.matched.length}`);
    lines.push(`  Mismatched:   ${r.mismatched.length}`);
    lines.push(`  Tracker-only: ${r.trackerOnly.length} (phantom positions)`);
    lines.push(`  Broker-only:  ${r.brokerOnly.length} (untracked positions)`);
  }

  if (r.mismatched.length > 0) {
    lines.push("");
    lines.push("  ─── Mismatched Positions ──────────────────────");
    for (const m of r.mismatched) {
      lines.push(`  ${m.symbol}:`);
      lines.push(`    Tracker: ${m.tracker.qty} shares @ $${m.tracker.avgCost} (${m.tracker.side})`);
      lines.push(`    Broker:  ${m.broker.qty} shares @ $${m.broker.avgCost} (${m.broker.side})`);
      lines.push(`    Drift:   qty=${m.qtyDiff}, cost=$${m.costDiff}, value=$${m.driftValue}`);
    }
  }

  if (r.trackerOnly.length > 0) {
    lines.push("");
    lines.push("  ─── Tracker-Only (Phantom) ───────────────────");
    for (const t of r.trackerOnly) {
      lines.push(`  ${t.symbol}: ${t.qty} shares @ $${t.avgCost} ($${t.driftValue} drift)`);
    }
  }

  if (r.brokerOnly.length > 0) {
    lines.push("");
    lines.push("  ─── Broker-Only (Untracked) ──────────────────");
    for (const b of r.brokerOnly) {
      lines.push(`  ${b.symbol}: ${b.qty} shares @ $${b.avgCost} ($${b.driftValue} drift)`);
    }
  }

  if (_lastResolution) {
    lines.push("");
    lines.push(`  ─── Resolution (${_lastResolution.strategy}) ─────────────────`);
    lines.push(`  Actions taken: ${_lastResolution.actionCount}`);
    for (const a of _lastResolution.actions) {
      lines.push(`    [${a.type}] ${a.symbol}: ${a.reason}`);
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─── Core: scheduleReconciliation() ──────────────────────

let _scheduledTimer = null;

/**
 * Run reconciliation periodically.
 *
 * @param {number} intervalMs - How often to reconcile (e.g. 300_000 for 5 min)
 * @param {Object} fetchFns - Functions to fetch positions
 * @param {Function} fetchFns.getTrackerPositions - Returns tracker positions array
 * @param {Function} fetchFns.getBrokerPositions  - Returns broker positions array (async)
 * @param {Object}   fetchFns.tracker             - PortfolioTracker instance
 * @param {string}   [fetchFns.strategy='broker-wins'] - Resolution strategy
 * @param {Function} [fetchFns.onDrift]           - Called when drift > 5% with (result, report)
 * @returns {{ stop: Function }} - Call stop() to cancel scheduled reconciliation
 */
export function scheduleReconciliation(intervalMs, fetchFns) {
  // Clear any existing schedule
  if (_scheduledTimer) {
    clearInterval(_scheduledTimer);
    _scheduledTimer = null;
  }

  const {
    getTrackerPositions,
    getBrokerPositions,
    tracker,
    strategy = "broker-wins",
    onDrift,
  } = fetchFns;

  const runOnce = async () => {
    try {
      const [trackerPos, brokerPos] = await Promise.all([
        Promise.resolve(getTrackerPositions()),
        getBrokerPositions(),
      ]);

      const result = reconcile(trackerPos, brokerPos);

      if (!result.clean) {
        console.log(`[reconciler] Drift detected: $${result.totalDrift} (${(result.driftPct * 100).toFixed(2)}%)`);
        const resolution = autoResolve(result, strategy, tracker);
        console.log(`[reconciler] Applied ${resolution.actionCount} ${strategy} actions`);

        // Alert on significant drift (>5% of portfolio)
        if (result.driftPct > 0.05 && typeof onDrift === "function") {
          onDrift(result, getReconciliationReport());
        }
      }

      return result;
    } catch (err) {
      console.error(`[reconciler] Scheduled reconciliation failed: ${err.message}`);
      return null;
    }
  };

  // Run immediately, then on interval
  runOnce();

  _scheduledTimer = setInterval(runOnce, intervalMs);
  if (_scheduledTimer.unref) {
    _scheduledTimer.unref(); // Don't keep process alive just for reconciliation
  }

  return {
    stop() {
      if (_scheduledTimer) {
        clearInterval(_scheduledTimer);
        _scheduledTimer = null;
      }
    },
    runNow: runOnce,
  };
}

// ─── Audit: getReconciliationHistory() ───────────────────

/**
 * Retrieve reconciliation history for audit purposes.
 *
 * @param {number} [limit=50] - Max entries to return (most recent first)
 * @returns {Array} Reconciliation history entries
 */
export function getReconciliationHistory(limit = 50) {
  const history = loadHistory();
  return history.slice(-limit).reverse();
}

// ─── Drift Alert Helper ──────────────────────────────────

/**
 * Check whether the last reconciliation showed significant drift.
 *
 * @param {number} [thresholdPct=0.05] - Drift percentage threshold (default 5%)
 * @returns {{ drifted: boolean, totalDrift: number, driftPct: number, timestamp: string|null }}
 */
export function isDriftSignificant(thresholdPct = 0.05) {
  if (!_lastResult) {
    return { drifted: false, totalDrift: 0, driftPct: 0, timestamp: null };
  }
  return {
    drifted: _lastResult.driftPct > thresholdPct,
    totalDrift: _lastResult.totalDrift,
    driftPct: _lastResult.driftPct,
    timestamp: _lastResult.timestamp,
  };
}
