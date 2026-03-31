/**
 * Pricing Optimizer Skill
 *
 * Analyzes conversion data at each price point, suggests pricing
 * adjustments, supports A/B testing, and tracks competitor rates.
 *
 * Revenue nexus: directly optimizes pricing to maximize revenue
 * per the revenue-first doctrine ("price to fill, not to maximize margin").
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { Skill } from "../types.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skills.pricing-optimizer");

// ── Types ────────────────────────────────────────────────────────

export interface PricePoint {
  readonly service: string;
  readonly priceCents: number;
  readonly conversionRate: number;
  readonly sampleSize: number;
  readonly recordedAt: string;
}

export interface PricingSuggestion {
  readonly service: string;
  readonly currentPriceCents: number;
  readonly suggestedPriceCents: number;
  readonly reason: string;
  readonly conversionRate: number;
}

export interface ABTest {
  readonly id: string;
  readonly service: string;
  readonly priceACents: number;
  readonly priceBCents: number;
  readonly startedAt: string;
  readonly endsAt: string;
  readonly status: "running" | "completed" | "cancelled";
  readonly winnerPrice: number | null;
}

export interface CompetitorPrice {
  readonly competitor: string;
  readonly service: string;
  readonly priceCents: number;
  readonly source: string;
  readonly recordedAt: string;
}

// ── Schema ───────────────────────────────────────────────────────

const PRICING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pricing_history (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    conversion_rate REAL NOT NULL DEFAULT 0,
    sample_size INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pricing_ab_tests (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    price_a_cents INTEGER NOT NULL,
    price_b_cents INTEGER NOT NULL,
    conversions_a INTEGER NOT NULL DEFAULT 0,
    impressions_a INTEGER NOT NULL DEFAULT 0,
    conversions_b INTEGER NOT NULL DEFAULT 0,
    impressions_b INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'cancelled')),
    winner_price INTEGER
  );

  CREATE TABLE IF NOT EXISTS competitor_prices (
    id TEXT PRIMARY KEY,
    competitor TEXT NOT NULL,
    service TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pricing_history_service ON pricing_history(service, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pricing_ab_service ON pricing_ab_tests(service, status);
  CREATE INDEX IF NOT EXISTS idx_competitor_service ON competitor_prices(service, recorded_at DESC);
`;

/**
 * Initialize the pricing optimizer schema.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function ensurePricingSchema(db: Database): void {
  db.exec(PRICING_SCHEMA);
}

// ── Core Functions ───────────────────────────────────────────────

/** Target conversion rate range */
const MIN_HEALTHY_CONVERSION = 0.05; // 5%
const MAX_HEALTHY_CONVERSION = 0.30; // 30%
const MAX_PRICE_INCREASE_RATIO = 1.20; // never raise more than 20%
const AB_TEST_MIN_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Record a price point observation (conversion rate at a given price).
 */
