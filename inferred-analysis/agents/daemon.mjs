#!/usr/bin/env node
/**
 * Inferred Analysis Research Daemon
 *
 * Runs the autoresearch loop on a 15-minute cycle for all research agents.
 * Each cycle: picks an agent → runs N experiments → logs results → sleeps.
 *
 * This is the 24/7 process that keeps the quant fund's AI lab running.
 *
 * Usage:
 *   node agents/daemon.mjs                           # Run forever (default)
 *   node agents/daemon.mjs --interval 900            # 15 min cycle (default)
 *   node agents/daemon.mjs --iterations 5            # 5 experiments per cycle
 *   node agents/daemon.mjs --once                    # Run one cycle then exit
 *   node agents/daemon.mjs --paperclip-url http://localhost:3100
 *
 * Environment:
 *   PAPERCLIP_URL=http://localhost:3100
 *   DAEMON_INTERVAL=900
 *   DAEMON_ITERATIONS=5
 */

import { execSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { atomicAppendFile, atomicWriteFile } from "./shared/atomic-writer.mjs";
import { isTradingHalted, isPortfolioHalted, getBreakerSummary, formatBreakerBlock } from "./risk/breaker-guard.mjs";
import {
  evaluateAndAct,
  collectSystemMetrics,
  writeHealthCheckFile,
  createNotifyFn,
} from "./shared/health-actions.mjs";
import {
  saveCheckpoint,
  loadCheckpoint,
  markAgentStarted,
  markAgentCompleted,
  detectStaleAgents,
  getRunningAgentsSnapshot,
  recordFailure,
  isQuarantined,
  clearFailures,
  shouldScaleDown,
  generateIncidentReport,
  getSystemReport,
} from "./shared/self-healer.mjs";
import { reconcile, autoResolve, getReconciliationReport, isDriftSignificant } from "./trading/reconciler.mjs";
import { getTracker } from "./shared/portfolio-tracker.mjs";
import { getBridge } from "./shared/fund-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "agents", "outputs");
const PID_FILE = join(ROOT, ".daemon.pid");
const DAEMON_LOG = join(LOG_DIR, "daemon.log");

// ─── Config ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    interval: parseInt(process.env.DAEMON_INTERVAL || "900"),
    iterations: parseInt(process.env.DAEMON_ITERATIONS || "5"),
    paperclipUrl: process.env.PAPERCLIP_URL || "http://localhost:3100",
    once: false,
    stop: false,
    status: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval") opts.interval = parseInt(args[++i]);
    if (args[i] === "--iterations") opts.iterations = parseInt(args[++i]);
    if (args[i] === "--paperclip-url") opts.paperclipUrl = args[++i];
    if (args[i] === "--once") opts.once = true;
    if (args[i] === "stop") opts.stop = true;
    if (args[i] === "status") opts.status = true;
  }
  return opts;
}

// ─── Research Agents (rotate through these) ─────────────

const RESEARCH_AGENTS = [
  "alpha_researcher",
  "stat_arb_quant",
  "macro_quant",
  "vol_quant",
  "hf_quant",
  "microstructure_researcher",
  "econ_researcher",
];

// ─── Logging ─────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    atomicAppendFile(DAEMON_LOG, line);
  } catch { /* best effort */ }
}

// ─── PID Management ─────────────────────────────────────

function writePid() {
  atomicWriteFile(PID_FILE, String(process.pid));
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim());
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ─── Run Agent Experiment Cycle ─────────────────────────

