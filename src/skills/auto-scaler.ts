/**
 * Auto-Scaler Skill
 *
 * Tracks request volume per service over time windows, detects traffic
 * spikes, and recommends scaling actions. All data is persisted in SQLite
 * for durability across restarts.
 *
 * Revenue nexus: keeps revenue-generating APIs alive under load and
 * reduces compute waste during low-traffic periods.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skills.auto-scaler");

// ─── Types ──────────────────────────────────────────────────────

export interface TrafficStats {
  rpm: number;
  rps: number;
  avgLatency: number;
  p99Latency: number;
  errorRate: number;
  totalRequests: number;
}

export interface Anomaly {
  type: "spike" | "error_surge" | "latency_degradation";
  service: string;
  message: string;
  severity: "warning" | "critical";
  detectedAt: string;
  currentValue: number;
  baselineValue: number;
}

export type ScalingAction = "scale-up" | "scale-down" | "none";

export interface ScalingRecommendation {
  action: ScalingAction;
  reason: string;
  service: string;
  timestamp: string;
}

export interface ResourceUtilization {
  service: string;
  estimatedCpuPercent: number;
  estimatedMemoryPercent: number;
  activeConnections: number;
  timestamp: string;
}

// ─── Configuration ──────────────────────────────────────────────

/** Spike detection: current RPM must exceed baseline by this factor */
const SPIKE_THRESHOLD = 2.0;

/** Error rate threshold for anomaly detection (fraction 0-1) */
const ERROR_RATE_THRESHOLD = 0.1;

/** Latency degradation threshold: p99 exceeds baseline by this factor */
const LATENCY_DEGRADATION_FACTOR = 3.0;

/** Baseline window in minutes for computing "normal" traffic */
const BASELINE_WINDOW_MINUTES = 60;

/** Short window for detecting spikes (minutes) */
const SPIKE_WINDOW_MINUTES = 5;

/** Scale-down threshold: RPM below this fraction of baseline */
const SCALE_DOWN_THRESHOLD = 0.25;

/** Max age for request records before pruning (ms) — 24 hours */
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Schema ─────────────────────────────────────────────────────

const CREATE_SCALER_TABLES = `
  CREATE TABLE IF NOT EXISTS scaler_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    latency_ms REAL NOT NULL,
    status_code INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scaler_requests_service_ts
    ON scaler_requests (service, timestamp_ms);

  CREATE TABLE IF NOT EXISTS scaler_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    current_value REAL NOT NULL,
    baseline_value REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scaler_anomalies_service
    ON scaler_anomalies (service, detected_at);

  CREATE TABLE IF NOT EXISTS scaler_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
`;

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the auto-scaler schema. Safe to call multiple times
 * (uses IF NOT EXISTS).
 */
