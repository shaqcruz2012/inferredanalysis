/**
 * Customer Tracker
 *
 * Tracks unique customers by IP hash or API key, monitors their journey
 * from free tier through trial to paid, calculates Customer Lifetime Value,
 * identifies churn risk, and reports on usage patterns.
 *
 * Revenue nexus: directly supports conversion optimization and churn prevention.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skills.customer-tracker");

// ── Types ────────────────────────────────────────────────────────

export type CustomerSegment = "free" | "trial" | "paid" | "churned";

export interface CustomerActivity {
  readonly id: string;
  readonly customerHash: string;
  readonly service: string;
  readonly action: string;
  readonly paid: boolean;
  readonly amountCents: number;
  readonly timestamp: string;
}

export interface CustomerProfile {
  readonly customerHash: string;
  readonly segment: CustomerSegment;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly totalRequests: number;
  readonly paidRequests: number;
  readonly totalRevenueCents: number;
}

export interface CustomerSegments {
  readonly free: CustomerProfile[];
  readonly trial: CustomerProfile[];
  readonly paid: CustomerProfile[];
  readonly churned: CustomerProfile[];
}

export interface ChurnRisk {
  readonly customerHash: string;
  readonly riskScore: number;
  readonly lastActivity: string;
  readonly daysSinceLastActivity: number;
  readonly segment: CustomerSegment;
}

export interface CLVStats {
  readonly avg: number;
  readonly median: number;
  readonly total: number;
  readonly count: number;
}

export interface CustomerEvent {
  readonly id: string;
  readonly service: string;
  readonly action: string;
  readonly paid: boolean;
  readonly amountCents: number;
  readonly timestamp: string;
}

// ── Schema ───────────────────────────────────────────────────────

const CUSTOMER_TRACKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS customer_activity (
    id TEXT PRIMARY KEY,
    customer_hash TEXT NOT NULL,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_customer_activity_hash
    ON customer_activity(customer_hash);

  CREATE INDEX IF NOT EXISTS idx_customer_activity_timestamp
    ON customer_activity(timestamp);

  CREATE INDEX IF NOT EXISTS idx_customer_activity_hash_timestamp
    ON customer_activity(customer_hash, timestamp);

  CREATE INDEX IF NOT EXISTS idx_customer_activity_paid
    ON customer_activity(paid);

  CREATE TABLE IF NOT EXISTS customer_profiles (
    customer_hash TEXT PRIMARY KEY,
    segment TEXT NOT NULL DEFAULT 'free',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    total_requests INTEGER NOT NULL DEFAULT 0,
    paid_requests INTEGER NOT NULL DEFAULT 0,
    total_revenue_cents INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_customer_profiles_segment
    ON customer_profiles(segment);

  CREATE INDEX IF NOT EXISTS idx_customer_profiles_last_seen
    ON customer_profiles(last_seen);
`;

// ── Schema initialization ────────────────────────────────────────

/**
 * Ensure customer tracking tables exist.
 * Safe to call multiple times (CREATE IF NOT EXISTS).
 */
export function ensureCustomerTrackerSchema(db: Database): void {
  db.exec(CUSTOMER_TRACKER_SCHEMA);
}

// ── Segment classification ───────────────────────────────────────

/** Threshold: customers with >= this many paid requests are "paid" */
const PAID_THRESHOLD = 2;

/** Threshold: customers with 1 paid request are "trial" */
const TRIAL_THRESHOLD = 1;

/** Threshold: days of inactivity before a customer is considered churned */
const CHURN_DAYS = 14;

/**
 * Classify a customer into a segment based on their activity.
 */
