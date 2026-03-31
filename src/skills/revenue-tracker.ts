/**
 * Revenue Tracker Skill
 *
 * Tracks revenue events, calculates daily/weekly/monthly totals,
 * per-service breakdowns, free-to-paid conversion rates, and
 * generates formatted P&L reports.
 *
 * Uses the existing SQLite database (better-sqlite3) and builds
 * on the accounting patterns from src/local/accounting.ts.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { Skill } from "../types.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skills.revenue-tracker");

// ── Schema ──────────────────────────────────────────────────────

const REVENUE_TRACKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS revenue_tracking (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    customer_hash TEXT NOT NULL,
    is_paid INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS service_usage (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    customer_hash TEXT NOT NULL,
    is_paid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rev_track_service ON revenue_tracking(service);
  CREATE INDEX IF NOT EXISTS idx_rev_track_created ON revenue_tracking(created_at);
  CREATE INDEX IF NOT EXISTS idx_rev_track_customer ON revenue_tracking(customer_hash);
  CREATE INDEX IF NOT EXISTS idx_svc_usage_service ON service_usage(service);
  CREATE INDEX IF NOT EXISTS idx_svc_usage_created ON service_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_svc_usage_customer ON service_usage(customer_hash);
`;

/**
 * Initialize the revenue tracker schema.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function initRevenueTrackerSchema(db: Database): void {
  db.exec(REVENUE_TRACKER_SCHEMA);
  logger.info("Revenue tracker schema initialized");
}

// ── Types ───────────────────────────────────────────────────────

export interface RevenueEntry {
  id: string;
  service: string;
  amountCents: number;
  currency: string;
  customerHash: string;
  isPaid: boolean;
  createdAt: string;
}

export interface ServiceBreakdown {
  service: string;
  totalCents: number;
  totalUsd: number;
  transactionCount: number;
  uniqueCustomers: number;
}

export interface ConversionMetrics {
  service: string;
  freeUsers: number;
  paidUsers: number;
  conversionRate: number;
  period: string;
}

export interface DailyRevenue {
  date: string;
  totalCents: number;
  totalUsd: number;
  transactionCount: number;
}

export type Period = "day" | "week" | "month" | "all";

// ── Period Helpers ──────────────────────────────────────────────

const VALID_PERIODS: readonly Period[] = ["day", "week", "month", "all"] as const;

function getPeriodStart(period: Period): string {
  if (!(VALID_PERIODS as readonly string[]).includes(period)) {
    throw new Error(`Invalid period "${period}". Must be one of: ${VALID_PERIODS.join(", ")}`);
  }

  const now = new Date();
  switch (period) {
    case "day":
      return new Date(now.getTime() - 86_400_000).toISOString();
    case "week":
      return new Date(now.getTime() - 7 * 86_400_000).toISOString();
    case "month":
      return new Date(now.getTime() - 30 * 86_400_000).toISOString();
    default:
      return "1970-01-01T00:00:00.000Z";
  }
}

// ── Core Functions ──────────────────────────────────────────────

/**
 * Record a revenue event from a paid service call.
 *
 * @param db - SQLite database instance
 * @param service - Name of the service (e.g. "article-summary", "sentiment-analysis")
 * @param amountCents - Revenue amount in cents
 * @param currency - Currency code (default "USD")
 * @param customerHash - SHA-256 hash of customer IP for privacy
 * @returns The generated event ID
 */
