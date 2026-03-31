/**
 * Deployment Skills - Barrel File
 *
 * Imports and re-exports all deployment/monitoring skills.
 * Each skill module exports its own Skill metadata object;
 * this barrel collects them into a single loadDeploymentSkills()
 * function that returns an array compatible with the existing loader.
 *
 * Skills without a built-in Skill export get one synthesized here
 * from their module's public API surface.
 */

import type { Skill } from "../types.js";

// ─── Skill Module Imports ────────────────────────────────────────
// Each module provides domain functions + a Skill metadata export.

import { revenueTrackerSkill } from "./revenue-tracker.js";
import { serviceHealthSkill } from "./service-health.js";
import { SKILL_METADATA as deployManagerSkill } from "./deploy-manager.js";
import { SKILL_METADATA as alertingSkill } from "./alerting.js";
import { pricingOptimizerSkill } from "./pricing-optimizer.js";

// ─── Re-exports (public API surface for each skill) ─────────────

export {
  // revenue-tracker
  revenueTrackerSkill,
  recordRevenue,
  recordFreeUsage,
  getDailyRevenue,
  getServiceBreakdown,
  getConversionRate,
  getPeriodRevenue,
  generateReport as generateRevenueReport,
} from "./revenue-tracker.js";

export {
  // service-health
  serviceHealthSkill,
  checkHealth,
  checkAllServices,
  getUptime,
  getAlerts as getHealthAlerts,
  getStatusDashboard,
  initHealthDb,
} from "./service-health.js";

export type { ServiceConfig, HealthCheckResult, HealthReport } from "./service-health.js";

export {
  // deploy-manager
  SKILL_METADATA as deployManagerSkill,
  DeployManager,
} from "./deploy-manager.js";

export {
  // alerting
  SKILL_METADATA as alertingSkill,
  AlertingManager,
} from "./alerting.js";

export {
  // auto-scaler
  initAutoScalerSchema,
  recordRequest,
  getTrafficStats,
  detectAnomalies,
  getScalingRecommendation,
  getResourceUtilization,
  generateTrafficReport,
  pruneOldRecords,
} from "./auto-scaler.js";

export {
  // pricing-optimizer
  pricingOptimizerSkill,
  ensurePricingSchema,
  recordPricePoint,
  getPricingHistory,
  analyzePricing,
  startABTest,
  getActiveABTests,
  recordCompetitorPrice,
  getCompetitorPrices,
  generatePricingReport,
} from "./pricing-optimizer.js";

export {
  // customer-tracker
  ensureCustomerTrackerSchema,
  recordCustomerActivity,
  getCustomerSegments,
  getCustomerJourney,
  getChurnRisk,
  getCLV,
  generateCustomerReport,
} from "./customer-tracker.js";

export {
  // log-aggregator
  ensureLogAggregatorSchema,
  log as aggregateLog,
  query as queryLogs,
  getErrorSummary,
  getRecentLogs,
  generateLogReport,
} from "./log-aggregator.js";

// ─── Skill Categories ──────────────────────────────────────────

export type DeploymentSkillCategory = "deployment" | "monitoring" | "revenue" | "analytics";

// ─── Synthesized Skills ─────────────────────────────────────────
// Skills whose modules don't export a Skill object get one here.

const autoScalerSkill: Skill = {
  name: "auto-scaler",
  description:
    "[deployment] Auto-scale inference resources based on request load, " +
    "traffic spikes, and queue depth. Revenue nexus: keeps APIs alive under load.",
  autoActivate: true,
  instructions: [
    "Use this skill to monitor traffic and get scaling recommendations.",
    "",
    "Available functions:",
    "- recordRequest(db, service, latencyMs, statusCode, error?): Record an incoming request",
    "- getTrafficStats(db, service, windowMinutes): Get RPM, RPS, latency, error rate",
    "- detectAnomalies(db, service): Detect traffic spikes vs baseline",
    "- getScalingRecommendation(db, service): Get scale-up/down/hold recommendation with reason",
    "- getResourceUtilization(db, service): Estimate CPU/memory/connection usage",
    "- generateTrafficReport(db): Generate a full traffic report across all services",
    "- pruneOldRecords(db): Clean up old request records (call periodically)",
  ].join("\n"),
  source: "builtin",
  path: "src/skills/auto-scaler.ts",
  enabled: true,
  installedAt: new Date().toISOString(),
};

const customerTrackerSkill: Skill = {
  name: "customer-tracker",
  description:
    "[analytics] Track customer lifecycle from free through paid, " +
    "calculate CLV, identify churn risk, and report on usage patterns.",
  autoActivate: true,
  instructions: [
    "Use this skill to monitor customer engagement and conversion.",
    "",
    "Available functions:",
    "- recordCustomerActivity(db, customerHash, service, action, paid, amountCents): Record activity",
    "- getCustomerSegments(db): Get customers grouped by segment (free/trial/paid/churned)",
    "- getCustomerJourney(db, customerHash): Get full activity history for a customer",
    "- getChurnRisk(db): Identify customers at risk of churning (sorted by risk score)",
    "- getCLV(db, segment?): Calculate customer lifetime value statistics",
    "- generateCustomerReport(db): Generate a full customer analytics report",
  ].join("\n"),
  source: "builtin",
  path: "src/skills/customer-tracker.ts",
  enabled: true,
  installedAt: new Date().toISOString(),
};

const logAggregatorSkill: Skill = {
  name: "log-aggregator",
  description:
    "[analytics] Aggregate, search, and analyze logs across all services. " +
    "Detects error patterns and generates log summaries.",
  autoActivate: true,
  instructions: [
    "Use this skill for centralized log collection and analysis.",
    "",
    "Available functions:",
    "- log(db, service, level, message, metadata?): Store a structured log entry",
    "- query(db, opts): Search logs by service, level, message pattern, or time range",
    "- getErrorSummary(db, since): Get error counts grouped by service and message",
    "- getRecentLogs(db, limit?): Get the most recent log entries",
    "- generateLogReport(db, period): Generate a log volume and error rate report",
  ].join("\n"),
  source: "builtin",
  path: "src/skills/log-aggregator.ts",
  enabled: true,
  installedAt: new Date().toISOString(),
};

// ─── Loader Function ──────────────────────────────────────────

/**
 * Load all deployment/monitoring skills as Skill objects.
 * Returns an array compatible with the existing skill loader output.
 *
 * These skills use source "builtin" and are auto-activated by default.
 * They can be passed directly to the agent loop alongside
 * SKILL.md-loaded skills from loadSkills().
 */
export function loadDeploymentSkills(): Skill[] {
  return [
    // Revenue skills
    revenueTrackerSkill,
    pricingOptimizerSkill,

    // Monitoring skills
    serviceHealthSkill,
    alertingSkill,

    // Deployment skills
    deployManagerSkill,
    autoScalerSkill,

    // Analytics skills
    customerTrackerSkill,
    logAggregatorSkill,
  ];
}
