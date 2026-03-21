/**
 * Self-Healer — Crash recovery, incremental state saving, and self-healing for the daemon.
 *
 * Keeps the daemon alive across restarts by checkpointing state, tracking agent runs,
 * detecting stale/crashed agents, quarantining repeat offenders, and preserving the
 * best-known strategy parameters so the system never reverts to baseline.
 *
 * Exports:
 *   Checkpoint:
 *     saveCheckpoint(state)           — persist daemon state to disk
 *     loadCheckpoint()                — restore from last checkpoint
 *
 *   Agent tracking:
 *     markAgentStarted(name, ts)      — record agent start
 *     markAgentCompleted(name, result) — record agent completion
 *     detectStaleAgents(timeoutMs)    — find agents that started but never completed
 *
 *   Incremental state:
 *     getBestParams(strategyName)     — return best-known params for a strategy
 *     evolveFromBest(strategyName)    — get best params as mutation starting point
 *     recordExperiment(strategyName, params, metrics, status) — log an experiment
 *
 *   Self-healing:
 *     recordFailure(agentName)        — track a failure; returns { retryAllowed, quarantined }
 *     isQuarantined(agentName)        — check quarantine status
 *     releaseQuarantine(agentName)    — manually release
 *     shouldScaleDown()               — true if system is under pressure
 *     generateIncidentReport(event)   — write incident to disk
 *     getSystemReport()               — overall health + recovery actions taken
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "state");
const CHECKPOINT_PATH = join(STATE_DIR, "daemon-checkpoint.json");
const BEST_PARAMS_PATH = join(STATE_DIR, "best-params.json");
const EXPERIMENT_HISTORY_PATH = join(STATE_DIR, "experiment-history.json");
const INCIDENTS_PATH = join(STATE_DIR, "incidents.json");
const QUARANTINE_PATH = join(STATE_DIR, "quarantine.json");

// ─── Constants ──────────────────────────────────────────

const MAX_RETRIES = 3;
const MAX_EXPERIMENT_HISTORY = 2000;
const QUARANTINE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const SYSTEM_PRESSURE_THRESHOLD = 0.85; // 85% memory usage triggers scale-down

// ─── File helpers ───────────────────────────────────────

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Atomic write: write to tmp then rename so a crash mid-write
 * never corrupts the real file.
 */
