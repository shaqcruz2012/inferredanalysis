/**
 * Health Actions — Threshold-based alerting and automated response system
 *
 * Evaluates health metrics against defined thresholds, triggers alerts,
 * and executes corrective actions (restart agents, pause strategies,
 * scale positions, send notifications).
 *
 * Exports:
 *   evaluateHealth(metrics)   — returns triggered alerts with severity
 *   executeAction(alert, ctx) — takes corrective action based on alert type
 *   getHealthDashboard()      — summary of current system health
 *   writeHealthCheckFile()    — writes periodic health check for external monitors
 *   THRESHOLDS                — threshold configuration (importable for tests)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { safeReadJSON, safeWriteJSON, atomicAppendFile } from "./atomic-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const ROOT = join(AGENTS_DIR, "..");
const LOG_DIR = join(ROOT, "agents", "outputs");
const HEALTH_ACTIONS_LOG = join(LOG_DIR, "health-actions.log");
const HEALTH_CHECK_FILE = join(ROOT, ".health-check.json");
const HEALTH_STATE_FILE = join(ROOT, ".health-state.json");

// ─── Thresholds ──────────────────────────────────────────

export const THRESHOLDS = {
  latency: {
    warn: 500,       // ms
    critical: 2000,  // ms
  },
  memory: {
    warn: 80,        // percent
    critical: 95,    // percent
  },
  errorRate: {
    warn: 5,         // percent
    critical: 20,    // percent
  },
  sharpeDegradation: {
    warn: 0.5,       // drop from baseline
  },
  drawdown: {
    warn: 10,        // percent
    critical: 20,    // percent
  },
  cpu: {
    warn: 1.0,       // load per core
    critical: 1.5,   // load per core
  },
  disk: {
    warn: 80,        // percent
    critical: 95,    // percent
  },
  heartbeat: {
    warn: 120,       // seconds since last heartbeat
    critical: 300,   // seconds since last heartbeat
  },
};

// ─── Severity Levels ─────────────────────────────────────

export const Severity = {
  OK: "ok",
  WARN: "warn",
  CRITICAL: "critical",
};

const SEVERITY_PRIORITY = {
  [Severity.OK]: 0,
  [Severity.WARN]: 1,
  [Severity.CRITICAL]: 2,
};

// ─── Alert Types ─────────────────────────────────────────

export const AlertType = {
  LATENCY_HIGH: "latency_high",
  MEMORY_HIGH: "memory_high",
  ERROR_RATE_HIGH: "error_rate_high",
  SHARPE_DEGRADED: "sharpe_degraded",
  DRAWDOWN_HIGH: "drawdown_high",
  CPU_HIGH: "cpu_high",
  DISK_HIGH: "disk_high",
  HEARTBEAT_STALE: "heartbeat_stale",
  SERVICE_DOWN: "service_down",
  AGENT_STALLED: "agent_stalled",
};

// ─── Action Types ────────────────────────────────────────

export const ActionType = {
  RESTART_AGENT: "restart_agent",
  PAUSE_STRATEGY: "pause_strategy",
  SCALE_DOWN_POSITIONS: "scale_down_positions",
  NOTIFY: "notify",
  LOG: "log",
};

// ─── Logging ─────────────────────────────────────────────

function logAction(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [health-actions] ${msg}`;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    atomicAppendFile(HEALTH_ACTIONS_LOG, line);
  } catch { /* best effort */ }
  return line;
}

// ─── State Persistence ──────────────────────────────────

function loadState() {
  try {
    if (existsSync(HEALTH_STATE_FILE)) {
      return JSON.parse(readFileSync(HEALTH_STATE_FILE, "utf-8"));
    }
  } catch { /* fresh state */ }
  return {
    sharpeBaselines: {},
    lastAlerts: [],
    lastActions: [],
    lastCheck: null,
    alertHistory: [],
    actionHistory: [],
  };
}

