/**
 * Service Health Monitoring Skill
 *
 * Monitors health endpoints of all deployed services, tracks uptime/downtime,
 * stores results in SQLite, calculates uptime percentages, detects consecutive
 * failures, and provides a text-based status dashboard.
 *
 * Revenue nexus: keeps APIs alive (Priority #2 in revenue-first doctrine).
 * Dead endpoints = zero revenue.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Skill } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("skills.service-health");

type Database = BetterSqlite3.Database;

// ─── Types ──────────────────────────────────────────────────────

export interface ServiceConfig {
  name: string;
  url: string;
}

export interface HealthCheckResult {
  service: string;
  url: string;
  status: "up" | "down";
  statusCode: number | null;
  latencyMs: number;
  timestamp: string;
  error: string | null;
}

export interface HealthReport {
  service: string;
  url: string;
  status: "up" | "down";
  statusCode: number | null;
  latencyMs: number;
  timestamp: string;
  error: string | null;
  uptimePercent24h: number;
  consecutiveFailures: number;
}

export interface Alert {
  id: number;
  service: string;
  type: "down" | "recovered";
  message: string;
  consecutiveFailures: number;
  createdAt: string;
}

// ─── Default Services ───────────────────────────────────────────

const DEFAULT_SERVICES: ServiceConfig[] = [
  { name: "Landing Page", url: "http://localhost:3000/health" },
  { name: "URL Summarizer", url: "http://localhost:9003/health" },
  { name: "x402 API", url: "http://localhost:9402/health" },
  { name: "Gateway", url: "http://localhost:7402/health" },
  { name: "Invoice Parser", url: "http://localhost:8000/health" },
];

/** Consecutive failures before an alert is generated */
const ALERT_THRESHOLD = 3;

/** Default HTTP timeout for health checks (ms) */
const CHECK_TIMEOUT_MS = 5_000;

// ─── Database Setup ─────────────────────────────────────────────

/**
 * Initialize the service_health_checks and service_health_alerts tables.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function initHealthDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('up', 'down')),
      status_code INTEGER,
      latency_ms REAL NOT NULL,
      error TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_health_checks_service_time
      ON service_health_checks(service, checked_at DESC);

    CREATE TABLE IF NOT EXISTS service_health_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('down', 'recovered')),
      message TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_health_alerts_time
      ON service_health_alerts(created_at DESC);
  `);
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Check a single service health endpoint.
 */
export async function checkHealth(serviceUrl: string): Promise<{
  status: "up" | "down";
  statusCode: number | null;
  latencyMs: number;
  timestamp: string;
  error: string | null;
}> {
  const timestamp = new Date().toISOString();
  const start = performance.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const response = await fetch(serviceUrl, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Math.round(performance.now() - start);

    const isUp = response.status >= 200 && response.status < 400;

    return {
      status: isUp ? "up" : "down",
      statusCode: response.status,
      latencyMs,
      timestamp,
      error: isUp ? null : `HTTP ${response.status}`,
    };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - start);
    const errorMsg =
      err.name === "AbortError"
        ? `Timeout after ${CHECK_TIMEOUT_MS}ms`
        : err.message || "Unknown error";

    return {
      status: "down",
      statusCode: null,
      latencyMs,
      timestamp,
      error: errorMsg,
    };
  }
}

/**
 * Check all configured services and store results.
 * Generates alerts on consecutive failures or recovery.
 */
