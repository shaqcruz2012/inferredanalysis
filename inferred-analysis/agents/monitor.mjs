#!/usr/bin/env node
/**
 * Unified System Monitor — 3-Minute Interval
 *
 * Monitors all revenue-critical systems every 3 minutes:
 *   - Gateway health (x402 API)
 *   - Treasury & capital allocation state
 *   - Trading desk (fund bridge, positions, P&L)
 *   - Daemon heartbeat
 *   - Circuit breaker status
 *   - Revenue metrics
 *
 * Usage:
 *   node agents/monitor.mjs                    # Run once
 *   node agents/monitor.mjs --loop             # Run every 3 minutes (default)
 *   node agents/monitor.mjs --loop --interval 60  # Custom interval (seconds)
 *   node agents/monitor.mjs --json             # JSON output (single run)
 *   node agents/monitor.mjs --log              # Append to monitor.log
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "os";
import http from "http";

// ── Optional imports (degrade gracefully) ────────────────

let _getBridge = null;
try {
  const mod = await import("./shared/fund-bridge.mjs");
  _getBridge = mod.getBridge;
} catch { /* fund bridge not available */ }

let _getTracker = null;
try {
  const mod = await import("./shared/portfolio-tracker.mjs");
  _getTracker = mod.getTracker;
} catch { /* portfolio tracker not available */ }

let _getBreakerSummary = null;
try {
  const mod = await import("./risk/breaker-guard.mjs");
  _getBreakerSummary = mod.getBreakerSummary;
} catch { /* breaker guard not available */ }

let _collectSystemMetrics = null;
try {
  const mod = await import("./shared/health-actions.mjs");
  _collectSystemMetrics = mod.collectSystemMetrics;
} catch { /* health actions not available */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "agents", "outputs");
const STATE_DIR = join(ROOT, "agents", "state");
const MONITOR_LOG = join(LOG_DIR, "monitor.log");
const MONITOR_STATE = join(STATE_DIR, "monitor-state.json");
const PID_FILE = join(ROOT, ".daemon.pid");
const ALLOC_CONFIG = join(ROOT, "..", "config", "capital-allocation.json");
const BRIDGE_STATE = join(STATE_DIR, "fund-bridge-state.json");
const REVENUE_METRICS = join(STATE_DIR, "revenue-metrics.json");

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:7402";
const DEFAULT_INTERVAL_SEC = 180; // 3 minutes

// ─── CLI Args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    loop: args.includes("--loop"),
    json: args.includes("--json"),
    log: args.includes("--log"),
    interval: DEFAULT_INTERVAL_SEC,
  };
  const intIdx = args.indexOf("--interval");
  if (intIdx !== -1 && args[intIdx + 1]) {
    opts.interval = Math.max(10, parseInt(args[intIdx + 1]) || DEFAULT_INTERVAL_SEC);
  }
  return opts;
}

const OPTS = parseArgs();

// ─── HTTP Health Check ───────────────────────────────────

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ ok: true, status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ ok: true, status: res.statusCode, data: body });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

// ─── Data Collectors ─────────────────────────────────────

async function collectGatewayStatus() {
  const start = Date.now();
  const health = await httpGet(`${GATEWAY_URL}/health`);
  const latencyMs = Date.now() - start;

  if (!health.ok) {
    return { status: "DOWN", error: health.error, latencyMs };
  }

  // Also grab pricing info
  const info = await httpGet(`${GATEWAY_URL}/info`);
  return {
    status: "UP",
    latencyMs,
    gateway: health.data,
    endpoints: info.ok ? info.data?.endpoints?.length ?? 0 : "?",
  };
}

function collectDaemonStatus() {
  try {
    if (!existsSync(PID_FILE)) {
      return { status: "STOPPED", pid: null };
    }
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    // Check if process is running
    try {
      process.kill(pid, 0); // signal 0 = check existence
      return { status: "RUNNING", pid };
    } catch {
      return { status: "STALE_PID", pid };
    }
  } catch {
    return { status: "UNKNOWN" };
  }
}