function runAgentCycle(agent, iterations, paperclipUrl) {
  log(`Starting cycle: ${agent} (${iterations} iterations)`);
  try {
    const output = execSync(
      `node "${join(__dirname, "agent-runner.mjs")}" --agent ${agent} --iterations ${iterations} --paperclip-url ${paperclipUrl}`,
      {
        cwd: ROOT,
        timeout: 300_000, // 5 min max per cycle
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Extract summary from output
    const sharpeMatch = output.match(/Best Sharpe:\s+([-\d.]+)/);
    const keptMatch = output.match(/Kept:\s+(\d+)/);
    const discardedMatch = output.match(/Discarded:\s+(\d+)/);

    const sharpe = sharpeMatch ? sharpeMatch[1] : "?";
    const kept = keptMatch ? keptMatch[1] : "?";
    const discarded = discardedMatch ? discardedMatch[1] : "?";

    log(`Completed: ${agent} — Sharpe: ${sharpe}, Kept: ${kept}, Discarded: ${discarded}`);
    return { ok: true, sharpe, kept, discarded };
  } catch (err) {
    log(`ERROR: ${agent} — ${err.message?.slice(0, 200)}`);
    return { ok: false, error: err.message };
  }
}

// ─── Paperclip Health Check ─────────────────────────────

async function checkPaperclip(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Position Reconciliation ─────────────────────────────

async function fetchBrokerPositions() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return null; // No credentials — skip

  const base = process.env.ALPACA_PAPER !== "false"
    ? "https://paper-api.alpaca.markets"
    : "https://api.alpaca.markets";

  const res = await fetch(`${base}/v2/positions`, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Alpaca GET /v2/positions → ${res.status}`);
  }
  return res.json();
}

async function runReconciliation() {
  const brokerPositions = await fetchBrokerPositions();
  if (brokerPositions === null) {
    // No Alpaca credentials — reconciliation not possible
    return;
  }

  const tracker = getTracker();
  const trackerPositions = tracker.getPositions();

  const result = reconcile(trackerPositions, brokerPositions);

  if (result.clean) {
    log(`Reconciliation: CLEAN — ${result.matched.length} positions match`);
    return;
  }

  log(`Reconciliation: DRIFT detected — $${result.totalDrift.toFixed(2)} (${(result.driftPct * 100).toFixed(2)}%)`);
  log(`  Matched: ${result.matched.length} | Mismatched: ${result.mismatched.length} | Tracker-only: ${result.trackerOnly.length} | Broker-only: ${result.brokerOnly.length}`);

  // Auto-resolve using broker-wins (safest default)
  const resolution = autoResolve(result, "broker-wins", tracker);
  log(`  Resolved: ${resolution.actionCount} actions applied (strategy: broker-wins)`);

  // Alert on significant drift (>5% of portfolio value)
  if (result.driftPct > 0.05) {
    log(`  *** SIGNIFICANT DRIFT ALERT: ${(result.driftPct * 100).toFixed(2)}% of portfolio ***`);
    const report = getReconciliationReport();
    log(report);

    // Attempt Telegram notification for significant drift
    try {
      const notifyFn = createNotifyFn(
        process.env.TELEGRAM_BOT_TOKEN || "",
        process.env.TELEGRAM_CHAT_ID || "",
      );
      await notifyFn(`POSITION DRIFT ALERT: $${result.totalDrift.toFixed(2)} (${(result.driftPct * 100).toFixed(2)}% of portfolio). Auto-resolved with broker-wins strategy.`);
    } catch { /* best effort */ }
  }
}

// ─── Main Daemon Loop ───────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Handle stop command
  if (opts.stop) {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped daemon (PID ${pid})`);
    } else {
      console.log("No daemon running");
    }
    return;
  }

  // Handle status command
  if (opts.status) {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      console.log(`Daemon running (PID ${pid})`);
      // Show last 10 log lines
      try {
        const logContent = readFileSync(DAEMON_LOG, "utf-8");
        const lines = logContent.trim().split("\n");
        console.log(`\nLast 10 log entries:`);
        for (const line of lines.slice(-10)) {
          console.log(`  ${line}`);
        }
      } catch { /* no log yet */ }
    } else {
      console.log("Daemon not running");
    }

    // Show results summary
    const resultsPath = join(ROOT, "agents", "results.tsv");
    if (existsSync(resultsPath)) {
      const results = readFileSync(resultsPath, "utf-8").trim().split("\n");
      console.log(`\nExperiment log: ${results.length - 1} experiments`);
      const keeps = results.filter(l => l.includes("\tkeep")).length;
      const discards = results.filter(l => l.includes("\tdiscard")).length;
      const crashes = results.filter(l => l.includes("\tcrash")).length;
      console.log(`  Kept: ${keeps} | Discarded: ${discards} | Crashed: ${crashes}`);
    }
    return;
  }

  // Check for existing daemon
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`Daemon already running (PID ${existingPid}). Use 'node agents/daemon.mjs stop' first.`);
    process.exit(1);
  }

  // Write PID
  writePid();

  // Graceful shutdown — save checkpoint before exiting
  const gracefulShutdown = (signal) => {
    log(`Received ${signal} — saving checkpoint and shutting down`);
    try {
      saveCheckpoint({
        cycleCount,
        lastAgent: null,
        opts: { interval: opts.interval, iterations: opts.iterations },
        runningAgents: getRunningAgentsSnapshot(),
        shutdownReason: signal,
      });
    } catch (e) {
      log(`Warning: checkpoint save failed on shutdown: ${e.message}`);
    }
    cleanPid();
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // ─── Crash recovery: restore from checkpoint ───────────
  let cycleCount = 0;
  const checkpoint = loadCheckpoint();
  if (checkpoint) {
    log("═══════════════════════════════════════════════════");
    log("RECOVERY: Found checkpoint from previous run");
    log(`  Previous cycle: ${checkpoint.cycleCount ?? "?"}`);
    log(`  Saved at: ${checkpoint.savedAt ?? "?"}`);
    log(`  Shutdown reason: ${checkpoint.shutdownReason ?? "unknown"}`);

    // Resume from where we left off
    cycleCount = checkpoint.cycleCount ?? 0;
    log(`  Resuming from cycle ${cycleCount + 1}`);

    // Detect stale agents from previous run
    const staleAgents = detectStaleAgents(300_000);
    if (staleAgents.length > 0) {
      log(`  Stale agents detected: ${staleAgents.length}`);
      for (const stale of staleAgents) {
        const staleMins = Math.round(stale.staleDurationMs / 60_000);
        log(`    ${stale.agentName}: started ${staleMins} min ago, never completed`);
        const failResult = recordFailure(stale.agentName);
        if (failResult.quarantined) {
          log(`    -> Quarantined after ${failResult.retryCount} failures`);
        } else {
          log(`    -> Failure ${failResult.retryCount}/${3} recorded, will retry`);
        }
        generateIncidentReport({
          type: "recovery",
          agent: stale.agentName,
          reason: `Stale agent detected on startup (was running ${staleMins} min)`,
          timestamp: new Date().toISOString(),
        });
      }
    }
    log("═══════════════════════════════════════════════════");
  }

  log("═══════════════════════════════════════════════════");
  log("Inferred Analysis Research Daemon started");
  log(`  Interval: ${opts.interval}s (${(opts.interval / 60).toFixed(0)} min)`);
  log(`  Iterations per agent: ${opts.iterations}`);
  log(`  Agents: ${RESEARCH_AGENTS.length}`);
  log(`  Paperclip: ${opts.paperclipUrl}`);
  log(`  PID: ${process.pid}`);
  log(`  Mode: ${opts.once ? "single run" : "continuous"}`);
  if (checkpoint) {
    log(`  Recovered: yes (from cycle ${checkpoint.cycleCount ?? 0})`);
  }

  // Report circuit breaker status at startup
  const breakerStatus = getBreakerSummary();
  if (!breakerStatus.readable) {
    log("  Circuit breakers: STATE FILE NOT READABLE — trading will be halted by default");
  } else if (breakerStatus.activeBreakerCount > 0) {
    log(`  Circuit breakers: ${breakerStatus.activeBreakerCount} active`);
    for (const [key, b] of Object.entries(breakerStatus.breakers)) {
      log(`    [${b.level?.toUpperCase() || "?"}] ${key}: ${b.reason} (scale: ${((b.currentScale || 0) * 100).toFixed(0)}%)`);
    }
  } else {
    log("  Circuit breakers: all clear");
  }

  // Report self-healer status at startup
  const sysReport = getSystemReport();
  log(`  Self-healer: ${sysReport.status} | quarantined: ${sysReport.activeQuarantines.length} | incidents (24h): ${sysReport.recentIncidents} | strategies tracked: ${sysReport.strategiesTracked}`);

  log("═══════════════════════════════════════════════════");

  while (true) {
    cycleCount++;
    const cycleStart = Date.now();
    log(`\n─── Cycle ${cycleCount} ───`);

    // ─── System pressure check ─────────────────────────────
    const pressure = shouldScaleDown();
    let effectiveIterations = opts.iterations;
    if (pressure.underPressure) {
      effectiveIterations = Math.max(1, Math.floor(opts.iterations / 2));
      log(`PRESSURE: System under memory pressure (heap ${pressure.heapRatio}%) — reducing iterations to ${effectiveIterations}`);
      generateIncidentReport({
        type: "pressure",
        reason: `Heap at ${pressure.heapRatio}%, reduced iterations from ${opts.iterations} to ${effectiveIterations}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Check Paperclip
    const paperclipUp = await checkPaperclip(opts.paperclipUrl);
    if (paperclipUp) {
      log("Paperclip: connected");
    } else {
      log("Paperclip: not reachable (running standalone)");
    }

    // Circuit breaker check — halt entire daemon cycle if portfolio breaker is active
    const portfolioCheck = isPortfolioHalted();
    if (portfolioCheck.halted) {
      log(formatBreakerBlock("daemon cycle", portfolioCheck));
      log(`CIRCUIT BREAKER: Portfolio halted — skipping all agent cycles`);
      log(`Reason: ${portfolioCheck.reason}`);
      saveCheckpoint({
        cycleCount,
        lastAgent: null,
        opts: { interval: opts.interval, iterations: opts.iterations },
        runningAgents: getRunningAgentsSnapshot(),
        shutdownReason: "portfolio_halted",
      });
      if (opts.once) {
        log("Single-run mode — exiting (portfolio halted)");
        break;
      }
      const elapsed = (Date.now() - cycleStart) / 1000;
      const sleepTime = Math.max(10, opts.interval - elapsed);
      log(`Sleeping ${sleepTime.toFixed(0)}s until next cycle (portfolio halted)...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
      continue;
    }

    // ─── Position reconciliation ─────────────────────────
    try {
      await runReconciliation();
    } catch (reconErr) {
      log(`Reconciliation error (non-fatal): ${reconErr.message}`);
    }

    // ─── Fund Bridge: Report P&L & log allocation status ──
    try {
      const bridge = getBridge();
      if (bridge.isCapitalAvailable()) {
        // Sync P&L from portfolio tracker to fund bridge state
        const pnlSync = bridge.syncFromTracker({});
        log(`Fund Bridge: allocated=$${bridge.getAllocatedCapital().toFixed(2)} P&L=$${pnlSync.totalPnl.toFixed(2)} ROI=${pnlSync.capitalReturn.toFixed(2)}% drawdown=${(pnlSync.drawdownPct * 100).toFixed(2)}%`);

        if (bridge.isDrawdownBreached()) {
          log(`FUND BRIDGE WARNING: Drawdown limit breached (${(pnlSync.drawdownPct * 100).toFixed(2)}%) — allocator should clawback`);
        }
      } else {
        // Log once per full rotation that fund bridge is inactive
        if (cycleCount % RESEARCH_AGENTS.length === 1) {
          log("Fund Bridge: inactive (no capital allocated — configure config/capital-allocation.json)");
        }
      }
    } catch (bridgeErr) {
      log(`Fund Bridge error (non-fatal): ${bridgeErr.message}`);
    }

    // Rotate through agents — run one per cycle to spread work
    const agentIndex = (cycleCount - 1) % RESEARCH_AGENTS.length;
    const agent = RESEARCH_AGENTS[agentIndex];

    // ─── Quarantine check ──────────────────────────────────
    if (isQuarantined(agent)) {
      log(`QUARANTINE: Agent ${agent} is quarantined — skipping`);
      saveCheckpoint({
        cycleCount,
        lastAgent: agent,
        opts: { interval: opts.interval, iterations: opts.iterations },
        runningAgents: getRunningAgentsSnapshot(),
        shutdownReason: null,
      });
      if (opts.once) {
        log("Single-run mode — exiting (agent quarantined)");
        break;
      }
      const elapsed = (Date.now() - cycleStart) / 1000;
      const sleepTime = Math.max(10, opts.interval - elapsed);
      log(`Sleeping ${sleepTime.toFixed(0)}s until next cycle...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
      continue;
    }

    // Circuit breaker check — skip this agent if its breaker is tripped
    const agentBreaker = isTradingHalted(agent);
    if (agentBreaker.halted) {
      log(formatBreakerBlock(`daemon agent ${agent}`, agentBreaker));
      log(`CIRCUIT BREAKER: Agent ${agent} halted — skipping to next cycle`);
      log(`Reason: ${agentBreaker.reason}`);
    } else {
      if (agentBreaker.positionScale < 1.0) {
        log(`Circuit breaker: Agent ${agent} in recovery mode (scale: ${(agentBreaker.positionScale * 100).toFixed(0)}%)`);
      }

      // ─── Run agent with crash tracking ───────────────────
      markAgentStarted(agent, Date.now());
      const result = runAgentCycle(agent, effectiveIterations, opts.paperclipUrl);
      markAgentCompleted(agent, result);

      if (result.ok) {
        clearFailures(agent);
      } else {
        const failResult = recordFailure(agent);
        if (failResult.quarantined) {
          log(`QUARANTINE: Agent ${agent} quarantined after ${failResult.retryCount} consecutive failures`);
        } else {
          log(`FAILURE: Agent ${agent} failure ${failResult.retryCount}/3 — will retry next rotation`);
        }
        generateIncidentReport({
          type: "agent_crash",
          agent,
          reason: result.error?.slice(0, 300) ?? "unknown error",
          retryCount: failResult.retryCount,
          quarantined: failResult.quarantined,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ─── Save checkpoint after agent run ───────────────────
    saveCheckpoint({
      cycleCount,
      lastAgent: agent,
      opts: { interval: opts.interval, iterations: opts.iterations },
      runningAgents: getRunningAgentsSnapshot(),
      shutdownReason: null,
    });

    // ─── Health evaluation ─────────────────────────────────
    try {
      const healthMetrics = collectSystemMetrics();
      const notifyFn = createNotifyFn(
        process.env.TELEGRAM_BOT_TOKEN || "",
        process.env.TELEGRAM_CHAT_ID || "",
      );
      const healthResult = await evaluateAndAct(healthMetrics, { notifyFn });
      if (healthResult.alerts.length > 0) {
        log(`Health alerts: ${healthResult.alerts.length} (${healthResult.overallSeverity})`);
        for (const alert of healthResult.alerts) {
          log(`  [${alert.severity.toUpperCase()}] ${alert.message}`);
        }
        if (healthResult.actions.length > 0) {
          log(`Health actions taken: ${healthResult.actions.length}`);
          for (const action of healthResult.actions) {
            log(`  [${action.success ? "OK" : "FAIL"}] ${action.detail}`);
          }
        }
      }
      // Write health check file for external monitoring
      writeHealthCheckFile();
    } catch (healthErr) {
      log(`Health evaluation error: ${healthErr.message}`);
    }

    // Send notification report every full rotation (after all 7 agents have run)
    if (cycleCount % RESEARCH_AGENTS.length === 0) {
      log("Full rotation complete — sending status report");

      // Log fund bridge summary at each full rotation
      try {
        const bridgeReport = getBridge();
        log(bridgeReport.getStatusReport());
      } catch { /* fund bridge not critical */ }

      // Log self-healer summary at each full rotation
      const rotationReport = getSystemReport();
      log(`Self-healer: ${rotationReport.status} | quarantined: ${rotationReport.activeQuarantines.length} | strategies: ${rotationReport.strategiesTracked}`);
      if (rotationReport.activeQuarantines.length > 0) {
        for (const q of rotationReport.activeQuarantines) {
          log(`  Quarantined: ${q.agent} until ${q.until} (${q.totalQuarantines} total quarantines)`);
        }
      }

      try {
        execSync(`node "${join(__dirname, "notify.mjs")}" --telegram`, {
          cwd: ROOT,
          timeout: 30_000,
          encoding: "utf-8",
          env: { ...process.env },
        });
        log("Status report sent");
      } catch {
        log("Status report: Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)");
      }
    }

    if (opts.once) {
      log("Single-run mode — exiting");
      saveCheckpoint({
        cycleCount,
        lastAgent: agent,
        opts: { interval: opts.interval, iterations: opts.iterations },
        runningAgents: getRunningAgentsSnapshot(),
        shutdownReason: "single_run_complete",
      });
      break;
    }

    // Calculate sleep time (increase if under pressure)
    const elapsed = (Date.now() - cycleStart) / 1000;
    const baseSleep = Math.max(10, opts.interval - elapsed);
    const sleepTime = pressure.underPressure ? baseSleep * 1.5 : baseSleep;
    log(`Sleeping ${sleepTime.toFixed(0)}s until next cycle...`);

    await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
