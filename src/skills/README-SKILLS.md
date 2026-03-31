# Deployment & Monitoring Skills

Programmatic skills for deployment management, service monitoring, revenue tracking, and analytics. These are loaded via `loadDeploymentSkills()` from `deployment-skills.ts` and produce `Skill` objects compatible with the existing `loadSkills()` loader.

## Skills

### revenue-tracker
**Category:** revenue

Track daily revenue, expenses, net P&L, and conversion rates.

**Commands:**
- `revenue:summary` — Daily revenue summary (gross $, expenses, net P&L)
- `revenue:conversion` — Free-to-paid conversion rate
- `revenue:trend` — Revenue trend over last 7 days
- `revenue:customers` — Unique customers served today

**Configuration:** None required. Reads from existing `spend_tracker` and payment tables in the automaton database.

**Example:**
```
revenue:summary
# Output:
# Gross Revenue: $4.20
# Expenses:      $1.85
# Net P&L:       $2.35
# Customers:     17
```

---

### service-health
**Category:** monitoring

Monitor API endpoint health, uptime, and response latency.

**Commands:**
- `health:check` — Run health checks on all registered endpoints
- `health:status` — Current status of all services
- `health:latency` — p50/p95/p99 response latency
- `health:uptime` — Uptime percentage over last 24h

**Configuration:** Endpoints are auto-discovered from the heartbeat config and registered services.

**Example:**
```
health:check
# Output:
# /api/summarize  — UP (120ms)
# /api/analyze    — UP (340ms)
# /api/health     — UP (15ms)
```

---

### deploy-manager
**Category:** deployment

Manage deployments, rollbacks, and blue-green switches.

**Commands:**
- `deploy:status` — Current deployment status
- `deploy:promote` — Promote staging to production
- `deploy:rollback` — Roll back to previous deployment
- `deploy:history` — Deployment history

**Configuration:** None required. Tracks deployment state in the automaton database.

**Example:**
```
deploy:status
# Output:
# Active: v0.2.1 (deployed 2h ago)
# Previous: v0.2.0 (available for rollback)
# Health: all checks passing
```

---

### alerting
**Category:** monitoring

Configure and dispatch alerts for service issues and revenue drops.

**Commands:**
- `alert:list` — List all configured alert rules
- `alert:add <condition> <action>` — Add a new alert rule
- `alert:remove <id>` — Remove an alert rule
- `alert:history` — Recent alert firings
- `alert:test <id>` — Test-fire an alert

**Configuration:** Alert rules are stored in the database. Built-in conditions: `endpoint_down`, `high_latency`, `revenue_drop`, `error_spike`. Actions: `log`, `webhook`, `social_post`.

**Example:**
```
alert:add endpoint_down log
# Output: Alert rule #1 created: endpoint_down -> log (cooldown: 15m)

alert:list
# Output:
# #1  endpoint_down -> log   (active, last fired: never)
# #2  revenue_drop  -> log   (active, last fired: 3h ago)
```

---

### auto-scaler
**Category:** deployment

Auto-scale inference resources based on request load and queue depth.

**Commands:**
- `scale:status` — Current scaling state
- `scale:config` — Scaling configuration (min/max/thresholds)
- `scale:set-min <n>` — Set minimum instances
- `scale:set-max <n>` — Set maximum instances
- `scale:history` — Scaling events history

**Configuration:**
- Default min instances: 1
- Default max instances: 5
- Scale-up threshold: queue depth > 10 or p95 latency > 2s
- Scale-down threshold: queue depth < 2 and p95 latency < 500ms for 5 min
- Cooldown: 3 minutes between scaling events

**Example:**
```
scale:status
# Output:
# Instances: 2/5 (min: 1, max: 5)
# Queue depth: 3
# p95 latency: 450ms
# Last scale event: scale-up 45m ago
```

---

### pricing-optimizer
**Category:** revenue

Optimize pricing based on conversion data and competitor analysis.

**Commands:**
- `pricing:analyze` — Analyze current pricing vs conversion rates
- `pricing:suggest` — Suggest pricing changes based on data
- `pricing:set <skill> <price>` — Update price for a skill
- `pricing:competitors` — Competitor pricing comparison
- `pricing:ab-test <skill> <priceA> <priceB>` — Start an A/B price test

**Configuration:** None required. Reads pricing and conversion data from the database. Competitor data is fetched via the Perplexity API if `perplexityApiKey` is configured.

**Example:**
```
pricing:analyze
# Output:
# url-summarizer: $0.25/call, 8.2% conversion (healthy)
# sentiment-analysis: $0.50/call, 2.1% conversion (too high — suggest $0.30)
```

---

### customer-tracker
**Category:** analytics

Track customer lifecycle, usage patterns, and churn risk.

**Commands:**
- `customers:active` — List active customers (last 24h)
- `customers:trial` — List users on free tier approaching limits
- `customers:churn-risk` — Identify customers at risk of churning
- `customers:usage <ip>` — Usage history for a customer
- `customers:nudge` — Generate conversion nudge for trial users at limit

**Configuration:** None required. Uses the free-tier tracking data from `src/skills/revenue/free-tier.ts`.

**Example:**
```
customers:trial
# Output:
# 192.168.1.42  — 2/3 free calls used (candidate for nudge)
# 10.0.0.17     — 3/3 free calls used (ready for conversion)

customers:nudge
# Output:
# "You've used all 3 free calls today. Unlock unlimited access for $0.25/call.
#  No signup required — just add a payment method: [url]"
```

---

### log-aggregator
**Category:** analytics

Aggregate, search, and analyze logs across all services.

**Commands:**
- `logs:tail [service]` — Show recent logs (optionally filtered by service)
- `logs:search <query>` — Search logs by keyword or pattern
- `logs:errors` — All error-level logs from last hour
- `logs:stats` — Log volume and error rate statistics
- `logs:export <start> <end>` — Export logs for a time range

**Configuration:** None required. Reads from the automaton's logger output (see `src/observability/logger.ts`). Logs are retained for 7 days.

**Example:**
```
logs:errors
# Output:
# [2026-03-31T14:22:01Z] [ERROR] [inference] Token limit exceeded for request abc123
# [2026-03-31T14:18:44Z] [ERROR] [heartbeat] Conway API timeout after 30s

logs:stats
# Output:
# Last hour: 1,247 entries
# Error rate: 0.8% (10 errors)
# Top service: inference (62%)
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