function collectFundBridgeStatus() {
  // Read directly from state file for reliability
  try {
    if (existsSync(BRIDGE_STATE)) {
      const state = JSON.parse(readFileSync(BRIDGE_STATE, "utf-8"));
      const totalPnl = (state.cumulativeRealizedPnl || 0) + (state.cumulativeUnrealizedPnl || 0);
      const roi = state.allocatedCapitalUsd > 0
        ? ((totalPnl / state.allocatedCapitalUsd) * 100).toFixed(2)
        : "0.00";
      return {
        status: "ACTIVE",
        allocatedCapital: state.allocatedCapitalUsd || 0,
        realizedPnl: state.cumulativeRealizedPnl || 0,
        unrealizedPnl: state.cumulativeUnrealizedPnl || 0,
        totalPnl,
        roi: parseFloat(roi),
        maxDrawdownPct: ((state.maxDrawdownPct || 0) * 100).toFixed(2),
        totalTrades: state.totalTradesExecuted || 0,
        highWaterMark: state.highWaterMarkUsd || 0,
        lastSync: state.lastSyncTimestamp || "never",
      };
    }
    return { status: "NO_STATE" };
  } catch (err) {
    return { status: "ERROR", error: err.message };
  }
}

function collectAllocationConfig() {
  try {
    if (existsSync(ALLOC_CONFIG)) {
      const config = JSON.parse(readFileSync(ALLOC_CONFIG, "utf-8"));
      return {
        enabled: config.enabled,
        maxAllocationPct: config.max_trading_allocation_pct,
        maxAllocationUsd: config.max_trading_allocation_usd,
        minReserveUsd: config.min_treasury_reserve_usd,
        rebalanceHours: config.rebalance_interval_hours,
        drawdownClawbackPct: config.drawdown_clawback_pct,
      };
    }
    return { enabled: false };
  } catch {
    return { enabled: false, error: "config unreadable" };
  }
}

function collectPortfolioStatus() {
  if (!_getTracker) return { status: "UNAVAILABLE" };
  try {
    const tracker = _getTracker();
    const summary = tracker.getPortfolioSummary({});
    return {
      status: "ACTIVE",
      nav: summary.nav,
      cash: summary.cash,
      positions: summary.activePositionCount ?? 0,
      dailyPnl: summary.dailyPnl,
      dailyPnlPct: summary.dailyPnlPct,
      totalRealizedPnl: summary.totalRealizedPnl,
      totalTrades: summary.totalTrades,
      highWaterMark: summary.highWaterMark,
    };
  } catch (err) {
    return { status: "ERROR", error: err.message };
  }
}

function collectBreakerStatus() {
  if (!_getBreakerSummary) return { status: "UNAVAILABLE" };
  try {
    const summary = _getBreakerSummary();
    return {
      readable: summary.readable,
      portfolioHalted: summary.portfolioHalted,
      activeBreakerCount: summary.activeBreakerCount,
      lastUpdated: summary.lastUpdated,
    };
  } catch (err) {
    return { status: "ERROR", error: err.message };
  }
}

function collectRevenueMetrics() {
  try {
    if (existsSync(REVENUE_METRICS)) {
      const metrics = JSON.parse(readFileSync(REVENUE_METRICS, "utf-8"));
      return {
        status: "ACTIVE",
        todayRevenue: metrics.today?.revenue ?? 0,
        todayExpenses: metrics.today?.expenses ?? 0,
        todayNet: (metrics.today?.revenue ?? 0) - (metrics.today?.expenses ?? 0),
        totalRevenue: metrics.lifetime?.revenue ?? metrics.total?.revenue ?? 0,
        customersToday: metrics.today?.uniqueCustomers ?? 0,
      };
    }
    return { status: "NO_DATA" };
  } catch {
    return { status: "ERROR" };
  }
}

function collectSystemResources() {
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPct = ((1 - freeMem / totalMem) * 100).toFixed(1);
  return {
    cpuLoad1m: loadAvg[0].toFixed(2),
    cpuLoad5m: loadAvg[1].toFixed(2),
    memUsedPct: parseFloat(memUsedPct),
    memFreeMb: Math.round(freeMem / 1024 / 1024),
    uptime: Math.round(os.uptime()),
  };
}

// ─── Main Collection ─────────────────────────────────────

async function collectAll() {
  const timestamp = new Date().toISOString();
  const [gateway] = await Promise.all([collectGatewayStatus()]);

  return {
    timestamp,
    gateway,
    daemon: collectDaemonStatus(),
    allocation: collectAllocationConfig(),
    fundBridge: collectFundBridgeStatus(),
    portfolio: collectPortfolioStatus(),
    breakers: collectBreakerStatus(),
    revenue: collectRevenueMetrics(),
    system: collectSystemResources(),
  };
}

// ─── ANSI Formatting ─────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