function classifySegment(
  paidRequests: number,
  lastSeen: string,
): CustomerSegment {
  const daysSinceLast = Math.floor(
    (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceLast >= CHURN_DAYS) {
    return "churned";
  }

  if (paidRequests >= PAID_THRESHOLD) {
    return "paid";
  }

  if (paidRequests >= TRIAL_THRESHOLD) {
    return "trial";
  }

  return "free";
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Record a customer activity event and update their profile.
 */
export function recordCustomerActivity(
  db: Database,
  customerHash: string,
  service: string,
  action: string,
  paid: boolean,
  amountCents: number = 0,
): void {
  ensureCustomerTrackerSchema(db);

  const now = new Date().toISOString();
  const id = ulid();

  const insertActivity = db.prepare(`
    INSERT INTO customer_activity (id, customer_hash, service, action, paid, amount_cents, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertProfile = db.prepare(`
    INSERT INTO customer_profiles (customer_hash, segment, first_seen, last_seen, total_requests, paid_requests, total_revenue_cents, updated_at)
    VALUES (?, 'free', ?, ?, 1, ?, ?, ?)
    ON CONFLICT(customer_hash) DO UPDATE SET
      last_seen = excluded.last_seen,
      total_requests = total_requests + 1,
      paid_requests = paid_requests + excluded.paid_requests,
      total_revenue_cents = total_revenue_cents + excluded.total_revenue_cents,
      updated_at = excluded.updated_at
  `);

  const txn = db.transaction(() => {
    insertActivity.run(id, customerHash, service, action, paid ? 1 : 0, amountCents, now);
    upsertProfile.run(
      customerHash,
      now,
      now,
      paid ? 1 : 0,
      amountCents,
      now,
    );

    // Update segment classification
    const profile = db
      .prepare("SELECT paid_requests, last_seen FROM customer_profiles WHERE customer_hash = ?")
      .get(customerHash) as { paid_requests: number; last_seen: string } | undefined;

    if (profile) {
      const segment = classifySegment(profile.paid_requests, profile.last_seen);
      db.prepare("UPDATE customer_profiles SET segment = ?, updated_at = ? WHERE customer_hash = ?")
        .run(segment, now, customerHash);
    }
  });

  txn();

  logger.debug("Recorded customer activity", {
    customerHash,
    service,
    action,
    paid,
    amountCents,
  });
}

/**
 * Get all customers grouped by segment.
 */
export function getCustomerSegments(db: Database): CustomerSegments {
  ensureCustomerTrackerSchema(db);

  // Refresh segment classifications for all profiles
  refreshSegments(db);

  const rows = db
    .prepare("SELECT * FROM customer_profiles ORDER BY last_seen DESC")
    .all() as Array<{
    customer_hash: string;
    segment: string;
    first_seen: string;
    last_seen: string;
    total_requests: number;
    paid_requests: number;
    total_revenue_cents: number;
  }>;

  const segments: CustomerSegments = {
    free: [],
    trial: [],
    paid: [],
    churned: [],
  };

  for (const row of rows) {
    const profile: CustomerProfile = {
      customerHash: row.customer_hash,
      segment: row.segment as CustomerSegment,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      totalRequests: row.total_requests,
      paidRequests: row.paid_requests,
      totalRevenueCents: row.total_revenue_cents,
    };

    const seg = row.segment as CustomerSegment;
    if (seg in segments) {
      segments[seg].push(profile);
    }
  }

  return segments;
}

/**
 * Get the full journey (event timeline) for a specific customer.
 */
export function getCustomerJourney(
  db: Database,
  customerHash: string,
): CustomerEvent[] {
  ensureCustomerTrackerSchema(db);

  const rows = db
    .prepare(
      "SELECT id, service, action, paid, amount_cents, timestamp FROM customer_activity WHERE customer_hash = ? ORDER BY timestamp ASC",
    )
    .all(customerHash) as Array<{
    id: string;
    service: string;
    action: string;
    paid: number;
    amount_cents: number;
    timestamp: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    service: row.service,
    action: row.action,
    paid: row.paid === 1,
    amountCents: row.amount_cents,
    timestamp: row.timestamp,
  }));
}

/**
 * Identify customers at risk of churning.
 * Returns customers sorted by risk score (highest first).
 */
export function getChurnRisk(db: Database): ChurnRisk[] {
  ensureCustomerTrackerSchema(db);

  refreshSegments(db);

  const rows = db
    .prepare(
      "SELECT customer_hash, segment, last_seen, total_requests, paid_requests, total_revenue_cents FROM customer_profiles WHERE segment != 'churned' ORDER BY last_seen ASC",
    )
    .all() as Array<{
    customer_hash: string;
    segment: string;
    last_seen: string;
    total_requests: number;
    paid_requests: number;
    total_revenue_cents: number;
  }>;

  const risks: ChurnRisk[] = [];

  for (const row of rows) {
    const daysSinceLast = Math.floor(
      (Date.now() - new Date(row.last_seen).getTime()) / (1000 * 60 * 60 * 24),
    );

    // Risk score: 0.0 (no risk) to 1.0 (about to churn)
    // Based on days since last activity relative to churn threshold
    let riskScore = Math.min(1.0, daysSinceLast / CHURN_DAYS);

    // Paying customers who go quiet are higher risk (more revenue at stake)
    if (row.paid_requests > 0) {
      riskScore = Math.min(1.0, riskScore * 1.3);
    }

    // Only report meaningful risk (> 20%)
    if (riskScore > 0.2) {
      risks.push({
        customerHash: row.customer_hash,
        riskScore: Math.round(riskScore * 100) / 100,
        lastActivity: row.last_seen,
        daysSinceLastActivity: daysSinceLast,
        segment: row.segment as CustomerSegment,
      });
    }
  }

  // Sort by risk score descending
  risks.sort((a, b) => b.riskScore - a.riskScore);

  return risks;
}

/**
 * Calculate Customer Lifetime Value statistics.
 * Optionally filter by segment.
 */
export function getCLV(
  db: Database,
  segment?: CustomerSegment,
): CLVStats {
  ensureCustomerTrackerSchema(db);

  let query = "SELECT total_revenue_cents FROM customer_profiles";
  const params: string[] = [];

  if (segment) {
    query += " WHERE segment = ?";
    params.push(segment);
  }

  query += " ORDER BY total_revenue_cents ASC";

  const rows = db.prepare(query).all(...params) as Array<{
    total_revenue_cents: number;
  }>;

  if (rows.length === 0) {
    return { avg: 0, median: 0, total: 0, count: 0 };
  }

  const values = rows.map((r) => r.total_revenue_cents);
  const total = values.reduce((sum, v) => sum + v, 0);
  const avg = Math.round(total / values.length);

  // Median calculation
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0
      ? Math.round((values[mid - 1] + values[mid]) / 2)
      : values[mid];

  return {
    avg,
    median,
    total,
    count: values.length,
  };
}

/**
 * Generate a human-readable customer report.
 */
export function generateCustomerReport(db: Database): string {
  ensureCustomerTrackerSchema(db);

  const segments = getCustomerSegments(db);
  const clvAll = getCLV(db);
  const clvPaid = getCLV(db, "paid");
  const risks = getChurnRisk(db);

  const lines: string[] = [
    "═══ Customer Report ═══",
    "",
    "── Segment Breakdown ──",
    `  Free:    ${segments.free.length}`,
    `  Trial:   ${segments.trial.length}`,
    `  Paid:    ${segments.paid.length}`,
    `  Churned: ${segments.churned.length}`,
    `  Total:   ${segments.free.length + segments.trial.length + segments.paid.length + segments.churned.length}`,
    "",
    "── Conversion Funnel ──",
  ];

  const totalActive =
    segments.free.length + segments.trial.length + segments.paid.length;
  if (totalActive > 0) {
    const trialRate =
      totalActive > 0
        ? (
            ((segments.trial.length + segments.paid.length) / totalActive) *
            100
          ).toFixed(1)
        : "0.0";
    const paidRate =
      totalActive > 0
        ? ((segments.paid.length / totalActive) * 100).toFixed(1)
        : "0.0";
    lines.push(`  Free -> Trial+Paid: ${trialRate}%`);
    lines.push(`  Free -> Paid:       ${paidRate}%`);
  } else {
    lines.push("  No active customers yet.");
  }

  lines.push("");
  lines.push("── Customer Lifetime Value (cents) ──");
  lines.push(`  All customers:  avg=${clvAll.avg}  median=${clvAll.median}  total=${clvAll.total}`);
  lines.push(`  Paid customers: avg=${clvPaid.avg}  median=${clvPaid.median}  total=${clvPaid.total}`);

  if (risks.length > 0) {
    lines.push("");
    lines.push("── Churn Risk (top 10) ──");
    for (const risk of risks.slice(0, 10)) {
      lines.push(
        `  ${risk.customerHash.slice(0, 12)}... | risk=${risk.riskScore} | segment=${risk.segment} | inactive ${risk.daysSinceLastActivity}d`,
      );
    }
  }

  lines.push("");
  lines.push(`Report generated: ${new Date().toISOString()}`);

  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Refresh segment classifications for all customer profiles.
 * Re-evaluates churn based on current date.
 */
function refreshSegments(db: Database): void {
  const rows = db
    .prepare("SELECT customer_hash, paid_requests, last_seen FROM customer_profiles")
    .all() as Array<{
    customer_hash: string;
    paid_requests: number;
    last_seen: string;
  }>;

  const now = new Date().toISOString();
  const updateStmt = db.prepare(
    "UPDATE customer_profiles SET segment = ?, updated_at = ? WHERE customer_hash = ?",
  );

  const txn = db.transaction(() => {
    for (const row of rows) {
      const segment = classifySegment(row.paid_requests, row.last_seen);
      updateStmt.run(segment, now, row.customer_hash);
    }
  });

  txn();
}