export function recordPricePoint(
  db: Database,
  service: string,
  priceCents: number,
  conversionRate: number,
  sampleSize: number,
): string {
  ensurePricingSchema(db);
  const id = ulid();
  db.prepare(
    `INSERT INTO pricing_history (id, service, price_cents, conversion_rate, sample_size)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, service, priceCents, conversionRate, sampleSize);
  logger.info(`Price point recorded: ${service} @ $${(priceCents / 100).toFixed(2)} → ${(conversionRate * 100).toFixed(1)}% conversion`);
  return id;
}

/**
 * Get pricing history for a service.
 */
export function getPricingHistory(
  db: Database,
  service: string,
  limit: number = 20,
): PricePoint[] {
  ensurePricingSchema(db);
  const rows = db.prepare(
    `SELECT service, price_cents, conversion_rate, sample_size, recorded_at
     FROM pricing_history
     WHERE service = ?
     ORDER BY recorded_at DESC
     LIMIT ?`,
  ).all(service, limit) as Array<{
    service: string;
    price_cents: number;
    conversion_rate: number;
    sample_size: number;
    recorded_at: string;
  }>;

  return rows.map((r) => ({
    service: r.service,
    priceCents: r.price_cents,
    conversionRate: r.conversion_rate,
    sampleSize: r.sample_size,
    recordedAt: r.recorded_at,
  }));
}

/**
 * Analyze current pricing and suggest adjustments.
 * Returns suggestions for services where conversion is outside healthy range.
 */
export function analyzePricing(db: Database): PricingSuggestion[] {
  ensurePricingSchema(db);

  // Get latest price point per service
  const services = db.prepare(
    `SELECT ph.service, ph.price_cents, ph.conversion_rate
     FROM pricing_history ph
     INNER JOIN (
       SELECT service, MAX(recorded_at) as max_at
       FROM pricing_history
       GROUP BY service
     ) latest ON ph.service = latest.service AND ph.recorded_at = latest.max_at`,
  ).all() as Array<{ service: string; price_cents: number; conversion_rate: number }>;

  const suggestions: PricingSuggestion[] = [];

  for (const svc of services) {
    if (svc.conversion_rate < MIN_HEALTHY_CONVERSION) {
      // Conversion too low — suggest price decrease
      const suggested = Math.max(1, Math.round(svc.price_cents * 0.7));
      suggestions.push({
        service: svc.service,
        currentPriceCents: svc.price_cents,
        suggestedPriceCents: suggested,
        reason: `Conversion rate ${(svc.conversion_rate * 100).toFixed(1)}% is below ${(MIN_HEALTHY_CONVERSION * 100).toFixed(0)}% threshold — reduce price to increase volume`,
        conversionRate: svc.conversion_rate,
      });
    } else if (svc.conversion_rate > MAX_HEALTHY_CONVERSION) {
      // Conversion very high — might be leaving money on the table
      const suggested = Math.round(
        Math.min(svc.price_cents * MAX_PRICE_INCREASE_RATIO, svc.price_cents + 25),
      );
      suggestions.push({
        service: svc.service,
        currentPriceCents: svc.price_cents,
        suggestedPriceCents: suggested,
        reason: `Conversion rate ${(svc.conversion_rate * 100).toFixed(1)}% is above ${(MAX_HEALTHY_CONVERSION * 100).toFixed(0)}% — room to raise price (max +20%)`,
        conversionRate: svc.conversion_rate,
      });
    }
  }

  return suggestions;
}

/**
 * Start an A/B price test for a service.
 */
export function startABTest(
  db: Database,
  service: string,
  priceACents: number,
  priceBCents: number,
  durationMs: number = AB_TEST_MIN_DURATION_MS,
): string {
  ensurePricingSchema(db);

  if (durationMs < AB_TEST_MIN_DURATION_MS) {
    durationMs = AB_TEST_MIN_DURATION_MS;
  }

  const id = ulid();
  const endsAt = new Date(Date.now() + durationMs).toISOString();

  db.prepare(
    `INSERT INTO pricing_ab_tests (id, service, price_a_cents, price_b_cents, ends_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, service, priceACents, priceBCents, endsAt);

  logger.info(`A/B test started: ${service} $${(priceACents / 100).toFixed(2)} vs $${(priceBCents / 100).toFixed(2)}`);
  return id;
}

/**
 * Get active A/B tests.
 */
export function getActiveABTests(db: Database): ABTest[] {
  ensurePricingSchema(db);
  const rows = db.prepare(
    `SELECT id, service, price_a_cents, price_b_cents, started_at, ends_at, status, winner_price
     FROM pricing_ab_tests
     WHERE status = 'running'
     ORDER BY started_at DESC`,
  ).all() as Array<{
    id: string;
    service: string;
    price_a_cents: number;
    price_b_cents: number;
    started_at: string;
    ends_at: string;
    status: "running" | "completed" | "cancelled";
    winner_price: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    priceACents: r.price_a_cents,
    priceBCents: r.price_b_cents,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    status: r.status,
    winnerPrice: r.winner_price,
  }));
}

/**
 * Record a competitor price observation.
 */
