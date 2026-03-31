# Deployment & Monitoring Skills

Programmatic skills for deployment management, service monitoring, revenue tracking, and analytics. These are loaded via `loadDeploymentSkills()` from `deployment-skills.ts` and produce `Skill` objects compatible with the existing `loadSkills()` loader.

## Skills

### revenue-tracker
**Category:** revenue

Track daily revenue, expenses, net P&L, and conversion rates. Records paid and free-tier usage events for accurate conversion analytics.

**Key Functions:**
- `recordRevenue(db, service, amountCents, currency, customerHash)` — Record a paid service call
- `recordFreeUsage(db, service, customerHash)` — Record a free-tier usage event
- `getDailyRevenue(db, date?)` — Get revenue for a specific date
- `getServiceBreakdown(db, period)` — Revenue broken down by service
- `getConversionRate(db, service, period)` — Free-to-paid conversion rate
- `generateReport(db)` — Full P&L report with expenses and conversion data

**Configuration:** None required. Creates its own SQLite tables (`revenue_tracking`, `service_usage`) on first use. Reads expense data from the existing `expense_events` table.

**Example:**
```
revenue:summary
# Output:
# ═══════════════════════════════════════
#   REVENUE & P&L REPORT — 2026-03-31
# ═══════════════════════════════════════
#   Today:  $4.20 (17 txns)
#   Week:   $28.50 (112 txns, 43 customers)
#   Month:  $89.25 (380 txns, 127 customers)
```

---

### service-health
**Category:** monitoring

Monitor API endpoint health, uptime, and response latency. Detects consecutive failures and generates alerts on service degradation or recovery.

**Key Functions:**
- `checkHealth(serviceUrl)` — Check a single endpoint
- `checkAllServices(db, services?)` — Check all services, store results, generate alerts
- `getUptime(db, service, period)` — Uptime percentage (period: `1h`, `24h`, `7d`, `30d`)
- `getAlerts(db, since?)` — Get alerts from the last 24h
- `getStatusDashboard(db, services?)` — Text-based status dashboard

**Configuration:** Endpoints are auto-discovered from `DEFAULT_SERVICES` in the module. Override by passing a custom `ServiceConfig[]` to `checkAllServices()`.

**Default monitored services:**
- Landing Page: `http://localhost:3000/health`
- URL Summarizer: `http://localhost:9003/health`
- x402 API: `http://localhost:9402/health`
- Gateway: `http://localhost:7402/health`
- Invoice Parser: `http://localhost:8000/health`

**Example:**
```
health:check
# Output:
# Service              Status    Latency     Uptime 24h  Uptime 7d   Failures
# Landing Page         UP        45ms        100%        99.8%       0
# URL Summarizer       UP        120ms       99.9%       99.5%       0
# x402 API             DOWN      --          95.2%       98.1%       5
```

---

### deploy-manager
**Category:** deployment

Track deployment state per service, store deployment history, provide rollback information, and report deployment frequency and success rate.

**Key Functions:**
- `new DeployManager(dbPath)` — Create a manager instance
- `manager.recordDeployment(service, version, commitSha, status)` — Log a deploy
- `manager.getDeploymentHistory(service, limit?)` — Past deployments
- `manager.getCurrentVersions()` — Map of service to current version
- `manager.getDeploymentStats(period)` — Deploy counts, success rate, frequency
- `manager.generateDeployReport()` — Full markdown status report
- `manager.getRollbackTarget(service)` — Previous successful version

**Configuration:** None required. Creates its own SQLite database from the provided `dbPath`.

**Example:**
```
deploy:status
# Output:
# Active: v0.2.1 (deployed 2h ago)
# Previous: v0.2.0 (available for rollback)
# Health: all checks passing
# Success rate (30d): 94.1% (16/17 deploys)
```

---

### alerting
**Category:** monitoring

Multi-channel alerting system with rate limiting, alert history, muting, and configurable thresholds. Supports console, webhook, and Telegram channels.

**Key Functions:**
- `new AlertingManager()` — Create a manager instance
- `manager.sendAlert(level, message, channel?)` — Dispatch an alert (levels: `info`, `warning`, `critical`)
- `manager.configureChannel({ type, config })` — Set up webhook or Telegram
- `manager.muteAlert(pattern, durationMs)` — Suppress matching alerts temporarily
- `manager.getAlertHistory(since?)` — Retrieve past alerts

**Configuration:** Configure channels via `configureChannel()`. Webhook channels need a `url`. Telegram channels need `botToken` and `chatId`. Built-in rate limiting: 60s dedup, 10 alerts/min max. Critical alerts auto-broadcast to all channels.

**Example:**
```
alert:add endpoint_down log
# Output: Alert rule created: endpoint_down -> log (cooldown: 15m)

alert:list
# Output:
# #1  endpoint_down -> log   (active, last fired: never)
# #2  revenue_drop  -> log   (active, last fired: 3h ago)
```

---

### auto-scaler
**Category:** deployment

Track request volume per service over time windows, detect traffic spikes, and recommend scaling actions. All data persisted in SQLite.

**Key Functions:**
- `recordRequest(db, service, latencyMs, statusCode, error?)` — Record an incoming request
- `getTrafficStats(db, service, windowMinutes)` — RPM, RPS, avg/p99 latency, error rate
- `detectAnomalies(db, service)` — Detect traffic spikes vs baseline
- `getScalingRecommendation(db, service)` — Scale-up/down/hold recommendation with reason
- `getResourceUtilization(db, service)` — Estimated CPU/memory/connection usage
- `generateTrafficReport(db)` — Full traffic report across all services
- `pruneOldRecords(db)` — Clean up old request records

