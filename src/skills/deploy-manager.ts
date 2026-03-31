/**
 * Deployment Manager Skill
 *
 * Tracks deployment state per service, stores deployment history in SQLite,
 * provides rollback information, generates deployment status reports,
 * and tracks deployment frequency and success rate.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import type { Skill } from "../types.js";

type DatabaseType = BetterSqlite3.Database;

const logger = createLogger("skills.deploy-manager");

// ─── Types ──────────────────────────────────────────────────────

export type DeploymentStatus = "pending" | "deploying" | "success" | "failed" | "rolled_back";

export interface DeploymentRecord {
  id: string;
  service: string;
  version: string;
  commit_sha: string;
  status: DeploymentStatus;
  deployed_at: string;
  finished_at: string | null;
  previous_version: string | null;
}

export interface DeploymentStats {
  deploys: number;
  successes: number;
  failures: number;
  rollbacks: number;
  success_rate: number;
  avg_deploy_frequency_hours: number | null;
}

export interface ServiceVersion {
  service: string;
  version: string;
  commit_sha: string;
  deployed_at: string;
  status: DeploymentStatus;
}

// ─── Schema ─────────────────────────────────────────────────────

const CREATE_DEPLOYMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    version TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    previous_version TEXT,
    UNIQUE(service, version, deployed_at)
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service);
  CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
  CREATE INDEX IF NOT EXISTS idx_deployments_deployed_at ON deployments(deployed_at);
`;

// ─── Deploy Manager ─────────────────────────────────────────────

export class DeployManager {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_DEPLOYMENTS_TABLE);
    logger.info("DeployManager initialized", { dbPath });
  }

  /**
   * Record a new deployment event.
   * Automatically captures the previous version for rollback reference.
   */
  recordDeployment(
    service: string,
    version: string,
    commitSha: string,
    status: DeploymentStatus = "success",
  ): DeploymentRecord {
    const id = `deploy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Look up previous version for this service
    const prev = this.db.prepare(
      `SELECT version FROM deployments
       WHERE service = ? AND status = 'success'
       ORDER BY deployed_at DESC LIMIT 1`,
    ).get(service) as { version: string } | undefined;

    const finishedAt = status === "pending" || status === "deploying" ? null : now;

    this.db.prepare(
      `INSERT INTO deployments (id, service, version, commit_sha, status, deployed_at, finished_at, previous_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, service, version, commitSha, status, now, finishedAt, prev?.version ?? null);

    logger.info("Deployment recorded", { id, service, version, status });

    return {
      id,
      service,
      version,
      commit_sha: commitSha,
      status,
      deployed_at: now,
      finished_at: finishedAt,
      previous_version: prev?.version ?? null,
    };
  }

  /**
   * Update the status of an existing deployment.
   */
  updateDeploymentStatus(id: string, status: DeploymentStatus): void {
    const finishedAt = status === "pending" || status === "deploying" ? null : new Date().toISOString();
    this.db.prepare(
      `UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?`,
    ).run(status, finishedAt, id);
    logger.info("Deployment status updated", { id, status });
  }

  /**
   * Get deployment history for a service, ordered by most recent first.
   */
  getDeploymentHistory(service: string, limit: number = 20): DeploymentRecord[] {
    return this.db.prepare(
      `SELECT id, service, version, commit_sha, status, deployed_at, finished_at, previous_version
       FROM deployments
       WHERE service = ?
       ORDER BY deployed_at DESC
       LIMIT ?`,
    ).all(service, limit) as DeploymentRecord[];
  }

  /**
   * Get the current deployed version for every service.
   */
  getCurrentVersions(): Map<string, ServiceVersion> {
    const rows = this.db.prepare(
      `SELECT d.service, d.version, d.commit_sha, d.deployed_at, d.status
       FROM deployments d
       INNER JOIN (
         SELECT service, MAX(deployed_at) AS max_deployed
         FROM deployments
         WHERE status = 'success'
         GROUP BY service
       ) latest ON d.service = latest.service AND d.deployed_at = latest.max_deployed`,
    ).all() as ServiceVersion[];

    const versions = new Map<string, ServiceVersion>();
    for (const row of rows) {
      versions.set(row.service, row);
    }
    return versions;
  }

  /**
   * Get deployment statistics for a given period.
   * @param period - ISO 8601 duration-style label or SQLite modifier, e.g. "24 hours", "7 days", "30 days"
   */
  getDeploymentStats(period: string = "7 days"): DeploymentStats {
    const since = this.db.prepare(
      `SELECT datetime('now', '-' || ?) AS cutoff`,
    ).get(period) as { cutoff: string };

    const stats = this.db.prepare(
      `SELECT
         COUNT(*) AS deploys,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
         SUM(CASE WHEN status = 'rolled_back' THEN 1 ELSE 0 END) AS rollbacks
       FROM deployments
       WHERE deployed_at >= ?`,
    ).get(since.cutoff) as { deploys: number; successes: number; failures: number; rollbacks: number };

    const successRate = stats.deploys > 0 ? stats.successes / stats.deploys : 0;

    // Calculate average deploy frequency
    let avgFrequency: number | null = null;
    if (stats.deploys >= 2) {
      const range = this.db.prepare(
        `SELECT
           MIN(deployed_at) AS first_deploy,
           MAX(deployed_at) AS last_deploy
         FROM deployments
         WHERE deployed_at >= ?`,
      ).get(since.cutoff) as { first_deploy: string; last_deploy: string };

      const firstMs = new Date(range.first_deploy).getTime();
      const lastMs = new Date(range.last_deploy).getTime();
      const spanHours = (lastMs - firstMs) / (1000 * 60 * 60);
      avgFrequency = spanHours / (stats.deploys - 1);
    }

    return {
      deploys: stats.deploys,
      successes: stats.successes,
      failures: stats.failures,
      rollbacks: stats.rollbacks,
      success_rate: Math.round(successRate * 10000) / 100,
      avg_deploy_frequency_hours: avgFrequency !== null ? Math.round(avgFrequency * 100) / 100 : null,
    };
  }

  /**
   * Generate a human-readable deployment status report.
   */
  generateDeployReport(): string {
    const versions = this.getCurrentVersions();
    const stats7d = this.getDeploymentStats("7 days");
    const stats24h = this.getDeploymentStats("24 hours");

    const lines: string[] = [
      "# Deployment Status Report",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Current Versions",
    ];

    if (versions.size === 0) {
      lines.push("No services deployed yet.");
    } else {
      for (const [service, info] of versions) {
        lines.push(`- **${service}**: v${info.version} (${info.commit_sha.slice(0, 7)}) deployed ${info.deployed_at}`);
      }
    }

    lines.push("", "## Last 24 Hours");
    lines.push(`- Deployments: ${stats24h.deploys}`);
    lines.push(`- Successes: ${stats24h.successes}`);
    lines.push(`- Failures: ${stats24h.failures}`);
    lines.push(`- Rollbacks: ${stats24h.rollbacks}`);
    lines.push(`- Success Rate: ${stats24h.success_rate}%`);

    lines.push("", "## Last 7 Days");
    lines.push(`- Deployments: ${stats7d.deploys}`);
    lines.push(`- Successes: ${stats7d.successes}`);
    lines.push(`- Failures: ${stats7d.failures}`);
    lines.push(`- Rollbacks: ${stats7d.rollbacks}`);
    lines.push(`- Success Rate: ${stats7d.success_rate}%`);
    if (stats7d.avg_deploy_frequency_hours !== null) {
      lines.push(`- Avg Deploy Frequency: every ${stats7d.avg_deploy_frequency_hours}h`);
    }

    // Recent failures
    const recentFailures = this.db.prepare(
      `SELECT service, version, commit_sha, deployed_at
       FROM deployments
       WHERE status IN ('failed', 'rolled_back')
       ORDER BY deployed_at DESC
       LIMIT 5`,
    ).all() as Pick<DeploymentRecord, "service" | "version" | "commit_sha" | "deployed_at">[];

    if (recentFailures.length > 0) {
      lines.push("", "## Recent Failures");
      for (const f of recentFailures) {
        lines.push(`- ${f.service} v${f.version} (${f.commit_sha.slice(0, 7)}) at ${f.deployed_at}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get rollback info: the previous successful version for a service.
   */
  getRollbackTarget(service: string): DeploymentRecord | null {
    const current = this.db.prepare(
      `SELECT version FROM deployments
       WHERE service = ? AND status = 'success'
       ORDER BY deployed_at DESC LIMIT 1`,
    ).get(service) as { version: string } | undefined;

    if (!current) return null;

    const previous = this.db.prepare(
      `SELECT id, service, version, commit_sha, status, deployed_at, finished_at, previous_version
       FROM deployments
       WHERE service = ? AND status = 'success' AND version != ?
       ORDER BY deployed_at DESC LIMIT 1`,
    ).get(service, current.version) as DeploymentRecord | undefined;

    return previous ?? null;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ─── Skill Export ───────────────────────────────────────────────

export const SKILL_METADATA: Skill = {
  name: "deploy-manager",
  description: "Track deployment state, history, rollback info, and deployment frequency/success metrics per service.",
  autoActivate: true,
  instructions: [
    "Use the DeployManager class to record and query deployments.",
    "recordDeployment(service, version, commitSha, status) to log a deploy.",
    "getDeploymentHistory(service, limit?) to view past deploys.",
    "getCurrentVersions() returns a Map of service -> current version.",
    "getDeploymentStats(period) returns deploy counts, success rate, and frequency.",
    "generateDeployReport() returns a full markdown status report.",
    "getRollbackTarget(service) returns the previous successful version for rollback.",
  ].join("\n"),
  source: "builtin",
  path: import.meta.url,
  enabled: true,
  installedAt: new Date().toISOString(),
};