export function recordCompetitorPrice(
  db: Database,
  competitor: string,
  service: string,
  priceCents: number,
  source: string = "manual",
): string {
  ensurePricingSchema(db);
  const id = ulid();
  db.prepare(
    `INSERT INTO competitor_prices (id, competitor, service, price_cents, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, competitor, service, priceCents, source);
  return id;
}

/**
 * Get competitor prices for a service.
 */
export function getCompetitorPrices(
  db: Database,
  service: string,
): CompetitorPrice[] {
  ensurePricingSchema(db);
  const rows = db.prepare(
    `SELECT competitor, service, price_cents, source, recorded_at
     FROM competitor_prices
     WHERE service = ?
     ORDER BY recorded_at DESC`,
  ).all(service) as Array<{
    competitor: string;
    service: string;
    price_cents: number;
    source: string;
    recorded_at: string;
  }>;

  return rows.map((r) => ({
    competitor: r.competitor,
    service: r.service,
    priceCents: r.price_cents,
    source: r.source,
    recordedAt: r.recorded_at,
  }));
}

/**
 * Generate a pricing analysis report.
 */
export function generatePricingReport(db: Database): string {
  ensurePricingSchema(db);

  const suggestions = analyzePricing(db);
  const abTests = getActiveABTests(db);

  const lines: string[] = [
    "═══ Pricing Analysis Report ═══",
    "",
  ];

  // Current pricing
  const services = db.prepare(
    `SELECT DISTINCT service FROM pricing_history ORDER BY service`,
  ).all() as Array<{ service: string }>;

  if (services.length === 0) {
    lines.push("No pricing data recorded yet.");
    return lines.join("\n");
  }

  lines.push("── Current Prices ──");
  for (const { service } of services) {
    const latest = getPricingHistory(db, service, 1);
    if (latest.length > 0) {
      const p = latest[0];
      lines.push(
        `  ${service}: $${(p.priceCents / 100).toFixed(2)}/call, ${(p.conversionRate * 100).toFixed(1)}% conversion (n=${p.sampleSize})`,
      );
    }
  }
  lines.push("");

  // Suggestions
  if (suggestions.length > 0) {
    lines.push("── Suggestions ──");
    for (const s of suggestions) {
      lines.push(
        `  ${s.service}: $${(s.currentPriceCents / 100).toFixed(2)} → $${(s.suggestedPriceCents / 100).toFixed(2)} — ${s.reason}`,
      );
    }
    lines.push("");
  }

  // Active A/B tests
  if (abTests.length > 0) {
    lines.push("── Active A/B Tests ──");
    for (const t of abTests) {
      lines.push(
        `  ${t.service}: $${(t.priceACents / 100).toFixed(2)} vs $${(t.priceBCents / 100).toFixed(2)} (ends ${t.endsAt})`,
      );
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════");
  return lines.join("\n");
}

// ── Skill Export ────────────────────────────────────────────────

export const pricingOptimizerSkill: Skill = {
  name: "pricing-optimizer",
  description:
    "Analyzes conversion rates at each price point, suggests pricing adjustments, " +
    "supports A/B testing, and tracks competitor rates. Revenue nexus: price to fill, not to maximize margin.",
  autoActivate: true,
  instructions: [
    "Use this skill to optimize pricing for revenue-generating services.",
    "",
    "Available functions:",
    "- recordPricePoint(db, service, priceCents, conversionRate, sampleSize): Record a price observation",
    "- analyzePricing(db): Analyze all services and get pricing suggestions",
    "- startABTest(db, service, priceACents, priceBCents): Start a 48h+ A/B price test",
    "- getActiveABTests(db): List running A/B tests",
    "- recordCompetitorPrice(db, competitor, service, priceCents): Record a competitor's price",
    "- getCompetitorPrices(db, service): Get competitor prices for a service",
    "- generatePricingReport(db): Generate a full pricing analysis report",
    "",
    "Pricing rules:",
    "- Suggest decrease when conversion < 5%",
    "- Suggest increase when conversion > 30% (max +20% per adjustment)",
    "- Target 30-50% below competitor rates",
    "- A/B tests run minimum 48 hours before declaring winner",
  ].join("\n"),
  source: "builtin",
  path: "src/skills/pricing-optimizer.ts",
  enabled: true,
  installedAt: new Date().toISOString(),
};