function atomicWriteJSON(filePath, data) {
  ensureStateDir();
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

function readJSON(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ─── Checkpoint (daemon state) ──────────────────────────

/**
 * Save daemon state to disk. Called once per cycle.
 * @param {object} state — arbitrary daemon state (cycleCount, agentIndex, opts, etc.)
 */
export function saveCheckpoint(state) {
  const checkpoint = {
    ...state,
    savedAt: new Date().toISOString(),
    pid: process.pid,
  };
  atomicWriteJSON(CHECKPOINT_PATH, checkpoint);
}

/**
 * Load the last saved checkpoint, or null if none exists.
 * @returns {object|null}
 */
export function loadCheckpoint() {
  const data = readJSON(CHECKPOINT_PATH, null);
  if (!data) return null;
  // Validate basic structure
  if (typeof data.savedAt !== "string") return null;
  return data;
}

// ─── Agent run tracking ─────────────────────────────────

// In-memory tracker for the current process. Persisted inside checkpoint.
const _runningAgents = new Map();

/**
 * Mark an agent as started. Tracked in memory and persisted via checkpoint.
 * @param {string} agentName
 * @param {number} [timestamp] — epoch ms, defaults to Date.now()
 */
export function markAgentStarted(agentName, timestamp) {
  _runningAgents.set(agentName, {
    startedAt: timestamp ?? Date.now(),
    completedAt: null,
    result: null,
  });
}

/**
 * Mark an agent as completed.
 * @param {string} agentName
 * @param {object} result — { ok, sharpe, error, ... }
 */
export function markAgentCompleted(agentName, result) {
  const entry = _runningAgents.get(agentName);
  if (entry) {
    entry.completedAt = Date.now();
    entry.result = result;
  }
}

/**
 * Detect agents that started but never completed within the timeout.
 * On a fresh process start, this checks the previous checkpoint's running agents.
 * @param {number} timeoutMs — e.g. 300_000 (5 min)
 * @returns {Array<{agentName: string, startedAt: number, staleDurationMs: number}>}
 */
export function detectStaleAgents(timeoutMs = 300_000) {
  const now = Date.now();
  const stale = [];

  // Check in-memory agents
  for (const [name, entry] of _runningAgents) {
    if (!entry.completedAt && now - entry.startedAt > timeoutMs) {
      stale.push({
        agentName: name,
        startedAt: entry.startedAt,
        staleDurationMs: now - entry.startedAt,
      });
    }
  }

  // Also check checkpoint for agents that were running when the previous process died
  const checkpoint = loadCheckpoint();
  if (checkpoint?.runningAgents) {
    for (const [name, entry] of Object.entries(checkpoint.runningAgents)) {
      if (!entry.completedAt) {
        const started = entry.startedAt ?? 0;
        if (now - started > timeoutMs) {
          // Avoid duplicates
          if (!stale.find(s => s.agentName === name)) {
            stale.push({
              agentName: name,
              startedAt: started,
              staleDurationMs: now - started,
            });
          }
        }
      }
    }
  }

  return stale;
}

/**
 * Snapshot of running agents for embedding in checkpoint.
 * @returns {object}
 */
export function getRunningAgentsSnapshot() {
  const snapshot = {};
  for (const [name, entry] of _runningAgents) {
    snapshot[name] = { ...entry };
  }
  return snapshot;
}

// ─── Incremental state / best params ────────────────────

/**
 * Return the best-known parameters for a strategy.
 * @param {string} strategyName — e.g. "mean_reversion"
 * @returns {object|null} — { params, sharpe, updatedAt } or null
 */
export function getBestParams(strategyName) {
  const all = readJSON(BEST_PARAMS_PATH, {});
  return all[strategyName] ?? null;
}

/**
 * Return a copy of best params suitable for starting a new mutation.
 * If no best exists, returns null (caller should use baseline).
 * @param {string} strategyName
 * @returns {object|null} — the params object, or null
 */
export function evolveFromBest(strategyName) {
  const best = getBestParams(strategyName);
  if (!best?.params) return null;
  return { ...best.params };
}

/**
 * Record an experiment result. Updates best params if this experiment is
 * the new best for its strategy.
 * @param {string} strategyName
 * @param {object} params — { lookback, threshold, ... }
 * @param {object} metrics — { sharpe, sortino, ... }
 * @param {string} status — "keep" | "discard" | "crash"
 * @param {object} [lineage] — optional parent info
 */
export function recordExperiment(strategyName, params, metrics, status, lineage) {
  // ── Update best params ──
  if (status === "keep" && metrics?.sharpe != null) {
    const all = readJSON(BEST_PARAMS_PATH, {});
    const current = all[strategyName];
    if (!current || metrics.sharpe > (current.sharpe ?? -Infinity)) {
      all[strategyName] = {
        params: { ...params },
        sharpe: metrics.sharpe,
        sortino: metrics.sortino ?? null,
        totalReturn: metrics.total_return ?? null,
        updatedAt: new Date().toISOString(),
      };
      atomicWriteJSON(BEST_PARAMS_PATH, all);
    }
  }

  // ── Append to experiment history ──
  const history = readJSON(EXPERIMENT_HISTORY_PATH, []);
  history.push({
    strategyName,
    params: params ? { ...params } : null,
    metrics: metrics ? { ...metrics } : null,
    status,
    lineage: lineage ?? null,
    recordedAt: new Date().toISOString(),
  });

  // Trim to avoid unbounded growth
  if (history.length > MAX_EXPERIMENT_HISTORY) {
    history.splice(0, history.length - MAX_EXPERIMENT_HISTORY);
  }
  atomicWriteJSON(EXPERIMENT_HISTORY_PATH, history);
}

/**
 * Get experiment history for a strategy, optionally filtered.
 * @param {string} [strategyName] — filter by strategy, or null for all
 * @param {number} [limit] — max entries to return (most recent first)
 * @returns {Array<object>}
 */
export function getExperimentHistory(strategyName, limit = 50) {
  const history = readJSON(EXPERIMENT_HISTORY_PATH, []);
  let filtered = strategyName
    ? history.filter(h => h.strategyName === strategyName)
    : history;
  return filtered.slice(-limit);
}

// ─── Self-healing: failure tracking & quarantine ────────

/**
 * Record a failure for an agent. Manages retry count and quarantine.
 * @param {string} agentName
 * @returns {{ retryAllowed: boolean, retryCount: number, quarantined: boolean }}
 */
export function recordFailure(agentName) {
  const quarantine = readJSON(QUARANTINE_PATH, {});
  const entry = quarantine[agentName] ?? {
    failures: 0,
    lastFailure: null,
    quarantinedUntil: null,
    totalQuarantines: 0,
  };

  entry.failures += 1;
  entry.lastFailure = new Date().toISOString();

  let quarantined = false;
  if (entry.failures >= MAX_RETRIES) {
    // Exponential backoff on quarantine duration
    const multiplier = Math.min(entry.totalQuarantines + 1, 6);
    entry.quarantinedUntil = new Date(
      Date.now() + QUARANTINE_DURATION_MS * multiplier
    ).toISOString();
    entry.totalQuarantines += 1;
    quarantined = true;

    generateIncidentReport({
      type: "quarantine",
      agent: agentName,
      reason: `${entry.failures} consecutive failures, quarantined for ${multiplier * 30} minutes`,
      timestamp: new Date().toISOString(),
    });
  }

  quarantine[agentName] = entry;
  atomicWriteJSON(QUARANTINE_PATH, quarantine);

  return {
    retryAllowed: entry.failures < MAX_RETRIES,
    retryCount: entry.failures,
    quarantined,
  };
}

/**
 * Check whether an agent is currently quarantined.
 * Automatically releases if quarantine has expired.
 * @param {string} agentName
 * @returns {boolean}
 */
export function isQuarantined(agentName) {
  const quarantine = readJSON(QUARANTINE_PATH, {});
  const entry = quarantine[agentName];
  if (!entry?.quarantinedUntil) return false;

  const until = new Date(entry.quarantinedUntil).getTime();
  if (Date.now() >= until) {
    // Quarantine expired — release and reset failure count
    entry.quarantinedUntil = null;
    entry.failures = 0;
    quarantine[agentName] = entry;
    atomicWriteJSON(QUARANTINE_PATH, quarantine);
    return false;
  }
  return true;
}

/**
 * Manually release an agent from quarantine.
 * @param {string} agentName
 */
export function releaseQuarantine(agentName) {
  const quarantine = readJSON(QUARANTINE_PATH, {});
  const entry = quarantine[agentName];
  if (entry) {
    entry.quarantinedUntil = null;
    entry.failures = 0;
    quarantine[agentName] = entry;
    atomicWriteJSON(QUARANTINE_PATH, quarantine);
  }
}

/**
 * Reset failure counter for an agent after a successful run.
 * @param {string} agentName
 */
export function clearFailures(agentName) {
  const quarantine = readJSON(QUARANTINE_PATH, {});
  const entry = quarantine[agentName];
  if (entry) {
    entry.failures = 0;
    quarantine[agentName] = entry;
    atomicWriteJSON(QUARANTINE_PATH, quarantine);
  }
}

// ─── System pressure detection ──────────────────────────

/**
 * Check if the system is under memory pressure.
 * @returns {{ underPressure: boolean, memoryUsage: number, recommendation: string }}
 */
export function shouldScaleDown() {
  const mem = process.memoryUsage();
  const heapUsed = mem.heapUsed;
  const heapTotal = mem.heapTotal;
  const ratio = heapTotal > 0 ? heapUsed / heapTotal : 0;

  // Also check RSS against system memory if available
  let systemPressure = false;
  try {
    const memInfo = readFileSync("/proc/meminfo", "utf-8");
    const totalMatch = memInfo.match(/MemTotal:\s+(\d+)/);
    const availMatch = memInfo.match(/MemAvailable:\s+(\d+)/);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1]);
      const avail = parseInt(availMatch[1]);
      const used = (total - avail) / total;
      if (used > SYSTEM_PRESSURE_THRESHOLD) {
        systemPressure = true;
      }
    }
  } catch {
    // /proc/meminfo not available — rely on heap metrics only
  }

  const underPressure = ratio > SYSTEM_PRESSURE_THRESHOLD || systemPressure;
  let recommendation = "normal";
  if (underPressure) {
    recommendation = "reduce iterations and increase sleep between cycles";
  }

  return {
    underPressure,
    heapUsedMB: Math.round(heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(heapTotal / 1024 / 1024),
    heapRatio: Math.round(ratio * 100),
    systemPressure,
    recommendation,
  };
}