export async function checkAllServices(
  db: Database,
  services: ServiceConfig[] = DEFAULT_SERVICES,
): Promise<HealthReport[]> {
  initHealthDb(db);

  const reports: HealthReport[] = [];

  const insertCheck = db.prepare(`
    INSERT INTO service_health_checks (service, url, status, status_code, latency_ms, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAlert = db.prepare(`
    INSERT INTO service_health_alerts (service, type, message, consecutive_failures, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const svc of services) {
    const result = await checkHealth(svc.url);

    // Store the check result
    insertCheck.run(
      svc.name,
      svc.url,
      result.status,
      result.statusCode,
      result.latencyMs,
      result.error,
      result.timestamp,
    );

    // Calculate consecutive failures
    const consecutiveFailures = getConsecutiveFailures(db, svc.name);

    // Calculate 24h uptime
    const uptimePercent24h = getUptime(db, svc.name, "24h");

    // Generate alerts
    if (result.status === "down" && consecutiveFailures >= ALERT_THRESHOLD) {
      const msg = `${svc.name} has been DOWN for ${consecutiveFailures} consecutive checks. Last error: ${result.error}`;
      insertAlert.run(svc.name, "down", msg, consecutiveFailures, result.timestamp);
      logger.warn(msg);
    } else if (result.status === "up" && consecutiveFailures === 0) {
      // Check if the previous check was a failure (recovery event)
      const prevDown = db
        .prepare(
          `SELECT status FROM service_health_checks
           WHERE service = ? AND checked_at < ?
           ORDER BY checked_at DESC LIMIT 1`,
        )
        .get(svc.name, result.timestamp) as { status: string } | undefined;

      if (prevDown && prevDown.status === "down") {
        const msg = `${svc.name} has RECOVERED and is back UP.`;
        insertAlert.run(svc.name, "recovered", msg, 0, result.timestamp);
        logger.info(msg);
      }
    }

    reports.push({
      service: svc.name,
      url: svc.url,
      status: result.status,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      timestamp: result.timestamp,
      error: result.error,
      uptimePercent24h,
      consecutiveFailures,
    });
  }

  return reports;
}

/**
 * Get the number of consecutive failures for a service (most recent first).
 */
function getConsecutiveFailures(db: Database, service: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM service_health_checks
       WHERE service = ?
       ORDER BY checked_at DESC
       LIMIT 100`,
    )
    .all(service) as { status: string }[];

  let count = 0;
  for (const row of rows) {
    if (row.status === "down") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Get uptime percentage for a service over a given period.
 *
 * @param period - "1h", "24h", "7d", "30d"
 */
export function getUptime(
  db: Database,
  service: string,
  period: string = "24h",
): number {
  initHealthDb(db);

  const periodMap: Record<string, string> = {
    "1h": "-1 hour",
    "24h": "-24 hours",
    "7d": "-7 days",
    "30d": "-30 days",
  };

  const sqlInterval = periodMap[period] || periodMap["24h"];

  const row = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_count
       FROM service_health_checks
       WHERE service = ? AND checked_at >= datetime('now', ?)`,
    )
    .get(service, sqlInterval) as { total: number; up_count: number } | undefined;

  if (!row || row.total === 0) return 100; // No data = assume up
  return Math.round((row.up_count / row.total) * 10000) / 100; // 2 decimal places
}

/**
 * Get alerts since a given timestamp (ISO string).
 * If no timestamp provided, returns alerts from the last 24 hours.
 */
export function getAlerts(
  db: Database,
  since?: string,
): Alert[] {
  initHealthDb(db);

  const sinceTime = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, service, type, message, consecutive_failures, created_at
       FROM service_health_alerts
       WHERE created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sinceTime) as Array<{
    id: number;
    service: string;
    type: "down" | "recovered";
    message: string;
    consecutive_failures: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    type: r.type,
    message: r.message,
    consecutiveFailures: r.consecutive_failures,
    createdAt: r.created_at,
  }));
}

/**
 * Generate a text-based status dashboard.
 */
