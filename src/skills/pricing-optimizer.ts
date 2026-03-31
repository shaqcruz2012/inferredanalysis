/**
 * Pricing Optimizer Skill
 *
 * Tracks conversion rates at different price points, supports A/B cohort
 * testing, calculates optimal price (revenue = price × conversion_rate),
 * and generates pricing recommendations.
 *
 * Revenue nexus: directly optimises the $ per request across all services.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { Skill } from "../types.js";

const logger = createLogger("pricing-optimizer");

// ─── Schema ───────────────────────────────────────────────────

export function initPricingDb(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_events (
      id            TEXT PRIMARY KEY,
      service       TEXT NOT NULL,
      price_cents   INTEGER NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'USD',
      converted     INTEGER NOT NULL DEFAULT 0,
      cohort        TEXT,
      customer_hash TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pe_service   ON pricing_events(service);
    CREATE INDEX IF NOT EXISTS idx_pe_created   ON pricing_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_pe_cohort    ON pricing_events(cohort);

    CREATE TABLE IF NOT EXISTS competitor_prices (
      id            TEXT PRIMARY KEY,
      competitor    TEXT NOT NULL,
      service       TEXT NOT NULL,
      price_cents   INTEGER NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'USD',
      recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cp_service ON competitor_prices(service);
  `);
}

// ─── Core Functions ───────────────────────────────────────────

export function recordConversion(
  db: BetterSqlite3.Database,
  service: string,
  priceCents: number,
  converted: boolean,
  customerHash?: string,
  cohort?: string,
): void {
  initPricingDb(db);
  const stmt = db.prepare(`
    INSERT INTO pricing_events (id, service, price_cents, converted, customer_hash, cohort)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(ulid(), service, priceCents, converted ? 1 : 0, customerHash ?? null, cohort ?? null);
}

export function getConversionByPrice(
  db: BetterSqlite3.Database,
  service: string,
): { priceCents: number; conversionRate: number; estimatedRevenueCents: number; sampleSize: number }[] {
  initPricingDb(db);
  const rows = db.prepare(`
    SELECT
      price_cents,
      COUNT(*)                           AS total,
      SUM(converted)                     AS conversions
    FROM pricing_events
    WHERE service = ?
    GROUP BY price_cents
    ORDER BY price_cents ASC
  `).all(service) as { price_cents: number; total: number; conversions: number }[];

  return rows.map((r) => {
    const rate = r.total > 0 ? r.conversions / r.total : 0;
    return {
      priceCents: r.price_cents,
      conversionRate: rate,
      estimatedRevenueCents: Math.round(r.price_cents * rate * r.total),
      sampleSize: r.total,
    };
  });
}

export function getOptimalPrice(
  db: BetterSqlite3.Database,
  service: string,
): { priceCents: number; expectedRevenueCents: number; confidence: "low" | "medium" | "high" } {
  const breakdown = getConversionByPrice(db, service);
  if (breakdown.length === 0) {
    return { priceCents: 0, expectedRevenueCents: 0, confidence: "low" };
  }

  let best = breakdown[0];
  for (const b of breakdown) {
    if (b.estimatedRevenueCents > best.estimatedRevenueCents) {
      best = b;
    }
  }

  const totalSamples = breakdown.reduce((s, b) => s + b.sampleSize, 0);
  const confidence: "low" | "medium" | "high" =
    totalSamples < 50 ? "low" : totalSamples < 500 ? "medium" : "high";

  return {
    priceCents: best.priceCents,
    expectedRevenueCents: best.estimatedRevenueCents,
    confidence,
  };
}

export function recordCompetitorPrice(
  db: BetterSqlite3.Database,
  competitor: string,
  service: string,
  priceCents: number,
  currency = "USD",
): void {
  initPricingDb(db);
  db.prepare(`
    INSERT INTO competitor_prices (id, competitor, service, price_cents, currency)
    VALUES (?, ?, ?, ?, ?)
  `).run(ulid(), competitor, service, priceCents, currency);
}

export function getCompetitorPrices(
  db: BetterSqlite3.Database,
  service: string,
): { competitor: string; priceCents: number; currency: string; recordedAt: string }[] {
  initPricingDb(db);
  const rows = db.prepare(`
    SELECT competitor, price_cents, currency, recorded_at
    FROM competitor_prices
    WHERE service = ?
    ORDER BY recorded_at DESC
  `).all(service) as { competitor: string; price_cents: number; currency: string; recorded_at: string }[];

  return rows.map((r) => ({
    competitor: r.competitor,
    priceCents: r.price_cents,
    currency: r.currency,
    recordedAt: r.recorded_at,
  }));
}

export function generatePricingReport(db: BetterSqlite3.Database): string {
  initPricingDb(db);
  const services = db.prepare(`
    SELECT DISTINCT service FROM pricing_events
  `).all() as { service: string }[];

  if (services.length === 0) {
    return "No pricing data collected yet.";
  }

  const lines: string[] = ["═══ PRICING OPTIMIZATION REPORT ═══", ""];

  for (const { service } of services) {
    lines.push(`── ${service} ──`);
    const breakdown = getConversionByPrice(db, service);
    const optimal = getOptimalPrice(db, service);

    for (const b of breakdown) {
      lines.push(
        `  $${(b.priceCents / 100).toFixed(2)} → ${(b.conversionRate * 100).toFixed(1)}% conversion (n=${b.sampleSize}) → est. rev $${(b.estimatedRevenueCents / 100).toFixed(2)}`,
      );
    }

    lines.push(
      `  ★ Optimal: $${(optimal.priceCents / 100).toFixed(2)} (confidence: ${optimal.confidence})`,
    );

    const competitors = getCompetitorPrices(db, service);
    if (competitors.length > 0) {
      lines.push("  Competitors:");
      for (const c of competitors.slice(0, 5)) {
        lines.push(`    ${c.competitor}: $${(c.priceCents / 100).toFixed(2)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Skill Export ─────────────────────────────────────────────

export const pricingOptimizerSkill: Skill = {
  name: "pricing-optimizer",
  description: "Track conversion rates at different price points and calculate optimal pricing",
  instructions:
    "Use this skill to record conversion events, A/B test pricing, track competitor prices, and generate pricing recommendations.",
  source: "builtin",
  autoActivate: true,
};
