/**
 * Log Aggregator
 *
 * Collects structured logs from all services into SQLite,
 * provides search/filter capabilities, detects error patterns,
 * and generates log summaries.
 *
 * Revenue nexus: keeps revenue-generating services observable
 * and reduces downtime through early error detection.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skills.log-aggregator");

// ── Types ────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  readonly id: string;
  readonly service: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: string;
}

export interface LogFilters {
  readonly service?: string;
  readonly level?: LogLevel;
  readonly since?: string;
  readonly until?: string;
  readonly pattern?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ErrorSummaryEntry {
  readonly service: string;
  readonly errorCount: number;
  readonly topErrors: Array<{
    readonly message: string;
    readonly count: number;
    readonly lastSeen: string;
  }>;
}

export interface LogReport {
  readonly period: string;
  readonly totalLogs: number;
  readonly byLevel: Record<LogLevel, number>;
  readonly byService: Record<string, number>;
  readonly errorSummary: ErrorSummaryEntry[];
  readonly generatedAt: string;
}

// ── Schema ───────────────────────────────────────────────────────

const LOG_AGGREGATOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS aggregated_logs (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_aggregated_logs_service
    ON aggregated_logs(service);

  CREATE INDEX IF NOT EXISTS idx_aggregated_logs_level
    ON aggregated_logs(level);

  CREATE INDEX IF NOT EXISTS idx_aggregated_logs_timestamp
    ON aggregated_logs(timestamp);

  CREATE INDEX IF NOT EXISTS idx_aggregated_logs_service_level
    ON aggregated_logs(service, level);

  CREATE INDEX IF NOT EXISTS idx_aggregated_logs_service_timestamp
    ON aggregated_logs(service, timestamp);
`;

// ── Schema initialization ────────────────────────────────────────

/**
 * Ensure log aggregation tables exist.
 * Safe to call multiple times (CREATE IF NOT EXISTS).
 */
export function ensureLogAggregatorSchema(db: Database): void {
  db.exec(LOG_AGGREGATOR_SCHEMA);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Record a structured log entry.
 */
export function log(
  db: Database,
  service: string,
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  ensureLogAggregatorSchema(db);

  const id = ulid();
  const now = new Date().toISOString();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  db.prepare(`
    INSERT INTO aggregated_logs (id, service, level, message, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, service, level, message, metadataJson, now);

  logger.debug("Log entry recorded", { service, level, id });
}

/**
 * Query logs with flexible filters.
 */
export function query(
  db: Database,
  filters: LogFilters = {},
): LogEntry[] {
  ensureLogAggregatorSchema(db);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.service) {
    conditions.push("service = ?");
    params.push(filters.service);
  }

  if (filters.level) {
    conditions.push("level = ?");
    params.push(filters.level);
  }

  if (filters.since) {
    conditions.push("timestamp >= ?");
    params.push(filters.since);
  }

  if (filters.until) {
    conditions.push("timestamp <= ?");
    params.push(filters.until);
  }

  if (filters.pattern) {
    conditions.push("message LIKE ?");
    params.push(`%${filters.pattern}%`);
  }

  let sql = "SELECT * FROM aggregated_logs";
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY timestamp DESC";

  const limit = filters.limit ?? 100;
  sql += " LIMIT ?";
  params.push(limit);

  if (filters.offset) {
    sql += " OFFSET ?";
    params.push(filters.offset);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    service: string;
    level: string;
    message: string;
    metadata: string | null;
    timestamp: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    service: row.service,
    level: row.level as LogLevel,
    message: row.message,
    metadata: row.metadata ? parseMetadata(row.metadata) : undefined,
    timestamp: row.timestamp,
  }));
}

/**
 * Get error summary grouped by service for a given period.
 *
 * @param period - ISO timestamp for the start of the period (e.g., "2026-03-30T00:00:00.000Z")
 */
export function getErrorSummary(
  db: Database,
  period: string,
): ErrorSummaryEntry[] {
  ensureLogAggregatorSchema(db);

  // Get distinct services with errors in the period
  const services = db
    .prepare(
      `SELECT DISTINCT service FROM aggregated_logs
       WHERE level IN ('error', 'fatal') AND timestamp >= ?
       ORDER BY service`,
    )
    .all(period) as Array<{ service: string }>;

  const summaries: ErrorSummaryEntry[] = [];

  for (const { service } of services) {
    // Total error count for this service
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM aggregated_logs
         WHERE service = ? AND level IN ('error', 'fatal') AND timestamp >= ?`,
      )
      .get(service, period) as { cnt: number };

    // Top error messages (grouped and counted)
    const topErrors = db
      .prepare(
        `SELECT message, COUNT(*) AS cnt, MAX(timestamp) AS last_seen
         FROM aggregated_logs
         WHERE service = ? AND level IN ('error', 'fatal') AND timestamp >= ?
         GROUP BY message
         ORDER BY cnt DESC
         LIMIT 5`,
      )
      .all(service, period) as Array<{
      message: string;
      cnt: number;
      last_seen: string;
    }>;

    summaries.push({
      service,
      errorCount: countRow.cnt,
      topErrors: topErrors.map((e) => ({
        message: e.message,
        count: e.cnt,
        lastSeen: e.last_seen,
      })),
    });
  }

  // Sort by error count descending
  summaries.sort((a, b) => b.errorCount - a.errorCount);

  return summaries;
}