function statusColor(status) {
  if (["UP", "RUNNING", "ACTIVE"].includes(status)) return C.green;
  if (["DOWN", "STOPPED", "ERROR"].includes(status)) return C.red;
  return C.yellow;
}

function pnlColor(val) {
  return val > 0 ? C.green : val < 0 ? C.red : C.dim;
}

function formatUsd(val) {
  const sign = val >= 0 ? "+" : "";
  return `$${sign}${val.toFixed(2)}`;
}

function renderDashboard(data) {
  const lines = [];
  const w = 60;
  const bar = "═".repeat(w);
  const thinBar = "─".repeat(w);

  lines.push("");
  lines.push(`${C.bold}${C.cyan}╔${bar}╗${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║  DATCHI UNIFIED MONITOR${" ".repeat(w - 24)}║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║  ${C.dim}${data.timestamp}${" ".repeat(w - 2 - data.timestamp.length)}${C.cyan}║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}╠${bar}╣${C.reset}`);

  // Gateway
  const gw = data.gateway;
  const gwStatus = `${statusColor(gw.status)}${gw.status}${C.reset}`;
  lines.push(`${C.bold}  GATEWAY (x402)${C.reset}`);
  lines.push(`    Status:     ${gwStatus}${gw.latencyMs ? `  (${gw.latencyMs}ms)` : ""}`);
  if (gw.status === "UP") {
    lines.push(`    Endpoints:  ${gw.endpoints} paid routes`);
  } else if (gw.error) {
    lines.push(`    Error:      ${C.red}${gw.error}${C.reset}`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Daemon
  const dm = data.daemon;
  const dmStatus = `${statusColor(dm.status)}${dm.status}${C.reset}`;
  lines.push(`${C.bold}  DAEMON${C.reset}`);
  lines.push(`    Status:     ${dmStatus}${dm.pid ? `  (PID ${dm.pid})` : ""}`);

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Capital Allocation
  const alloc = data.allocation;
  lines.push(`${C.bold}  CAPITAL ALLOCATION${C.reset}`);
  lines.push(`    Enabled:    ${alloc.enabled ? `${C.green}YES${C.reset}` : `${C.red}NO${C.reset}`}`);
  if (alloc.enabled) {
    lines.push(`    Max Alloc:  ${(alloc.maxAllocationPct * 100).toFixed(0)}% / $${alloc.maxAllocationUsd.toLocaleString()}`);
    lines.push(`    Reserve:    $${alloc.minReserveUsd.toFixed(2)} min`);
    lines.push(`    Rebalance:  every ${alloc.rebalanceHours}h`);
    lines.push(`    Clawback:   at ${(alloc.drawdownClawbackPct * 100).toFixed(0)}% drawdown`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Fund Bridge (Trading Desk)
  const fb = data.fundBridge;
  lines.push(`${C.bold}  TRADING DESK (Fund Bridge)${C.reset}`);
  if (fb.status === "ACTIVE") {
    lines.push(`    Capital:    ${C.bold}$${fb.allocatedCapital.toFixed(2)}${C.reset}`);
    lines.push(`    Realized:   ${pnlColor(fb.realizedPnl)}${formatUsd(fb.realizedPnl)}${C.reset}`);
    lines.push(`    Unrealized: ${pnlColor(fb.unrealizedPnl)}${formatUsd(fb.unrealizedPnl)}${C.reset}`);
    lines.push(`    Total P&L:  ${pnlColor(fb.totalPnl)}${C.bold}${formatUsd(fb.totalPnl)}${C.reset}  (ROI: ${fb.roi}%)`);
    lines.push(`    Drawdown:   ${parseFloat(fb.maxDrawdownPct) > 5 ? C.yellow : C.green}${fb.maxDrawdownPct}%${C.reset}  |  Trades: ${fb.totalTrades}`);
    lines.push(`    HWM:        $${fb.highWaterMark.toFixed(2)}`);
    lines.push(`    Last Sync:  ${C.dim}${fb.lastSync}${C.reset}`);
  } else {
    lines.push(`    Status:     ${C.yellow}${fb.status}${C.reset}`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Portfolio
  const pf = data.portfolio;
  lines.push(`${C.bold}  PORTFOLIO${C.reset}`);
  if (pf.status === "ACTIVE") {
    lines.push(`    NAV:        $${pf.nav?.toFixed(2) ?? "?"}`);
    lines.push(`    Cash:       $${pf.cash?.toFixed(2) ?? "?"}`);
    lines.push(`    Positions:  ${pf.positions}`);
    if (pf.dailyPnl !== undefined) {
      lines.push(`    Daily P&L:  ${pnlColor(pf.dailyPnl)}${formatUsd(pf.dailyPnl)}${C.reset} (${pf.dailyPnlPct?.toFixed(2) ?? "?"}%)`);
    }
  } else {
    lines.push(`    Status:     ${C.dim}${pf.status}${C.reset}`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Circuit Breakers
  const br = data.breakers;
  lines.push(`${C.bold}  CIRCUIT BREAKERS${C.reset}`);
  if (br.status === "UNAVAILABLE") {
    lines.push(`    Status:     ${C.dim}not configured${C.reset}`);
  } else if (br.readable === false) {
    lines.push(`    Status:     ${C.bgRed}${C.white} UNREADABLE (FAIL-CLOSED) ${C.reset}`);
  } else {
    const haltStatus = br.portfolioHalted
      ? `${C.bgRed}${C.white} HALTED ${C.reset}`
      : `${C.green}CLEAR${C.reset}`;
    lines.push(`    Portfolio:  ${haltStatus}`);
    lines.push(`    Active:     ${br.activeBreakerCount} breaker(s)`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // Revenue
  const rev = data.revenue;
  lines.push(`${C.bold}  REVENUE${C.reset}`);
  if (rev.status === "ACTIVE") {
    lines.push(`    Today:      ${pnlColor(rev.todayRevenue)}$${rev.todayRevenue.toFixed(2)}${C.reset} revenue  |  $${rev.todayExpenses.toFixed(2)} expenses`);
    lines.push(`    Net:        ${pnlColor(rev.todayNet)}${formatUsd(rev.todayNet)}${C.reset}`);
    lines.push(`    Customers:  ${rev.customersToday} today`);
    lines.push(`    Lifetime:   $${rev.totalRevenue.toFixed(2)}`);
  } else {
    lines.push(`    Status:     ${C.dim}${rev.status}${C.reset}`);
  }

  lines.push(`${C.dim}  ${thinBar}${C.reset}`);

  // System
  const sys = data.system;
  const memColor = sys.memUsedPct > 90 ? C.red : sys.memUsedPct > 75 ? C.yellow : C.green;
  lines.push(`${C.bold}  SYSTEM${C.reset}`);
  lines.push(`    CPU Load:   ${sys.cpuLoad1m} (1m) / ${sys.cpuLoad5m} (5m)`);
  lines.push(`    Memory:     ${memColor}${sys.memUsedPct}%${C.reset} used  (${sys.memFreeMb} MB free)`);
  lines.push(`    Uptime:     ${Math.floor(sys.uptime / 3600)}h ${Math.floor((sys.uptime % 3600) / 60)}m`);

  lines.push(`${C.bold}${C.cyan}╚${bar}╝${C.reset}`);
  lines.push("");

  return lines.join("\n");
}

// ─── State Persistence ───────────────────────────────────

function saveMonitorState(data) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MONITOR_STATE, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

function appendLog(data) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${data.timestamp}] GW=${data.gateway.status} DAEMON=${data.daemon.status} CAPITAL=$${data.fundBridge.allocatedCapital ?? 0} PNL=$${data.fundBridge.totalPnl?.toFixed(2) ?? "0"} CPU=${data.system.cpuLoad1m} MEM=${data.system.memUsedPct}%\n`;
    appendFileSync(MONITOR_LOG, line);
  } catch { /* best effort */ }
}

// ─── Main Loop ───────────────────────────────────────────

async function runOnce() {
  const data = await collectAll();

  if (OPTS.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    // Clear screen for dashboard feel
    if (OPTS.loop) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    console.log(renderDashboard(data));
  }

  saveMonitorState(data);

  if (OPTS.log) {
    appendLog(data);
  }

  return data;
}

async function main() {
  console.log(`[monitor] Starting unified monitor (interval: ${OPTS.interval}s)`);

  await runOnce();

  if (OPTS.loop) {
    const intervalMs = OPTS.interval * 1000;
    const timer = setInterval(async () => {
      try {
        await runOnce();
      } catch (err) {
        console.error(`[monitor] Error in cycle: ${err.message}`);
      }
    }, intervalMs);

    // Graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n[monitor] Shutting down...");
      clearInterval(timer);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(`[monitor] Fatal: ${err.message}`);
  process.exit(1);
});
