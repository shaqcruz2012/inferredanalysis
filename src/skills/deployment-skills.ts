/**
 * Deployment Skills - Barrel File
 *
 * Imports and re-exports all deployment/monitoring skills as
 * programmatic Skill objects compatible with the existing loader.
 *
 * These skills are registered with source "self" (automaton-authored)
 * and can be injected into the skills array alongside SKILL.md-loaded skills.
 */

import type { Skill } from "../types.js";

// ─── Skill Categories ──────────────────────────────────────────

type DeploymentSkillCategory = "deployment" | "monitoring" | "revenue" | "analytics";

interface DeploymentSkillDef {
  name: string;
  description: string;
  category: DeploymentSkillCategory;
  instructions: string;
}

// ─── Skill Definitions ────────────────────────────────────────

const DEPLOYMENT_SKILL_DEFS: DeploymentSkillDef[] = [
  {
    name: "revenue-tracker",
    description: "Track daily revenue, expenses, net P&L, and conversion rates",
    category: "revenue",
    instructions: [
      "## Revenue Tracker",
      "",
      "Track and report on revenue metrics.",
      "",
      "### Commands",
      "- `revenue:summary` — Show daily revenue summary (gross $, expenses, net P&L)",
      "- `revenue:conversion` — Show free-to-paid conversion rate",
      "- `revenue:trend` — Show revenue trend over last 7 days",
      "- `revenue:customers` — Show unique customers served today",
      "",
      "### Behavior",
      "- Reads from the spend_tracker and payment tables in the database",
      "- Calculates gross revenue from completed payments",
      "- Calculates expenses from inference token costs",
      "- Reports net P&L = revenue - expenses",
      "- Tracks unique IPs for customer count",
      "- Monitors free-to-paid conversion rate",
    ].join("\n"),
  },
  {
    name: "service-health",
    description: "Monitor API endpoint health, uptime, and response latency",
    category: "monitoring",
    instructions: [
      "## Service Health Monitor",
      "",
      "Monitor the health of all API endpoints.",
      "",
      "### Commands",
      "- `health:check` — Run health checks on all registered endpoints",
      "- `health:status` — Show current status of all services",
      "- `health:latency` — Show p50/p95/p99 response latency",
      "- `health:uptime` — Show uptime percentage over last 24h",
      "",
      "### Behavior",
      "- Pings each registered endpoint with a lightweight request",
      "- Records response time and HTTP status code",
      "- Flags endpoints with >500ms p95 latency",
      "- Flags endpoints with <99.5% uptime",
      "- Triggers alert if any endpoint is down",
    ].join("\n"),
  },
  {
    name: "deploy-manager",
    description: "Manage deployments, rollbacks, and blue-green switches",
    category: "deployment",
    instructions: [
      "## Deploy Manager",
      "",
      "Handle deployment lifecycle for the automaton's services.",
      "",
      "### Commands",
      "- `deploy:status` — Show current deployment status",
      "- `deploy:promote` — Promote staging to production",
      "- `deploy:rollback` — Roll back to the previous deployment",
      "- `deploy:history` — Show deployment history",
      "",
      "### Behavior",
      "- Tracks current and previous deployment versions",
      "- Supports blue-green deployment switching",
      "- Validates health checks pass before promotion",
      "- Keeps last 5 deployments for rollback",
      "- Logs all deployment actions with timestamps",
    ].join("\n"),
  },
  {
    name: "alerting",
    description: "Configure and dispatch alerts for service issues and revenue drops",
    category: "monitoring",
    instructions: [
      "## Alerting System",
      "",
      "Configure alert rules and dispatch notifications.",
      "",
      "### Commands",
      "- `alert:list` — List all configured alert rules",
      "- `alert:add <condition> <action>` — Add a new alert rule",
      "- `alert:remove <id>` — Remove an alert rule",
      "- `alert:history` — Show recent alert firings",
      "- `alert:test <id>` — Test-fire an alert",
      "",
      "### Behavior",
      "- Evaluates alert conditions on each heartbeat cycle",
      "- Built-in conditions: endpoint_down, high_latency, revenue_drop, error_spike",
      "- Actions: log, webhook, social_post",
      "- Deduplicates alerts with a 15-minute cooldown per rule",
      "- Escalates if an alert fires 3+ times in 1 hour",
    ].join("\n"),
  },
  {
    name: "auto-scaler",
    description: "Auto-scale inference resources based on request load and queue depth",
    category: "deployment",
    instructions: [
      "## Auto-Scaler",
      "",
      "Automatically adjust resource allocation based on demand.",
      "",
      "### Commands",
      "- `scale:status` — Show current scaling state",
      "- `scale:config` — Show scaling configuration (min/max/thresholds)",
      "- `scale:set-min <n>` — Set minimum instances",
      "- `scale:set-max <n>` — Set maximum instances",
      "- `scale:history` — Show scaling events history",
      "",
      "### Behavior",
      "- Monitors request queue depth and inference latency",
      "- Scales up when queue depth > 10 or p95 latency > 2s",
      "- Scales down when queue depth < 2 and p95 latency < 500ms for 5 min",
      "- Respects min/max instance bounds",
      "- Cooldown of 3 minutes between scaling events",
      "- Logs all scaling decisions with reasoning",
    ].join("\n"),
  },
  {
    name: "pricing-optimizer",
    description: "Optimize pricing based on conversion data and competitor analysis",
    category: "revenue",
    instructions: [
      "## Pricing Optimizer",
      "",
      "Analyze conversion data and adjust pricing to maximize revenue.",
      "",
      "### Commands",
      "- `pricing:analyze` — Analyze current pricing vs conversion rates",
      "- `pricing:suggest` — Suggest pricing changes based on data",
      "- `pricing:set <skill> <price>` — Update price for a skill",
      "- `pricing:competitors` — Show competitor pricing comparison",
      "- `pricing:ab-test <skill> <priceA> <priceB>` — Start an A/B price test",
      "",
      "### Behavior",
      "- Tracks conversion rate at each price point",
      "- Suggests price decreases when conversion < 5%",
      "- Suggests price increases when conversion > 30%",
      "- Targets 30-50% below competitor rates",
      "- A/B tests run for 48h minimum before declaring winner",
      "- Never raises price more than 20% in a single adjustment",
    ].join("\n"),
  },
  {
    name: "customer-tracker",
    description: "Track customer lifecycle, usage patterns, and churn risk",
    category: "analytics",
    instructions: [
      "## Customer Tracker",
      "",
      "Monitor customer engagement and identify conversion opportunities.",
      "",
      "### Commands",
      "- `customers:active` — List active customers (last 24h)",
      "- `customers:trial` — List users on free tier approaching limits",
      "- `customers:churn-risk` — Identify customers at risk of churning",
      "- `customers:usage <ip>` — Show usage history for a customer",
      "- `customers:nudge` — Generate conversion nudge for trial users at limit",
      "",
      "### Behavior",
      "- Tracks per-IP usage against free tier limits (3 calls/day)",
      "- Flags users who hit 2/3 free calls as conversion candidates",
      "- Identifies returning free users (>3 days) as high-value leads",
      "- Detects usage drop-off as churn risk signal",
      "- Generates personalized nudge messages based on usage patterns",
    ].join("\n"),
  },
  {
    name: "log-aggregator",
    description: "Aggregate, search, and analyze logs across all services",
    category: "analytics",
    instructions: [
      "## Log Aggregator",
      "",
      "Centralized log collection, search, and analysis.",
      "",
      "### Commands",
      "- `logs:tail [service]` — Show recent logs (optionally filtered by service)",
      "- `logs:search <query>` — Search logs by keyword or pattern",
      "- `logs:errors` — Show all error-level logs from last hour",
      "- `logs:stats` — Show log volume and error rate statistics",
      "- `logs:export <start> <end>` — Export logs for a time range",
      "",
      "### Behavior",
      "- Collects logs from all agent services (inference, heartbeat, social, revenue)",
      "- Indexes logs for fast full-text search",
      "- Calculates error rate as percentage of total log entries",
      "- Retains logs for 7 days before rotation",
      "- Supports structured log queries (level, service, timestamp range)",
    ].join("\n"),
  },
];

// ─── Loader Function ──────────────────────────────────────────

/**
 * Load all deployment/monitoring skills as Skill objects.
 * Returns an array compatible with the existing skill loader output.
 *
 * These skills use source "self" and are auto-activated by default.
 * They can be passed directly to the agent loop alongside
 * SKILL.md-loaded skills from loadSkills().
 */
export function loadDeploymentSkills(): Skill[] {
  const now = new Date().toISOString();

  return DEPLOYMENT_SKILL_DEFS.map((def): Skill => ({
    name: def.name,
    description: `[${def.category}] ${def.description}`,
    autoActivate: true,
    instructions: def.instructions,
    source: "self",
    path: `builtin://deployment-skills/${def.name}`,
    enabled: true,
    installedAt: now,
  }));
}

// ─── Re-exports ───────────────────────────────────────────────

export { DEPLOYMENT_SKILL_DEFS };
export type { DeploymentSkillCategory, DeploymentSkillDef };