function saveState(state) {
  try {
    // Keep history bounded — last 500 entries
    if (state.alertHistory.length > 500) {
      state.alertHistory = state.alertHistory.slice(-500);
    }
    if (state.actionHistory.length > 500) {
      state.actionHistory = state.actionHistory.slice(-500);
    }
    writeFileSync(HEALTH_STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

// ─── evaluateHealth(metrics) ────────────────────────────
//
// Takes a metrics object with any combination of:
//   latency_ms, memory_pct, error_rate_pct, sharpe, sharpe_baseline,
//   drawdown_pct, cpu_load_per_core, disk_pct, heartbeat_age_s,
//   services (array of { name, status }),
//   agents (array of { name, lastActivity, status })
//
// Returns: { alerts: Alert[], overallSeverity: string }

export function evaluateHealth(metrics) {
  const alerts = [];

  // --- Latency ---
  if (metrics.latency_ms !== undefined && metrics.latency_ms !== null) {
    if (metrics.latency_ms > THRESHOLDS.latency.critical) {
      alerts.push({
        type: AlertType.LATENCY_HIGH,
        severity: Severity.CRITICAL,
        metric: "latency_ms",
        value: metrics.latency_ms,
        threshold: THRESHOLDS.latency.critical,
        message: `Latency ${metrics.latency_ms}ms exceeds critical threshold (${THRESHOLDS.latency.critical}ms)`,
      });
    } else if (metrics.latency_ms > THRESHOLDS.latency.warn) {
      alerts.push({
        type: AlertType.LATENCY_HIGH,
        severity: Severity.WARN,
        metric: "latency_ms",
        value: metrics.latency_ms,
        threshold: THRESHOLDS.latency.warn,
        message: `Latency ${metrics.latency_ms}ms exceeds warn threshold (${THRESHOLDS.latency.warn}ms)`,
      });
    }
  }

  // --- Memory ---
  if (metrics.memory_pct !== undefined && metrics.memory_pct !== null) {
    if (metrics.memory_pct > THRESHOLDS.memory.critical) {
      alerts.push({
        type: AlertType.MEMORY_HIGH,
        severity: Severity.CRITICAL,
        metric: "memory_pct",
        value: metrics.memory_pct,
        threshold: THRESHOLDS.memory.critical,
        message: `Memory usage ${metrics.memory_pct.toFixed(1)}% exceeds critical threshold (${THRESHOLDS.memory.critical}%)`,
      });
    } else if (metrics.memory_pct > THRESHOLDS.memory.warn) {
      alerts.push({
        type: AlertType.MEMORY_HIGH,
        severity: Severity.WARN,
        metric: "memory_pct",
        value: metrics.memory_pct,
        threshold: THRESHOLDS.memory.warn,
        message: `Memory usage ${metrics.memory_pct.toFixed(1)}% exceeds warn threshold (${THRESHOLDS.memory.warn}%)`,
      });
    }
  }

  // --- Error Rate ---
  if (metrics.error_rate_pct !== undefined && metrics.error_rate_pct !== null) {
    if (metrics.error_rate_pct > THRESHOLDS.errorRate.critical) {
      alerts.push({
        type: AlertType.ERROR_RATE_HIGH,
        severity: Severity.CRITICAL,
        metric: "error_rate_pct",
        value: metrics.error_rate_pct,
        threshold: THRESHOLDS.errorRate.critical,
        message: `Error rate ${metrics.error_rate_pct.toFixed(1)}% exceeds critical threshold (${THRESHOLDS.errorRate.critical}%)`,
      });
    } else if (metrics.error_rate_pct > THRESHOLDS.errorRate.warn) {
      alerts.push({
        type: AlertType.ERROR_RATE_HIGH,
        severity: Severity.WARN,
        metric: "error_rate_pct",
        value: metrics.error_rate_pct,
        threshold: THRESHOLDS.errorRate.warn,
        message: `Error rate ${metrics.error_rate_pct.toFixed(1)}% exceeds warn threshold (${THRESHOLDS.errorRate.warn}%)`,
      });
    }
  }

  // --- Sharpe Degradation ---
  if (metrics.sharpe !== undefined && metrics.sharpe !== null) {
    const state = loadState();
    const baselineKey = metrics.strategy || "_default";
    const baseline = metrics.sharpe_baseline ?? state.sharpeBaselines[baselineKey];

    if (baseline !== undefined && baseline !== null && isFinite(baseline) && isFinite(metrics.sharpe)) {
      const drop = baseline - metrics.sharpe;
      if (drop > THRESHOLDS.sharpeDegradation.warn) {
        alerts.push({
          type: AlertType.SHARPE_DEGRADED,
          severity: Severity.WARN,
          metric: "sharpe",
          value: metrics.sharpe,
          baseline,
          drop,
          threshold: THRESHOLDS.sharpeDegradation.warn,
          strategy: metrics.strategy || "unknown",
          message: `Sharpe dropped ${drop.toFixed(4)} from baseline ${baseline.toFixed(4)} (threshold: ${THRESHOLDS.sharpeDegradation.warn})`,
        });
      }
    }

    // Update baseline tracking — use a rolling max as the baseline reference
    if (isFinite(metrics.sharpe)) {
      if (!state.sharpeBaselines[baselineKey] || metrics.sharpe > state.sharpeBaselines[baselineKey]) {
        state.sharpeBaselines[baselineKey] = metrics.sharpe;
        saveState(state);
      }
    }
  }

  // --- Drawdown ---
  if (metrics.drawdown_pct !== undefined && metrics.drawdown_pct !== null) {
    if (metrics.drawdown_pct > THRESHOLDS.drawdown.critical) {
      alerts.push({
        type: AlertType.DRAWDOWN_HIGH,
        severity: Severity.CRITICAL,
        metric: "drawdown_pct",
        value: metrics.drawdown_pct,
        threshold: THRESHOLDS.drawdown.critical,
        message: `Drawdown ${metrics.drawdown_pct.toFixed(1)}% exceeds critical threshold (${THRESHOLDS.drawdown.critical}%)`,
      });
    } else if (metrics.drawdown_pct > THRESHOLDS.drawdown.warn) {
      alerts.push({
        type: AlertType.DRAWDOWN_HIGH,
        severity: Severity.WARN,
        metric: "drawdown_pct",
        value: metrics.drawdown_pct,
        threshold: THRESHOLDS.drawdown.warn,
        message: `Drawdown ${metrics.drawdown_pct.toFixed(1)}% exceeds warn threshold (${THRESHOLDS.drawdown.warn}%)`,
      });
    }
  }

  // --- CPU ---
  if (metrics.cpu_load_per_core !== undefined && metrics.cpu_load_per_core !== null) {
    if (metrics.cpu_load_per_core > THRESHOLDS.cpu.critical) {
      alerts.push({
        type: AlertType.CPU_HIGH,
        severity: Severity.CRITICAL,
        metric: "cpu_load_per_core",
        value: metrics.cpu_load_per_core,
        threshold: THRESHOLDS.cpu.critical,
        message: `CPU load/core ${metrics.cpu_load_per_core.toFixed(2)} exceeds critical threshold (${THRESHOLDS.cpu.critical})`,
      });
    } else if (metrics.cpu_load_per_core > THRESHOLDS.cpu.warn) {
      alerts.push({
        type: AlertType.CPU_HIGH,
        severity: Severity.WARN,
        metric: "cpu_load_per_core",
        value: metrics.cpu_load_per_core,
        threshold: THRESHOLDS.cpu.warn,
        message: `CPU load/core ${metrics.cpu_load_per_core.toFixed(2)} exceeds warn threshold (${THRESHOLDS.cpu.warn})`,
      });
    }
  }

  // --- Disk ---
  if (metrics.disk_pct !== undefined && metrics.disk_pct !== null) {
    if (metrics.disk_pct > THRESHOLDS.disk.critical) {
      alerts.push({
        type: AlertType.DISK_HIGH,
        severity: Severity.CRITICAL,
        metric: "disk_pct",
        value: metrics.disk_pct,
        threshold: THRESHOLDS.disk.critical,
        message: `Disk usage ${metrics.disk_pct}% exceeds critical threshold (${THRESHOLDS.disk.critical}%)`,
      });
    } else if (metrics.disk_pct > THRESHOLDS.disk.warn) {
      alerts.push({
        type: AlertType.DISK_HIGH,
        severity: Severity.WARN,
        metric: "disk_pct",
        value: metrics.disk_pct,
        threshold: THRESHOLDS.disk.warn,
        message: `Disk usage ${metrics.disk_pct}% exceeds warn threshold (${THRESHOLDS.disk.warn}%)`,
      });
    }
  }

  // --- Heartbeat ---
  if (metrics.heartbeat_age_s !== undefined && metrics.heartbeat_age_s !== null) {
    if (metrics.heartbeat_age_s > THRESHOLDS.heartbeat.critical) {
      alerts.push({
        type: AlertType.HEARTBEAT_STALE,
        severity: Severity.CRITICAL,
        metric: "heartbeat_age_s",
        value: metrics.heartbeat_age_s,
        threshold: THRESHOLDS.heartbeat.critical,
        message: `Heartbeat stale for ${metrics.heartbeat_age_s}s (critical threshold: ${THRESHOLDS.heartbeat.critical}s)`,
      });
    } else if (metrics.heartbeat_age_s > THRESHOLDS.heartbeat.warn) {
      alerts.push({
        type: AlertType.HEARTBEAT_STALE,
        severity: Severity.WARN,
        metric: "heartbeat_age_s",
        value: metrics.heartbeat_age_s,
        threshold: THRESHOLDS.heartbeat.warn,
        message: `Heartbeat stale for ${metrics.heartbeat_age_s}s (warn threshold: ${THRESHOLDS.heartbeat.warn}s)`,
      });
    }
  }

  // --- Down Services ---
  if (Array.isArray(metrics.services)) {
    for (const svc of metrics.services) {
      if (svc.status === "critical" || svc.status === "emergency") {
        alerts.push({
          type: AlertType.SERVICE_DOWN,
          severity: Severity.CRITICAL,
          service: svc.name,
          message: `Service ${svc.name} is down: ${svc.error || svc.status}`,
        });
      }
    }
  }

  // --- Stalled Agents ---
  if (Array.isArray(metrics.agents)) {
    const stallThreshold = 30 * 60 * 1000; // 30 minutes with no activity
    const now = Date.now();
    for (const agent of metrics.agents) {
      if (agent.lastActivity && (now - new Date(agent.lastActivity).getTime()) > stallThreshold) {
        alerts.push({
          type: AlertType.AGENT_STALLED,
          severity: Severity.WARN,
          agent: agent.name,
          lastActivity: agent.lastActivity,
          message: `Agent ${agent.name} has been inactive for ${Math.round((now - new Date(agent.lastActivity).getTime()) / 60000)} minutes`,
        });
      }
    }
  }

  // Determine overall severity
  let overallSeverity = Severity.OK;
  for (const alert of alerts) {
    if (SEVERITY_PRIORITY[alert.severity] > SEVERITY_PRIORITY[overallSeverity]) {
      overallSeverity = alert.severity;
    }
  }

  // Persist alert state
  const state = loadState();
  const timestamp = new Date().toISOString();
  state.lastAlerts = alerts;
  state.lastCheck = timestamp;
  for (const alert of alerts) {
    state.alertHistory.push({ ...alert, timestamp });
  }
  saveState(state);

  return { alerts, overallSeverity };
}

// ─── executeAction(alert, ctx) ──────────────────────────
//
// Takes an alert object and a context with available action handlers.
// ctx = {
//   notifyFn(message),         — send notification (e.g., Telegram)
//   restartAgentFn(agentName), — restart a stalled agent
//   pauseStrategyFn(strategy), — pause a degraded strategy
//   scalePositionsFn(factor),  — scale position sizes by factor
// }
//
// Returns: { actions: ActionResult[] }

export async function executeAction(alert, ctx = {}) {
  const actions = [];
  const timestamp = new Date().toISOString();

  // Determine which actions to take based on alert type
  switch (alert.type) {
    case AlertType.AGENT_STALLED: {
      // Restart stalled agent
      if (typeof ctx.restartAgentFn === "function") {
        try {
          const result = await ctx.restartAgentFn(alert.agent);
          const action = {
            type: ActionType.RESTART_AGENT,
            target: alert.agent,
            success: !!result,
            timestamp,
            detail: `Restarted stalled agent ${alert.agent}`,
          };
          actions.push(action);
          logAction(`ACTION: ${action.detail} — ${action.success ? "success" : "failed"}`);
        } catch (err) {
          const action = {
            type: ActionType.RESTART_AGENT,
            target: alert.agent,
            success: false,
            timestamp,
            detail: `Failed to restart ${alert.agent}: ${err.message}`,
          };
          actions.push(action);
          logAction(`ACTION FAILED: ${action.detail}`);
        }
      } else {
        logAction(`ALERT (no handler): Agent ${alert.agent} is stalled — manual restart needed`);
      }
      break;
    }

    case AlertType.SERVICE_DOWN: {
      // Restart the service if possible
      if (typeof ctx.restartAgentFn === "function" && alert.service === "daemon") {
        try {
          const result = await ctx.restartAgentFn("daemon");
          const action = {
            type: ActionType.RESTART_AGENT,
            target: alert.service,
            success: !!result,
            timestamp,
            detail: `Restarted down service ${alert.service}`,
          };
          actions.push(action);
          logAction(`ACTION: ${action.detail} — ${action.success ? "success" : "failed"}`);
        } catch (err) {
          logAction(`ACTION FAILED: restart ${alert.service}: ${err.message}`);
        }
      }
      break;
    }

    case AlertType.SHARPE_DEGRADED: {
      // Pause strategy with degraded Sharpe
      if (typeof ctx.pauseStrategyFn === "function") {
        try {
          const result = await ctx.pauseStrategyFn(alert.strategy);
          const action = {
            type: ActionType.PAUSE_STRATEGY,
            target: alert.strategy,
            success: !!result,
            timestamp,
            detail: `Paused strategy ${alert.strategy} (Sharpe dropped ${alert.drop?.toFixed(4)} from baseline)`,
          };
          actions.push(action);
          logAction(`ACTION: ${action.detail} — ${action.success ? "success" : "failed"}`);
        } catch (err) {
          logAction(`ACTION FAILED: pause strategy ${alert.strategy}: ${err.message}`);
        }
      } else {
        logAction(`ALERT (no handler): Strategy ${alert.strategy} Sharpe degraded — manual pause recommended`);
      }
      break;
    }

    case AlertType.DRAWDOWN_HIGH: {
      // Scale down positions during high drawdown
      if (typeof ctx.scalePositionsFn === "function") {
        const factor = alert.severity === Severity.CRITICAL ? 0.25 : 0.5;
        try {
          const result = await ctx.scalePositionsFn(factor);
          const action = {
            type: ActionType.SCALE_DOWN_POSITIONS,
            target: `positions scaled to ${(factor * 100).toFixed(0)}%`,
            success: !!result,
            timestamp,
            detail: `Scaled positions to ${(factor * 100).toFixed(0)}% due to ${alert.value?.toFixed(1)}% drawdown`,
          };
          actions.push(action);
          logAction(`ACTION: ${action.detail} — ${action.success ? "success" : "failed"}`);
        } catch (err) {
          logAction(`ACTION FAILED: scale positions: ${err.message}`);
        }
      } else {
        logAction(`ALERT (no handler): Drawdown ${alert.value?.toFixed(1)}% — manual position scaling recommended`);
      }
      break;
    }

    default:
      // For all other alerts, just log
      break;
  }

  // Always send notification for any alert
  if (typeof ctx.notifyFn === "function") {
    try {
      const prefix = alert.severity === Severity.CRITICAL ? "[CRITICAL]" : "[WARN]";
      await ctx.notifyFn(`${prefix} ${alert.message}`);
      actions.push({
        type: ActionType.NOTIFY,
        target: "notification",
        success: true,
        timestamp,
        detail: `Sent notification: ${alert.message}`,
      });
    } catch (err) {
      logAction(`NOTIFY FAILED: ${err.message}`);
    }
  }

  // Always log for audit trail
  const auditEntry = {
    type: ActionType.LOG,
    alert: { type: alert.type, severity: alert.severity, message: alert.message },
    actionsExecuted: actions.map(a => ({ type: a.type, target: a.target, success: a.success })),
    timestamp,
  };
  logAction(`AUDIT: ${JSON.stringify(auditEntry)}`);

  // Persist action state
  const state = loadState();
  state.lastActions = actions;
  for (const action of actions) {
    state.actionHistory.push(action);
  }
  saveState(state);

  return { actions };
}

// ─── Bulk processing: evaluate + act on all alerts ──────

export async function evaluateAndAct(metrics, ctx = {}) {
  const { alerts, overallSeverity } = evaluateHealth(metrics);
  const allActions = [];

  for (const alert of alerts) {
    const { actions } = await executeAction(alert, ctx);
    allActions.push(...actions);
  }

  return { alerts, overallSeverity, actions: allActions };
}

// ─── collectSystemMetrics() ─────────────────────────────
//
// Gathers current system metrics from OS and local state,
// suitable for passing directly to evaluateHealth().

export function collectSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memoryPct = ((totalMem - freeMem) / totalMem) * 100;

  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cpuLoadPerCore = loadAvg[0] / (cpus.length || 1);

  // Disk usage
  let diskPct = null;
  try {
    const output = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 });
    const pctStr = output.match(/(\d+)%/);
    if (pctStr) diskPct = parseInt(pctStr[1]);
  } catch { /* skip */ }

  // Heartbeat age
  let heartbeatAge = null;
  const heartbeatFile = join(ROOT, ".health-heartbeat");
  try {
    if (existsSync(heartbeatFile)) {
      const data = JSON.parse(readFileSync(heartbeatFile, "utf-8"));
      heartbeatAge = Math.round((Date.now() - data.timestamp) / 1000);
    }
  } catch { /* skip */ }

  // Compute error rate from recent daemon log
  let errorRate = null;
  const daemonLog = join(LOG_DIR, "daemon.log");
  try {
    if (existsSync(daemonLog)) {
      const content = readFileSync(daemonLog, "utf-8");
      const lines = content.trim().split("\n").slice(-100); // last 100 lines
      const errorLines = lines.filter(l => l.includes("ERROR") || l.includes("FATAL") || l.includes("crash"));
      errorRate = lines.length > 0 ? (errorLines.length / lines.length) * 100 : 0;
    }
  } catch { /* skip */ }

  // Check service status
  const services = [];
  const pidFile = join(ROOT, ".daemon.pid");
  try {
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
      try {
        process.kill(pid, 0);
        services.push({ name: "daemon", status: "ok" });
      } catch {
        services.push({ name: "daemon", status: "critical", error: `PID ${pid} not running` });
      }
    } else {
      services.push({ name: "daemon", status: "critical", error: "No PID file" });
    }
  } catch { /* skip */ }

  const metrics = {
    memory_pct: Math.round(memoryPct * 10) / 10,
    cpu_load_per_core: Math.round(cpuLoadPerCore * 100) / 100,
    services,
  };

  if (diskPct !== null) metrics.disk_pct = diskPct;
  if (heartbeatAge !== null) metrics.heartbeat_age_s = heartbeatAge;
  if (errorRate !== null) metrics.error_rate_pct = Math.round(errorRate * 10) / 10;

  return metrics;
}