**Configuration:**
- Scale-up threshold: queue depth > 10 or p95 latency > 2s
- Scale-down threshold: queue depth < 2 and p95 latency < 500ms for 5 min
- Cooldown: 3 minutes between scaling events
- Call `pruneOldRecords()` periodically (e.g., every heartbeat cycle) to prevent unbounded growth

**Example:**
```
scale:status
# Output:
# === Traffic Report ===
# --- url-summarizer ---
#   Baseline (30m): 42.3 RPM, 1269 total requests
#   Recent (5m): 58.1 RPM, 291 requests
#   Avg Latency: 180ms | P99: 1200ms
#   Error Rate: 0.3%
#   Recommendation: HOLD — traffic within normal range
```

---

### pricing-optimizer
**Category:** revenue

Analyze conversion data at each price point, suggest pricing adjustments, run A/B tests, and track competitor rates.

**Key Functions:**
- `recordPricePoint(db, service, priceCents, conversionRate, sampleSize)` — Record a price observation
- `analyzePricing(db)` — Analyze all services and get pricing suggestions
- `startABTest(db, service, priceACents, priceBCents)` — Start a 48h+ A/B price test
- `getActiveABTests(db)` — List running A/B tests
- `recordCompetitorPrice(db, competitor, service, priceCents)` — Record a competitor's price
- `getCompetitorPrices(db, service)` — Get competitor prices
- `generatePricingReport(db)` — Full pricing analysis report

**Configuration:** None required. Creates its own SQLite tables (`pricing_history`, `pricing_ab_tests`, `competitor_prices`) on first use. Pricing rules: suggest decrease when conversion < 5%, suggest increase when conversion > 30% (max +20% per adjustment), target 30-50% below competitor rates.

**Example:**
```
pricing:analyze
# Output:
# ═══ Pricing Analysis Report ═══
# ── Current Prices ──
#   url-summarizer: $0.25/call, 8.2% conversion (n=340)
#   sentiment-analysis: $0.50/call, 2.1% conversion (n=95)
# ── Suggestions ──
#   sentiment-analysis: $0.50 → $0.35 — Conversion rate 2.1% is below 5% threshold
```

---

### customer-tracker
**Category:** analytics

Track customer lifecycle from free tier through paid, calculate Customer Lifetime Value, identify churn risk, and report on usage patterns.

**Key Functions:**
- `recordCustomerActivity(db, customerHash, service, action, paid, amountCents)` — Record activity
- `getCustomerSegments(db)` — Customers grouped by segment (free/trial/paid/churned)
- `getCustomerJourney(db, customerHash)` — Full activity history for a customer
- `getChurnRisk(db)` — Customers at risk of churning (sorted by risk score)
- `getCLV(db, segment?)` — Customer lifetime value statistics (avg, median, total)
- `generateCustomerReport(db)` — Full customer analytics report

**Configuration:** None required. Creates its own SQLite tables on first use. Uses the free-tier tracking data from `src/skills/revenue/free-tier.ts`.

**Example:**
```
customers:trial
# Output:
# ═══ Customer Report ═══
# ── Segment Breakdown ──
#   Free:    42
#   Trial:   8
#   Paid:    15
#   Churned: 3
# ── Conversion Funnel ──
#   Free -> Trial+Paid: 35.4%
#   Free -> Paid:       23.1%
```

---

### log-aggregator
**Category:** analytics

Centralized log collection, search, and analysis across all services. Detects error patterns and generates log summaries.

**Key Functions:**
- `log(db, service, level, message, metadata?)` — Store a structured log entry
- `query(db, { service?, level?, pattern?, since?, until?, limit? })` — Search logs
- `getErrorSummary(db, since)` — Error counts grouped by service and message
- `getRecentLogs(db, limit?)` — Most recent log entries
- `generateLogReport(db, period)` — Log volume and error rate report

**Configuration:** None required. Creates its own SQLite table (`aggregated_logs`) on first use. Logs are retained for 7 days.

**Example:**
```
logs:errors
# Output:
# ═══ Log Aggregation Report ═══
# Period: 2026-03-31T13:00:00Z to now
# Total log entries: 1,247
# ── By Level ──
#   error: 10 (0.8%)
#   warn:  23 (1.8%)
#   info:  1,189 (95.3%)
# ── Top Errors ──
#   [inference] Token limit exceeded: 4 occurrences
#   [heartbeat] Conway API timeout: 3 occurrences
```

## Integration

Import and use in the agent system:

```typescript
import { loadDeploymentSkills } from "./skills/deployment-skills.js";
import { loadSkills } from "./skills/loader.js";

// Load SKILL.md-based skills
const fileSkills = loadSkills(skillsDir, db);

// Load deployment skills
const deploymentSkills = loadDeploymentSkills();

// Combine both sets
const allSkills = [...fileSkills, ...deploymentSkills];
```

The returned `Skill[]` array is fully compatible with `runAgentLoop({ skills })` and `getActiveSkillInstructions()`.

Individual skill functions can also be imported directly:

```typescript
import {
  recordRevenue,
  generateRevenueReport,
  checkAllServices,
  analyzePricing,
  recordCustomerActivity,
  aggregateLog,
} from "./skills/deployment-skills.js";
```