/**
 * Get the most recent logs, optionally filtered by service.
 */
export function getRecentLogs(
  db: Database,
  service?: string,
  limit: number = 50,
): LogEntry[] {
  return query(db, { service, limit });
}

/**
 * Generate a human-readable log report for a given period.
 *
 * @param period - ISO timestamp for the start of the reporting period
 */
export function generateLogReport(
  db: Database,
  period: string,
): string {
  ensureLogAggregatorSchema(db);

  // Total logs in period
  const totalRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM aggregated_logs WHERE timestamp >= ?")
    .get(period) as { cnt: number };

  // Logs by level
  const levelRows = db
    .prepare(
      `SELECT level, COUNT(*) AS cnt FROM aggregated_logs
       WHERE timestamp >= ?
       GROUP BY level
       ORDER BY cnt DESC`,
    )
    .all(period) as Array<{ level: string; cnt: number }>;

  const byLevel: Record<string, number> = {};
  for (const row of levelRows) {
    byLevel[row.level] = row.cnt;
  }

  // Logs by service
  const serviceRows = db
    .prepare(
      `SELECT service, COUNT(*) AS cnt FROM aggregated_logs
       WHERE timestamp >= ?
       GROUP BY service
       ORDER BY cnt DESC`,
    )
    .all(period) as Array<{ service: string; cnt: number }>;

  const byService: Record<string, number> = {};
  for (const row of serviceRows) {
    byService[row.service] = row.cnt;
  }

  // Error summary
  const errorSummary = getErrorSummary(db, period);

  // Build report
  const lines: string[] = [
    "═══ Log Aggregation Report ═══",
    "",
    `Period: ${period} to now`,
    `Total log entries: ${totalRow.cnt}`,
    "",
    "── By Level ──",
  ];

  const levels: LogLevel[] = ["fatal", "error", "warn", "info", "debug"];
  for (const level of levels) {
    const count = byLevel[level] ?? 0;
    if (count > 0) {
      lines.push(`  ${level.toUpperCase().padEnd(6)}: ${count}`);
    }
  }

  lines.push("");
  lines.push("── By Service ──");
  for (const [service, count] of Object.entries(byService)) {
    lines.push(`  ${service}: ${count}`);
  }

  if (errorSummary.length > 0) {
    lines.push("");
    lines.push("── Error Summary ──");
    for (const entry of errorSummary) {
      lines.push(`  ${entry.service}: ${entry.errorCount} error(s)`);
      for (const err of entry.topErrors.slice(0, 3)) {
        const truncatedMsg =
          err.message.length > 80
            ? err.message.slice(0, 77) + "..."
            : err.message;
        lines.push(`    [${err.count}x] ${truncatedMsg}`);
        lines.push(`         last seen: ${err.lastSeen}`);
      }
    }
  } else {
    lines.push("");
    lines.push("── No errors in this period ──");
  }

  lines.push("");
  lines.push(`Report generated: ${new Date().toISOString()}`);

  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Safely parse metadata JSON string.
 */
function parseMetadata(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