// ─── getHealthDashboard() ───────────────────────────────
//
// Returns a structured summary of current system health with
// color coding and status indicators.

export function getHealthDashboard() {
  const state = loadState();
  const now = new Date().toISOString();

  // Gather current metrics
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memoryPct = ((totalMem - freeMem) / totalMem) * 100;
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cpuLoadPerCore = loadAvg[0] / (cpus.length || 1);

  // Color coding helper (for terminal output)
  const colorCode = (severity) => {
    switch (severity) {
      case Severity.CRITICAL: return "RED";
      case Severity.WARN: return "YELLOW";
      case Severity.OK: return "GREEN";
      default: return "GRAY";
    }
  };

  const statusIcon = (severity) => {
    switch (severity) {
      case Severity.CRITICAL: return "[!!]";
      case Severity.WARN: return "[!.]";
      case Severity.OK: return "[OK]";
      default: return "[??]";
    }
  };

  // Evaluate current thresholds for dashboard display
  const memSeverity = memoryPct > THRESHOLDS.memory.critical ? Severity.CRITICAL
    : memoryPct > THRESHOLDS.memory.warn ? Severity.WARN : Severity.OK;
  const cpuSeverity = cpuLoadPerCore > THRESHOLDS.cpu.critical ? Severity.CRITICAL
    : cpuLoadPerCore > THRESHOLDS.cpu.warn ? Severity.WARN : Severity.OK;

  // Determine overall severity from last known alerts
  let overallSeverity = Severity.OK;
  if (state.lastAlerts) {
    for (const alert of state.lastAlerts) {
      if (SEVERITY_PRIORITY[alert.severity] > SEVERITY_PRIORITY[overallSeverity]) {
        overallSeverity = alert.severity;
      }
    }
  }

  // Recent alerts (last hour)
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const recentAlerts = (state.alertHistory || []).filter(a => a.timestamp > oneHourAgo);
  const recentActions = (state.actionHistory || []).filter(a => a.timestamp > oneHourAgo);

  // Alert counts by severity
  const alertCounts = { warn: 0, critical: 0 };
  for (const a of recentAlerts) {
    if (a.severity === Severity.WARN) alertCounts.warn++;
    if (a.severity === Severity.CRITICAL) alertCounts.critical++;
  }

  const dashboard = {
    timestamp: now,
    overallStatus: overallSeverity,
    overallColor: colorCode(overallSeverity),
    overallIcon: statusIcon(overallSeverity),
    subsystems: {
      memory: {
        value: Math.round(memoryPct * 10) / 10,
        unit: "%",
        severity: memSeverity,
        color: colorCode(memSeverity),
        icon: statusIcon(memSeverity),
        thresholds: THRESHOLDS.memory,
      },
      cpu: {
        value: Math.round(cpuLoadPerCore * 100) / 100,
        unit: "load/core",
        severity: cpuSeverity,
        color: colorCode(cpuSeverity),
        icon: statusIcon(cpuSeverity),
        thresholds: THRESHOLDS.cpu,
      },
    },
    recentAlerts: {
      lastHour: recentAlerts.length,
      critical: alertCounts.critical,
      warn: alertCounts.warn,
      latest: recentAlerts.slice(-5),
    },
    recentActions: {
      lastHour: recentActions.length,
      latest: recentActions.slice(-5),
    },
    lastCheck: state.lastCheck,
    sharpeBaselines: state.sharpeBaselines || {},
  };

  return dashboard;
}