export function getStatusDashboard(
  db: Database,
  services: ServiceConfig[] = DEFAULT_SERVICES,
): string {
  initHealthDb(db);

  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push("=".repeat(78));
  lines.push("  SERVICE HEALTH DASHBOARD");
  lines.push(`  Generated: ${now}`);
  lines.push("=".repeat(78));
  lines.push("");

  // Header
  const header = padRight("Service", 20)
    + padRight("Status", 10)
    + padRight("Latency", 12)
    + padRight("Uptime 24h", 12)
    + padRight("Uptime 7d", 12)
    + "Failures";
  lines.push(header);
  lines.push("-".repeat(78));

  for (const svc of services) {
    // Get latest check
    const latest = db
      .prepare(
        `SELECT status, latency_ms, status_code, error, checked_at
         FROM service_health_checks
         WHERE service = ?
         ORDER BY checked_at DESC
         LIMIT 1`,
      )
      .get(svc.name) as
      | { status: string; latency_ms: number; status_code: number | null; error: string | null; checked_at: string }
      | undefined;

    const uptime24h = getUptime(db, svc.name, "24h");
    const uptime7d = getUptime(db, svc.name, "7d");
    const failures = getConsecutiveFailures(db, svc.name);

    if (!latest) {
      lines.push(
        padRight(svc.name, 20)
          + padRight("UNKNOWN", 10)
          + padRight("--", 12)
          + padRight("--", 12)
          + padRight("--", 12)
          + "0",
      );
      continue;
    }

    const statusIcon = latest.status === "up" ? "UP" : "DOWN";
    const latencyStr = `${latest.latency_ms}ms`;

    lines.push(
      padRight(svc.name, 20)
        + padRight(statusIcon, 10)
        + padRight(latencyStr, 12)
        + padRight(`${uptime24h}%`, 12)
        + padRight(`${uptime7d}%`, 12)
        + String(failures),
    );
  }

  lines.push("-".repeat(78));
  lines.push("");

  // Recent alerts
  const recentAlerts = getAlerts(db);
  if (recentAlerts.length > 0) {
    lines.push("  RECENT ALERTS (last 24h)");
    lines.push("-".repeat(78));
    for (const alert of recentAlerts.slice(0, 10)) {
      const icon = alert.type === "down" ? "[DOWN]" : "[RECOVERED]";
      lines.push(`  ${icon} ${alert.createdAt} - ${alert.message}`);
    }
    lines.push("");
  } else {
    lines.push("  No alerts in the last 24 hours.");
    lines.push("");
  }

  lines.push("=".repeat(78));

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

// ─── Skill Export ───────────────────────────────────────────────

/**
 * The service-health skill definition, conforming to the Skill interface.
 */
export const serviceHealthSkill: Skill = {
  name: "service-health",
  description:
    "Monitors health endpoints of deployed services, tracks uptime/downtime, " +
    "detects consecutive failures, generates alerts, and provides a status dashboard. " +
    "Revenue nexus: keeps APIs alive (dead endpoints = zero revenue).",
  autoActivate: true,
  instructions: [
    "Use this skill to monitor the health of all deployed services.",
    "",
    "Available functions:",
    "- checkHealth(serviceUrl): Check a single endpoint, returns { status, statusCode, latencyMs, timestamp, error }",
    "- checkAllServices(db, services?): Check all services, store results, generate alerts. Returns HealthReport[]",
    "- getUptime(db, service, period): Get uptime % for a service. Period: '1h', '24h', '7d', '30d'",
    "- getAlerts(db, since?): Get alerts since a timestamp (default: last 24h)",
    "- getStatusDashboard(db, services?): Generate a text-based status dashboard",
    "- initHealthDb(db): Initialize the SQLite tables (called automatically by other functions)",
    "",
    "Default monitored services:",
    "- Landing Page: http://localhost:3000/health",
    "- URL Summarizer: http://localhost:9003/health",
    "- x402 API: http://localhost:9402/health",
    "- Gateway: http://localhost:7402/health",
    "- Invoice Parser: http://localhost:8000/health",
    "",
    "Alert threshold: 3 consecutive failures triggers a DOWN alert.",
    "Recovery is automatically detected and logged.",
  ].join("\n"),
  source: "builtin",
  path: import.meta.url,
  enabled: true,
  installedAt: new Date().toISOString(),
};

export default serviceHealthSkill;
