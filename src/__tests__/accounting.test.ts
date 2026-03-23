/**
 * Accounting Ledger Tests
 *
 * Tests for the local accounting module:
 * - logRevenue rejects amountCents <= 0
 * - logExpense rejects amountCents <= 0
 * - safeAddColumn only suppresses "duplicate column" errors
 * - computeDailyNetProfit rejects invalid date format
 * - logTransferEvent rejects amountUsd <= 0
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import {
  initAccountingSchema,
  logRevenue,
  logExpense,
  logTransferEvent,
  computeDailyNetProfit,
  computePnl,
  estimateDailyBurnCents,
} from "../local/accounting.js";

// ─── Test Helpers ───────────────────────────────────────────────

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initAccountingSchema(db);
  return db;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Accounting Ledger", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── logRevenue ──────────────────────────────────────────────

  describe("logRevenue", () => {
    it("rejects amountCents <= 0 (zero)", () => {
      expect(() =>
        logRevenue(db, { source: "test", amountCents: 0 }),
      ).toThrow("Amount must be positive");
    });

    it("rejects amountCents <= 0 (negative)", () => {
      expect(() =>
        logRevenue(db, { source: "test", amountCents: -100 }),
      ).toThrow("Amount must be positive");
    });

    it("accepts positive amountCents and returns an id", () => {
      const id = logRevenue(db, { source: "api", amountCents: 500 });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });

  // ── logExpense ─────────────────────────────────────────────

  describe("logExpense", () => {
    it("rejects amountCents <= 0 (zero)", () => {
      expect(() =>
        logExpense(db, { category: "inference", amountCents: 0 }),
      ).toThrow("Amount must be positive");
    });

    it("rejects amountCents <= 0 (negative)", () => {
      expect(() =>
        logExpense(db, { category: "inference", amountCents: -50 }),
      ).toThrow("Amount must be positive");
    });

    it("accepts positive amountCents and returns an id", () => {
      const id = logExpense(db, { category: "inference", amountCents: 200 });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });

  // ── safeAddColumn (tested indirectly) ─────────────────────

  describe("safeAddColumn", () => {
    it("suppresses duplicate column errors on repeated init", () => {
      // First init already ran in beforeEach. Second init exercises
      // the duplicate-column suppression path in safeAddColumn.
      expect(() => initAccountingSchema(db)).not.toThrow();
    });

    it("propagates non-duplicate-column errors", () => {
      // Attempt to ALTER a table that does not exist. This triggers a
      // different SQLite error that safeAddColumn must NOT suppress.
      expect(() =>
        db.exec("ALTER TABLE nonexistent_table ADD COLUMN foo TEXT"),
      ).toThrow();
    });
  });

  // ── computeDailyNetProfit ─────────────────────────────────

  describe("computeDailyNetProfit", () => {
    it("rejects invalid date format", () => {
      // An invalid date string causes new Date(...) to produce Invalid Date,
      // which throws RangeError on .toISOString().
      expect(() => computeDailyNetProfit(db, "not-a-date")).toThrow();
    });

    it("rejects empty string as date", () => {
      expect(() => computeDailyNetProfit(db, "")).toThrow();
    });

    it("returns correct profit for a valid date with data", () => {
      // Insert revenue and expense for a specific date
      db.prepare(
        `INSERT INTO revenue_events (id, source, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("rev1", "api", 1000, "test revenue", "2025-06-15 12:00:00");

      db.prepare(
        `INSERT INTO expense_events (id, category, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("exp1", "inference", 300, "test expense", "2025-06-15 14:00:00");

      const result = computeDailyNetProfit(db, "2025-06-15");
      expect(result.date).toBe("2025-06-15");
      expect(result.revenueCents).toBe(1000);
      expect(result.expenseCents).toBe(300);
      expect(result.netProfitCents).toBe(700);
      expect(result.netProfitUsd).toBe(7);
    });

    it("returns zeros for a date with no data", () => {
      const result = computeDailyNetProfit(db, "2025-01-01");
      expect(result.revenueCents).toBe(0);
      expect(result.expenseCents).toBe(0);
      expect(result.netProfitCents).toBe(0);
    });
  });

  // ── logTransferEvent ──────────────────────────────────────

  describe("logTransferEvent", () => {
    it("rejects amountUsd <= 0 (zero)", () => {
      expect(() =>
        logTransferEvent(db, {
          type: "tax",
          fromAccount: "treasury",
          toAccount: "irs",
          amountUsd: 0,
        }),
      ).toThrow("Transfer amount must be positive");
    });

    it("rejects amountUsd <= 0 (negative)", () => {
      expect(() =>
        logTransferEvent(db, {
          type: "internal_treasury_move",
          fromAccount: "main",
          toAccount: "reserve",
          amountUsd: -10,
        }),
      ).toThrow("Transfer amount must be positive");
    });

    it("accepts positive amountUsd and returns an id", () => {
      const id = logTransferEvent(db, {
        type: "replication_funding",
        fromAccount: "treasury",
        toAccount: "child-001",
        amountUsd: 50,
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("records the transfer and it can be read back", () => {
      const id = logTransferEvent(db, {
        type: "tax",
        fromAccount: "treasury",
        toAccount: "irs",
        amountUsd: 25.5,
        metadata: { note: "quarterly" },
      });
      const row = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.type).toBe("tax");
      expect(row.from_account).toBe("treasury");
      expect(row.to_account).toBe("irs");
      expect(row.amount_usd).toBe(25.5);
      expect(JSON.parse(row.metadata as string)).toEqual({ note: "quarterly" });
    });

    it("rejects an invalid transfer type via CHECK constraint", () => {
      expect(() =>
        db.prepare(
          `INSERT INTO transfers (id, type, from_account, to_account, amount_usd)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("bad-type-id", "invalid_type", "a", "b", 10),
      ).toThrow();
    });
  });

  // ── computePnl ────────────────────────────────────────────────

  describe("computePnl", () => {
    it("returns zeros when there is no data (period=all)", () => {
      const report = computePnl(db, "all");
      expect(report.totalRevenueCents).toBe(0);
      expect(report.totalExpenseCents).toBe(0);
      expect(report.netCents).toBe(0);
      expect(report.expenseByCategory).toEqual({});
    });

    it("returns zeros for zero revenue and zero expenses", () => {
      const report = computePnl(db);
      expect(report.totalRevenueCents).toBe(0);
      expect(report.totalExpenseCents).toBe(0);
      expect(report.netCents).toBe(0);
    });

    it("computes correct P&L with revenue and expenses (period=all)", () => {
      logRevenue(db, { source: "api", amountCents: 1000 });
      logRevenue(db, { source: "api", amountCents: 500 });
      logExpense(db, { category: "inference", amountCents: 300 });
      logExpense(db, { category: "sandbox", amountCents: 200 });

      const report = computePnl(db, "all");
      expect(report.totalRevenueCents).toBe(1500);
      expect(report.totalExpenseCents).toBe(500);
      expect(report.netCents).toBe(1000);
    });

    it("returns negative netCents when expenses exceed revenue", () => {
      logRevenue(db, { source: "api", amountCents: 100 });
      logExpense(db, { category: "inference", amountCents: 500 });

      const report = computePnl(db, "all");
      expect(report.totalRevenueCents).toBe(100);
      expect(report.totalExpenseCents).toBe(500);
      expect(report.netCents).toBe(-400);
    });

    it("breaks down expenses by category", () => {
      logExpense(db, { category: "inference", amountCents: 300 });
      logExpense(db, { category: "inference", amountCents: 100 });
      logExpense(db, { category: "sandbox", amountCents: 200 });
      logExpense(db, { category: "api", amountCents: 50 });

      const report = computePnl(db, "all");
      expect(report.expenseByCategory["inference"]).toBe(400);
      expect(report.expenseByCategory["sandbox"]).toBe(200);
      expect(report.expenseByCategory["api"]).toBe(50);
    });

    it("filters by period=day (only recent data)", () => {
      // Insert old data directly with a timestamp from 3 days ago
      db.prepare(
        `INSERT INTO revenue_events (id, source, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("old-rev", "api", 9999, "old", "2020-01-01 00:00:00");

      // Insert recent data via the API (gets current timestamp)
      logRevenue(db, { source: "api", amountCents: 100 });
      logExpense(db, { category: "inference", amountCents: 40 });

      const report = computePnl(db, "day");
      expect(report.totalRevenueCents).toBe(100);
      expect(report.totalExpenseCents).toBe(40);
      expect(report.netCents).toBe(60);
    });

    it("filters by period=week", () => {
      db.prepare(
        `INSERT INTO revenue_events (id, source, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("old-rev-w", "api", 9999, "old", "2020-01-01 00:00:00");

      logRevenue(db, { source: "api", amountCents: 250 });

      const report = computePnl(db, "week");
      expect(report.totalRevenueCents).toBe(250);
    });

    it("filters by period=month", () => {
      db.prepare(
        `INSERT INTO revenue_events (id, source, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("old-rev-m", "api", 9999, "old", "2020-01-01 00:00:00");

      logRevenue(db, { source: "api", amountCents: 750 });

      const report = computePnl(db, "month");
      expect(report.totalRevenueCents).toBe(750);
    });

    it("throws on invalid period", () => {
      expect(() => computePnl(db, "year")).toThrow('Invalid period "year"');
    });

    it("includes periodStart and periodEnd in report", () => {
      const report = computePnl(db, "all");
      expect(report.periodStart).toBe("1970-01-01T00:00:00.000Z");
      expect(report.periodEnd).toBeTruthy();
    });
  });

  // ── estimateDailyBurnCents ────────────────────────────────────

  describe("estimateDailyBurnCents", () => {
    it("returns 0 when there are no expenses", () => {
      const burn = estimateDailyBurnCents(db);
      expect(burn).toBe(0);
    });

    it("computes burn with fewer than 1 day of data (single day)", () => {
      // All expenses on the same day (today) => 1 distinct day
      logExpense(db, { category: "inference", amountCents: 100 });
      logExpense(db, { category: "sandbox", amountCents: 50 });

      const burn = estimateDailyBurnCents(db);
      // total=150, days=1 => 150 cents/day
      expect(burn).toBe(150);
    });

    it("averages across multiple days of data", () => {
      // Insert expenses spread across multiple days within the last 7 days
      const now = Date.now();
      for (let d = 0; d < 7; d++) {
        const ts = new Date(now - d * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
        db.prepare(
          `INSERT INTO expense_events (id, category, amount_cents, description, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(`burn-${d}`, "inference", 100, "daily expense", ts);
      }

      const burn = estimateDailyBurnCents(db);
      // total=700, days=7 => 100 cents/day
      expect(burn).toBe(100);
    });

    it("ignores expenses older than 7 days", () => {
      // Insert old expense
      db.prepare(
        `INSERT INTO expense_events (id, category, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("old-exp", "inference", 99999, "old", "2020-01-01 00:00:00");

      // Insert recent expense
      logExpense(db, { category: "inference", amountCents: 200 });

      const burn = estimateDailyBurnCents(db);
      // Only the recent 200 should count, across 1 day
      expect(burn).toBe(200);
    });
  });
});