// ─── formatDashboard() ──────────────────────────────────
//
// Returns a human-readable string for terminal output.

export function formatDashboard() {
  const d = getHealthDashboard();
  const w = 62;

  let out = `\n${"=".repeat(w)}\n`;
  out += `  HEALTH ACTIONS DASHBOARD\n`;
  out += `  ${d.timestamp}\n`;
  out += `  Overall: ${d.overallIcon} ${d.overallStatus.toUpperCase()} (${d.overallColor})\n`;
  out += `${"=".repeat(w)}\n\n`;

  out += `  SUBSYSTEMS\n`;
  out += `  ${d.subsystems.memory.icon} Memory: ${d.subsystems.memory.value}% (warn>${d.subsystems.memory.thresholds.warn}%, crit>${d.subsystems.memory.thresholds.critical}%)\n`;
  out += `  ${d.subsystems.cpu.icon} CPU:    ${d.subsystems.cpu.value} load/core (warn>${d.subsystems.cpu.thresholds.warn}, crit>${d.subsystems.cpu.thresholds.critical})\n`;
  out += `\n`;

  out += `  ALERTS (last hour)\n`;
  out += `  Total: ${d.recentAlerts.lastHour} | Critical: ${d.recentAlerts.critical} | Warn: ${d.recentAlerts.warn}\n`;
  if (d.recentAlerts.latest.length > 0) {
    for (const a of d.recentAlerts.latest) {
      const prefix = a.severity === Severity.CRITICAL ? "[!!]" : "[!.]";
      out += `    ${prefix} ${a.message}\n`;
    }
  } else {
    out += `    No recent alerts\n`;
  }
  out += `\n`;

  out += `  ACTIONS (last hour)\n`;
  out += `  Total: ${d.recentActions.lastHour}\n`;
  if (d.recentActions.latest.length > 0) {
    for (const a of d.recentActions.latest) {
      const mark = a.success ? "[+]" : "[X]";
      out += `    ${mark} ${a.detail || a.type}\n`;
    }
  } else {
    out += `    No recent actions\n`;
  }
  out += `\n`;

  if (Object.keys(d.sharpeBaselines).length > 0) {
    out += `  SHARPE BASELINES\n`;
    for (const [key, val] of Object.entries(d.sharpeBaselines)) {
      out += `    ${key}: ${val.toFixed(4)}\n`;
    }
    out += `\n`;
  }

  out += `  Last check: ${d.lastCheck || "never"}\n`;
  out += `${"=".repeat(w)}\n`;

  return out;
}