export function initAutoScalerSchema(db: Database): void {
  db.exec(CREATE_SCALER_TABLES);
  logger.info("Auto-scaler schema initialized");
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Record an incoming request for a service.
 * This is the primary data-collection entry point — call it on
 * every API request that the gateway serves.
 */
export function recordRequest(
  db: Database,
  service: string,
  latencyMs: number,
  statusCode: number,
): void {
  const stmt = db.prepare(
    "INSERT INTO scaler_requests (service, timestamp_ms, latency_ms, status_code) VALUES (?, ?, ?, ?)",
  );
  stmt.run(service, Date.now(), latencyMs, statusCode);
}

/**
 * Get traffic statistics for a service over a given time window.
 */
export function getTrafficStats(
  db: Database,
  service: string,
  windowMinutes: number,
): TrafficStats {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  const row = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         AVG(latency_ms) as avg_latency,
         SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors
       FROM scaler_requests
       WHERE service = ? AND timestamp_ms >= ?`,
    )
    .get(service, cutoff) as {
    total: number;
    avg_latency: number | null;
    errors: number;
  } | undefined;

  const total = row?.total ?? 0;
  const avgLatency = row?.avg_latency ?? 0;
  const errors = row?.errors ?? 0;

  // Compute p99 latency
  const p99Row = db
    .prepare(
      `SELECT latency_ms FROM scaler_requests
       WHERE service = ? AND timestamp_ms >= ?
       ORDER BY latency_ms DESC
       LIMIT 1 OFFSET MAX(0, CAST(? * 0.01 AS INTEGER))`,
    )
    .get(service, cutoff, total) as { latency_ms: number } | undefined;

  const p99Latency = p99Row?.latency_ms ?? avgLatency;

  const windowSeconds = windowMinutes * 60;
  const rpm = windowMinutes > 0 ? total / windowMinutes : 0;
  const rps = windowSeconds > 0 ? total / windowSeconds : 0;
  const errorRate = total > 0 ? errors / total : 0;

  return {
    rpm,
    rps,
    avgLatency,
    p99Latency,
    errorRate,
    totalRequests: total,
  };
}

/**
 * Detect anomalies for a given service by comparing recent traffic
 * against the baseline window.
 */
export function detectAnomalies(
  db: Database,
  service: string,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = new Date().toISOString();

  const baseline = getTrafficStats(db, service, BASELINE_WINDOW_MINUTES);
  const recent = getTrafficStats(db, service, SPIKE_WINDOW_MINUTES);

  // Skip anomaly detection if there is no baseline
  if (baseline.totalRequests === 0) {
    return anomalies;
  }

  // 1. Traffic spike detection
  if (baseline.rpm > 0 && recent.rpm > baseline.rpm * SPIKE_THRESHOLD) {
    const anomaly: Anomaly = {
      type: "spike",
      service,
      message: `Traffic spike detected: ${recent.rpm.toFixed(1)} RPM vs baseline ${baseline.rpm.toFixed(1)} RPM (${(recent.rpm / baseline.rpm).toFixed(1)}x)`,
      severity: recent.rpm > baseline.rpm * SPIKE_THRESHOLD * 2 ? "critical" : "warning",
      detectedAt: now,
      currentValue: recent.rpm,
      baselineValue: baseline.rpm,
    };
    anomalies.push(anomaly);
  }

  // 2. Error surge detection
  if (recent.errorRate > ERROR_RATE_THRESHOLD) {
    const anomaly: Anomaly = {
      type: "error_surge",
      service,
      message: `Error rate surge: ${(recent.errorRate * 100).toFixed(1)}% (threshold: ${(ERROR_RATE_THRESHOLD * 100).toFixed(1)}%)`,
      severity: recent.errorRate > 0.3 ? "critical" : "warning",
      detectedAt: now,
      currentValue: recent.errorRate,
      baselineValue: ERROR_RATE_THRESHOLD,
    };
    anomalies.push(anomaly);
  }

  // 3. Latency degradation
  if (
    baseline.p99Latency > 0 &&
    recent.p99Latency > baseline.p99Latency * LATENCY_DEGRADATION_FACTOR
  ) {
    const anomaly: Anomaly = {
      type: "latency_degradation",
      service,
      message: `Latency degradation: p99 ${recent.p99Latency.toFixed(0)}ms vs baseline ${baseline.p99Latency.toFixed(0)}ms (${(recent.p99Latency / baseline.p99Latency).toFixed(1)}x)`,
      severity:
        recent.p99Latency > baseline.p99Latency * LATENCY_DEGRADATION_FACTOR * 2
          ? "critical"
          : "warning",
      detectedAt: now,
      currentValue: recent.p99Latency,
      baselineValue: baseline.p99Latency,
    };
    anomalies.push(anomaly);
  }

  // Persist detected anomalies
  const insertStmt = db.prepare(
    `INSERT INTO scaler_anomalies (type, service, message, severity, detected_at, current_value, baseline_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of anomalies) {
    insertStmt.run(a.type, a.service, a.message, a.severity, a.detectedAt, a.currentValue, a.baselineValue);
  }

  return anomalies;
}

/**
 * Produce a scaling recommendation for a service based on current
 * traffic patterns relative to the baseline.
 */
export function getScalingRecommendation(
  db: Database,
  service: string,
): ScalingRecommendation {
  const baseline = getTrafficStats(db, service, BASELINE_WINDOW_MINUTES);
  const recent = getTrafficStats(db, service, SPIKE_WINDOW_MINUTES);
  const anomalies = detectAnomalies(db, service);
  const now = new Date().toISOString();

  let action: ScalingAction = "none";
  let reason = "Traffic is within normal parameters.";

  // Scale-up triggers
  const hasCriticalAnomaly = anomalies.some((a) => a.severity === "critical");
  const hasSpike = anomalies.some((a) => a.type === "spike");
  const hasLatencyDegradation = anomalies.some((a) => a.type === "latency_degradation");

  if (hasCriticalAnomaly) {
    action = "scale-up";
    const criticalMessages = anomalies
      .filter((a) => a.severity === "critical")
      .map((a) => a.message)
      .join("; ");
    reason = `Critical anomalies detected: ${criticalMessages}`;
  } else if (hasSpike && hasLatencyDegradation) {
    action = "scale-up";
    reason = `Traffic spike (${recent.rpm.toFixed(1)} RPM) with latency degradation (p99: ${recent.p99Latency.toFixed(0)}ms). Scale up to maintain SLA.`;
  } else if (hasSpike) {
    action = "scale-up";
    reason = `Traffic spike detected: ${recent.rpm.toFixed(1)} RPM vs baseline ${baseline.rpm.toFixed(1)} RPM. Pre-emptive scale-up recommended.`;
  }

  // Scale-down triggers (only if no scale-up reason)
  if (action === "none" && baseline.rpm > 0 && recent.rpm < baseline.rpm * SCALE_DOWN_THRESHOLD) {
    action = "scale-down";
    reason = `Low traffic: ${recent.rpm.toFixed(1)} RPM vs baseline ${baseline.rpm.toFixed(1)} RPM. Scale down to reduce compute cost.`;
  }

  const recommendation: ScalingRecommendation = {
    action,
    reason,
    service,
    timestamp: now,
  };

  // Persist recommendation
  db.prepare(
    "INSERT INTO scaler_recommendations (service, action, reason, timestamp) VALUES (?, ?, ?, ?)",
  ).run(service, action, reason, now);

  return recommendation;
}

/**
 * Estimate resource utilization for a service based on request
 * volume and latency characteristics.
 */
export function getResourceUtilization(
  db: Database,
  service: string,
): ResourceUtilization {
  const stats = getTrafficStats(db, service, SPIKE_WINDOW_MINUTES);

  // Heuristic: estimate CPU from RPS * avg latency
  // If each request occupies a core for latencyMs, then:
  //   concurrent_requests ≈ rps * (avgLatency / 1000)
  //   cpu% ≈ concurrent_requests / assumed_cores * 100
  const assumedCores = 4;
  const concurrentRequests = stats.rps * (stats.avgLatency / 1000);
  const estimatedCpuPercent = Math.min(100, (concurrentRequests / assumedCores) * 100);

  // Memory estimate: base 20% + 0.5% per concurrent request
  const estimatedMemoryPercent = Math.min(100, 20 + concurrentRequests * 0.5);

  return {
    service,
    estimatedCpuPercent: Math.round(estimatedCpuPercent * 10) / 10,
    estimatedMemoryPercent: Math.round(estimatedMemoryPercent * 10) / 10,
    activeConnections: Math.round(concurrentRequests),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generate a human-readable traffic report across all tracked services.
 */
export function generateTrafficReport(db: Database): string {
  const services = db
    .prepare("SELECT DISTINCT service FROM scaler_requests")
    .all() as { service: string }[];

  if (services.length === 0) {
    return "No traffic data recorded yet.";
  }

  const lines: string[] = ["=== Traffic Report ===", ""];

  for (const { service } of services) {
    const stats = getTrafficStats(db, service, BASELINE_WINDOW_MINUTES);
    const recentStats = getTrafficStats(db, service, SPIKE_WINDOW_MINUTES);
    const utilization = getResourceUtilization(db, service);
    const recommendation = getScalingRecommendation(db, service);

    lines.push(`--- ${service} ---`);
    lines.push(`  Baseline (${BASELINE_WINDOW_MINUTES}m): ${stats.rpm.toFixed(1)} RPM, ${stats.totalRequests} total requests`);
    lines.push(`  Recent (${SPIKE_WINDOW_MINUTES}m): ${recentStats.rpm.toFixed(1)} RPM, ${recentStats.totalRequests} requests`);
    lines.push(`  Avg Latency: ${stats.avgLatency.toFixed(0)}ms | P99: ${stats.p99Latency.toFixed(0)}ms`);
    lines.push(`  Error Rate: ${(stats.errorRate * 100).toFixed(1)}%`);
    lines.push(`  Est. CPU: ${utilization.estimatedCpuPercent}% | Est. Memory: ${utilization.estimatedMemoryPercent}%`);
    lines.push(`  Active Connections (est.): ${utilization.activeConnections}`);
    lines.push(`  Recommendation: ${recommendation.action.toUpperCase()} — ${recommendation.reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Prune old request records to prevent unbounded database growth.
 * Call periodically (e.g., every heartbeat cycle).
 */
export function pruneOldRecords(db: Database): number {
  const cutoff = Date.now() - MAX_RECORD_AGE_MS;
  const result = db
    .prepare("DELETE FROM scaler_requests WHERE timestamp_ms < ?")
    .run(cutoff);
  if (result.changes > 0) {
    logger.info(`Pruned ${result.changes} old scaler request records`);
  }
  return result.changes;
}