export function recordRevenue(
  db: Database,
  service: string,
  amountCents: number,
  currency: string = "USD",
  customerHash: string,
): string {
  if (amountCents <= 0) throw new Error("Amount must be positive");
  if (!service) throw new Error("Service name is required");
  if (!customerHash) throw new Error("Customer hash is required");

  const id = ulid();
  db.prepare(
    `INSERT INTO revenue_tracking (id, service, amount_cents, currency, customer_hash, is_paid)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, service, amountCents, currency, customerHash);

  // Also record in service_usage for conversion tracking
  db.prepare(
    `INSERT INTO service_usage (id, service, customer_hash, is_paid)
     VALUES (?, ?, ?, 1)`,
  ).run(ulid(), service, customerHash);

  logger.info(`Revenue recorded: ${service} $${(amountCents / 100).toFixed(2)} ${currency}`);
  return id;
}

/**
 * Record a free-tier usage event (for conversion rate tracking).
 *
 * @param db - SQLite database instance
 * @param service - Name of the service
 * @param customerHash - SHA-256 hash of customer IP
 * @returns The generated event ID
 */
export function recordFreeUsage(
  db: Database,
  service: string,
  customerHash: string,
): string {
  if (!service) throw new Error("Service name is required");
  if (!customerHash) throw new Error("Customer hash is required");

  const id = ulid();
  db.prepare(
    `INSERT INTO service_usage (id, service, customer_hash, is_paid)
     VALUES (?, ?, ?, 0)`,
  ).run(id, service, customerHash);

  return id;
}

/**
 * Get total revenue for a specific date (YYYY-MM-DD format).
 * If no date provided, returns today's revenue.
 */
export function getDailyRevenue(db: Database, date?: string): DailyRevenue {
  const targetDate = date || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("Invalid date format. Use YYYY-MM-DD.");
  }

  const dayStart = `${targetDate} 00:00:00`;
  const nextDay = new Date(`${targetDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dayEnd = `${nextDay.toISOString().slice(0, 10)} 00:00:00`;

  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total, COUNT(*) as cnt
     FROM revenue_tracking
     WHERE created_at >= ? AND created_at < ?`,
  ).get(dayStart, dayEnd) as { total: number; cnt: number };

  return {
    date: targetDate,
    totalCents: row.total,
    totalUsd: row.total / 100,
    transactionCount: row.cnt,
  };
}

/**
 * Get revenue broken down by service for a given period.
 */
export function getServiceBreakdown(db: Database, period: Period = "month"): ServiceBreakdown[] {
  const periodStart = getPeriodStart(period);

  const rows = db.prepare(
    `SELECT
       service,
       COALESCE(SUM(amount_cents), 0) as total_cents,
       COUNT(*) as tx_count,
       COUNT(DISTINCT customer_hash) as unique_customers
     FROM revenue_tracking
     WHERE created_at >= ?
     GROUP BY service
     ORDER BY total_cents DESC`,
  ).all(periodStart) as Array<{
    service: string;
    total_cents: number;
    tx_count: number;
    unique_customers: number;
  }>;

  return rows.map((row) => ({
    service: row.service,
    totalCents: row.total_cents,
    totalUsd: row.total_cents / 100,
    transactionCount: row.tx_count,
    uniqueCustomers: row.unique_customers,
  }));
}

/**
 * Calculate the free-to-paid conversion rate for a service.
 * Counts unique customers who used free tier vs those who paid.
 */
export function getConversionRate(
  db: Database,
  service: string,
  period: Period = "month",
): ConversionMetrics {
  const periodStart = getPeriodStart(period);

  // Count unique customers who used the free tier
  const freeRow = db.prepare(
    `SELECT COUNT(DISTINCT customer_hash) as cnt
     FROM service_usage
     WHERE service = ? AND is_paid = 0 AND created_at >= ?`,
  ).get(service, periodStart) as { cnt: number };

  // Count unique customers who paid
  const paidRow = db.prepare(
    `SELECT COUNT(DISTINCT customer_hash) as cnt
     FROM service_usage
     WHERE service = ? AND is_paid = 1 AND created_at >= ?`,
  ).get(service, periodStart) as { cnt: number };

  const freeUsers = freeRow.cnt;
  const paidUsers = paidRow.cnt;

  // Total unique users = free-only + paid (paid users may also have free usage)
  const totalUniqueRow = db.prepare(
    `SELECT COUNT(DISTINCT customer_hash) as cnt
     FROM service_usage
     WHERE service = ? AND created_at >= ?`,
  ).get(service, periodStart) as { cnt: number };

  const totalUnique = totalUniqueRow.cnt;
  const conversionRate = totalUnique > 0 ? paidUsers / totalUnique : 0;

  return {
    service,
    freeUsers,
    paidUsers,
    conversionRate,
    period,
  };
}

/**
 * Get revenue totals for a given period.
 */
export function getPeriodRevenue(
  db: Database,
  period: Period = "month",
): { totalCents: number; totalUsd: number; transactionCount: number; uniqueCustomers: number } {
  const periodStart = getPeriodStart(period);

  const row = db.prepare(
    `SELECT
       COALESCE(SUM(amount_cents), 0) as total,
       COUNT(*) as cnt,
       COUNT(DISTINCT customer_hash) as unique_customers
     FROM revenue_tracking
     WHERE created_at >= ?`,
  ).get(periodStart) as { total: number; cnt: number; unique_customers: number };

  return {
    totalCents: row.total,
    totalUsd: row.total / 100,
    transactionCount: row.cnt,
    uniqueCustomers: row.unique_customers,
  };
}

/**
 * Generate a formatted text P&L report.
 * Combines revenue tracking data with expense data from expense_events.
 */
export function generateReport(db: Database): string {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Daily revenue
  const daily = getDailyRevenue(db, todayStr);

  // Weekly & monthly totals
  const weekly = getPeriodRevenue(db, "week");
  const monthly = getPeriodRevenue(db, "month");

  // Service breakdown (monthly)
  const services = getServiceBreakdown(db, "month");

  // Expenses from expense_events table (for P&L)
  const expDayStart = `${todayStr} 00:00:00`;
  const weekStart = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const monthStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const dailyExpRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
  ).get(expDayStart) as { total: number };

  const weeklyExpRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
  ).get(weekStart) as { total: number };

  const monthlyExpRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
  ).get(monthStart) as { total: number };

  // Conversion rates per service
  const conversionLines: string[] = [];
  for (const svc of services) {
    const conv = getConversionRate(db, svc.service, "month");
    conversionLines.push(
      `  ${svc.service}: ${(conv.conversionRate * 100).toFixed(1)}% ` +
      `(${conv.paidUsers} paid / ${conv.freeUsers + conv.paidUsers} total)`,
    );
  }

  // Format dollars
  const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

  const lines = [
    `═══════════════════════════════════════`,
    `  REVENUE & P&L REPORT — ${todayStr}`,
    `═══════════════════════════════════════`,
    ``,
    `── Revenue ────────────────────────────`,
    `  Today:  ${fmt(daily.totalCents)} (${daily.transactionCount} txns)`,
    `  Week:   ${fmt(weekly.totalCents)} (${weekly.transactionCount} txns, ${weekly.uniqueCustomers} customers)`,
    `  Month:  ${fmt(monthly.totalCents)} (${monthly.transactionCount} txns, ${monthly.uniqueCustomers} customers)`,
    ``,
    `── Expenses ───────────────────────────`,
    `  Today:  ${fmt(dailyExpRow.total)}`,
    `  Week:   ${fmt(weeklyExpRow.total)}`,
    `  Month:  ${fmt(monthlyExpRow.total)}`,
    ``,
    `── Net P&L ────────────────────────────`,
    `  Today:  ${fmt(daily.totalCents - dailyExpRow.total)}`,
    `  Week:   ${fmt(weekly.totalCents - weeklyExpRow.total)}`,
    `  Month:  ${fmt(monthly.totalCents - monthlyExpRow.total)}`,
    ``,
  ];

  if (services.length > 0) {
    lines.push(`── Service Breakdown (30d) ────────────`);
    for (const svc of services) {
      lines.push(
        `  ${svc.service}: ${fmt(svc.totalCents)} ` +
        `(${svc.transactionCount} txns, ${svc.uniqueCustomers} customers)`,
      );
    }
    lines.push(``);
  }

  if (conversionLines.length > 0) {
    lines.push(`── Conversion Rates (30d) ─────────────`);
    lines.push(...conversionLines);
    lines.push(``);
  }

  lines.push(`═══════════════════════════════════════`);

  return lines.join("\n");
}

// ── Skill Export ────────────────────────────────────────────────

/**
 * The Skill definition for the skills loader system.
 */
export const revenueTrackerSkill: Skill = {
  name: "revenue-tracker",
  description:
    "Tracks revenue events, calculates daily/weekly/monthly totals, " +
    "per-service breakdowns, conversion rates, and generates P&L reports.",
  autoActivate: true,
  instructions:
    "Use this skill to record revenue from paid API calls and track " +
    "free-tier usage for conversion analysis. Call generateReport() " +
    "for a full P&L summary. Record every paid call with recordRevenue() " +
    "and every free call with recordFreeUsage() to maintain accurate " +
    "conversion metrics.",
  source: "builtin",
  path: "src/skills/revenue-tracker.ts",
  enabled: true,
  installedAt: new Date().toISOString(),
};