// ─── writeHealthCheckFile() ─────────────────────────────
//
// Writes a JSON file for external monitoring tools to poll.
// The file includes current status, timestamps, and alert summary.

export function writeHealthCheckFile() {
  const dashboard = getHealthDashboard();

  const healthCheck = {
    status: dashboard.overallStatus,
    timestamp: dashboard.timestamp,
    lastCheck: dashboard.lastCheck,
    uptime_s: Math.round(process.uptime()),
    pid: process.pid,
    subsystems: {
      memory: {
        status: dashboard.subsystems.memory.severity,
        value: dashboard.subsystems.memory.value,
      },
      cpu: {
        status: dashboard.subsystems.cpu.severity,
        value: dashboard.subsystems.cpu.value,
      },
    },
    alerts: {
      active: dashboard.recentAlerts.lastHour,
      critical: dashboard.recentAlerts.critical,
      warn: dashboard.recentAlerts.warn,
    },
    actions: {
      recentCount: dashboard.recentActions.lastHour,
    },
  };

  try {
    writeFileSync(HEALTH_CHECK_FILE, JSON.stringify(healthCheck, null, 2));
  } catch (err) {
    logAction(`Failed to write health check file: ${err.message}`);
  }

  return healthCheck;
}

// ─── createNotifyFn() ───────────────────────────────────
//
// Factory that creates a notification function using the existing
// Telegram integration from notify.mjs patterns.

export function createNotifyFn(telegramToken, telegramChatId) {
  return async function notifyFn(message) {
    // Always log to file
    logAction(`NOTIFICATION: ${message}`);

    // Send via Telegram if configured
    if (telegramToken && telegramChatId) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: message,
            parse_mode: "HTML",
          }),
          signal: AbortSignal.timeout(10000),
        });
        return res.ok;
      } catch (err) {
        logAction(`Telegram notification failed: ${err.message}`);
        return false;
      }
    }

    return true; // logged successfully even without Telegram
  };
}