// ─── Incident reports ───────────────────────────────────

/**
 * Write an incident report to the incidents log.
 * @param {object} event — { type, agent, reason, timestamp, ... }
 */
export function generateIncidentReport(event) {
  ensureStateDir();
  const incidents = readJSON(INCIDENTS_PATH, []);
  incidents.push({
    id: `INC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...event,
    recordedAt: new Date().toISOString(),
  });

  // Keep last 500 incidents
  if (incidents.length > 500) {
    incidents.splice(0, incidents.length - 500);
  }
  atomicWriteJSON(INCIDENTS_PATH, incidents);
}

// ─── System report ──────────────────────────────────────

/**
 * Generate a comprehensive system health report.
 * @returns {object}
 */
export function getSystemReport() {
  const checkpoint = loadCheckpoint();
  const quarantine = readJSON(QUARANTINE_PATH, {});
  const incidents = readJSON(INCIDENTS_PATH, []);
  const bestParams = readJSON(BEST_PARAMS_PATH, {});
  const pressure = shouldScaleDown();

  // Count active quarantines
  const now = Date.now();
  const activeQuarantines = Object.entries(quarantine)
    .filter(([, e]) => {
      if (!e.quarantinedUntil) return false;
      return new Date(e.quarantinedUntil).getTime() > now;
    })
    .map(([name, e]) => ({
      agent: name,
      until: e.quarantinedUntil,
      failures: e.failures,
      totalQuarantines: e.totalQuarantines,
    }));

  // Recent incidents (last 24h)
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const recentIncidents = incidents.filter(i => i.recordedAt > oneDayAgo);

  // Stale agents
  const staleAgents = detectStaleAgents();

  // Strategies with saved best params
  const strategySummary = {};
  for (const [name, data] of Object.entries(bestParams)) {
    strategySummary[name] = {
      bestSharpe: data.sharpe,
      updatedAt: data.updatedAt,
    };
  }

  return {
    status: activeQuarantines.length === 0 && staleAgents.length === 0 && !pressure.underPressure
      ? "healthy"
      : "degraded",
    checkpoint: checkpoint
      ? { cycleCount: checkpoint.cycleCount, savedAt: checkpoint.savedAt }
      : null,
    memory: pressure,
    activeQuarantines,
    staleAgents,
    recentIncidents: recentIncidents.length,
    totalIncidents: incidents.length,
    strategiesTracked: Object.keys(strategySummary).length,
    strategySummary,
    recoveryActions: recentIncidents
      .filter(i => i.type === "recovery" || i.type === "quarantine")
      .slice(-10),
  };
}
