#!/usr/bin/env node
/**
 * Revenue & P&L Metrics Tracker — Inferred Analysis
 *
 * The single most important dashboard per the revenue-first doctrine.
 * Tracks: Revenue (gross $), Expense (inference + compute $), Net P&L,
 * Customers served (unique), Conversion rate (free->paid), Latency.
 *
 * Usage:
 *   node agents/management/revenue-tracker.mjs                  # Print dashboard
 *   node agents/management/revenue-tracker.mjs --json           # JSON output
 *   node agents/management/revenue-tracker.mjs --watch 60       # Continuous (60s)
 *   node agents/management/revenue-tracker.mjs --alerts-only    # Only show alerts
 *   node agents/management/revenue-tracker.mjs --reset          # Reset all metrics
 *
 * Environment:
 *   REVENUE_METRICS_PATH  — override state file location
 *   LATENCY_THRESHOLD_MS  — alert threshold (default: 2000)
 *   CONVERSION_THRESHOLD  — minimum acceptable conversion rate (default: 0.05)
 *   REVENUE_DROP_THRESHOLD — alert on % drop from 7d avg (default: 0.50)
 *   TELEGRAM_BOT_TOKEN    — for alert delivery
 *   TELEGRAM_CHAT_ID      — for alert delivery
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const STATE_DIR = join(AGENTS_DIR, "state");
const DEFAULT_METRICS_PATH = join(STATE_DIR, "revenue-metrics.json");

// ─── Config ──────────────────────────────────────────────

const CONFIG = {
  metricsPath: process.env.REVENUE_METRICS_PATH || DEFAULT_METRICS_PATH,
  latencyThresholdMs: parseInt(process.env.LATENCY_THRESHOLD_MS || "2000"),
  conversionThreshold: parseFloat(process.env.CONVERSION_THRESHOLD || "0.05"),
  revenueDropThreshold: parseFloat(process.env.REVENUE_DROP_THRESHOLD || "0.50"),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

// ─── Date Utilities ─────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(date) {
  if (typeof date === "string") return date.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKey(d);
}

// ─── State Management ───────────────────────────────────

function emptyState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // Revenue events: { date: [{ amount, source, customerId, ts }] }
    revenue: {},

    // Expense events: { date: [{ amount, category, ts }] }
    expenses: {},

    // Customer events: { customerId: [{ eventType, ts }] }
    customers: {},

    // Set of customers who have paid at least once
    paidCustomers: [],

    // Latency samples: { endpoint: [{ ms, ts }] }
    latency: {},

    // Alerts log: [{ type, message, ts, severity }]
    alerts: [],
  };
}

function loadState() {
  try {
    if (existsSync(CONFIG.metricsPath)) {
      return JSON.parse(readFileSync(CONFIG.metricsPath, "utf-8"));
    }
  } catch (err) {
    console.error(`[revenue-tracker] Failed to load state: ${err.message}`);
  }
  return emptyState();
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CONFIG.metricsPath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[revenue-tracker] Failed to save state: ${err.message}`);
  }
}

// ─── Revenue Tracking ───────────────────────────────────

/**
 * Record a revenue event.
 * @param {number} amount — gross revenue in USD
 * @param {string} source — e.g. "api-call", "subscription", "one-time"
 * @param {string} customerId — unique customer/IP identifier
 */
export function recordRevenue(amount, source, customerId) {
  const state = loadState();
  const day = todayKey();
  if (!state.revenue[day]) state.revenue[day] = [];
  state.revenue[day].push({
    amount: Number(amount),
    source: String(source),
    customerId: String(customerId),
    ts: new Date().toISOString(),
  });

  // Track paid customer
  if (!state.paidCustomers.includes(customerId)) {
    state.paidCustomers.push(customerId);
  }

  // Also record a customer "paid" event
  if (!state.customers[customerId]) state.customers[customerId] = [];
  state.customers[customerId].push({
    eventType: "paid",
    ts: new Date().toISOString(),
  });

  saveState(state);
  checkAlerts(state);
  return { recorded: true, day, amount };
}

/**
 * Record an expense event.
 * @param {number} amount — cost in USD
 * @param {string} category — "inference", "compute", "data", "hosting", "other"
 */
export function recordExpense(amount, category) {
  const state = loadState();
  const day = todayKey();
  if (!state.expenses[day]) state.expenses[day] = [];
  state.expenses[day].push({
    amount: Number(amount),
    category: String(category),
    ts: new Date().toISOString(),
  });
  saveState(state);
  return { recorded: true, day, amount, category };
}

// ─── P&L Calculations ───────────────────────────────────

/**
 * Get gross revenue for a given date.
 */
export function getDailyRevenue(date) {
  const state = loadState();
  const day = dateKey(date || todayKey());
  const events = state.revenue[day] || [];
  return events.reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Get total expenses for a given date.
 */
export function getDailyExpenses(date) {
  const state = loadState();
  const day = dateKey(date || todayKey());
  const events = state.expenses[day] || [];
  return events.reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Get P&L for a specific day.
 * @param {string|Date} date — defaults to today
 * @returns {{ date, revenue, expenses, pnl, breakdown }}
 */
export function getDailyPnL(date) {
  const state = loadState();
  const day = dateKey(date || todayKey());

  const revEvents = state.revenue[day] || [];
  const expEvents = state.expenses[day] || [];

  const revenue = revEvents.reduce((sum, e) => sum + e.amount, 0);
  const expenses = expEvents.reduce((sum, e) => sum + e.amount, 0);

  // Expense breakdown by category
  const breakdown = {};
  for (const e of expEvents) {
    breakdown[e.category] = (breakdown[e.category] || 0) + e.amount;
  }

  // Revenue breakdown by source
  const revenueBySource = {};
  for (const e of revEvents) {
    revenueBySource[e.source] = (revenueBySource[e.source] || 0) + e.amount;
  }

  return {
    date: day,
    revenue: round(revenue),
    expenses: round(expenses),
    pnl: round(revenue - expenses),
    revenueBySource,
    expenseBreakdown: breakdown,
    transactionCount: revEvents.length + expEvents.length,
  };
}

/**
 * Get cumulative P&L across all recorded days.
 * @returns {{ totalRevenue, totalExpenses, netPnL, days, dailyHistory }}
 */
export function getRunningPnL() {
  const state = loadState();

  let totalRevenue = 0;
  let totalExpenses = 0;
  const dailyHistory = [];

  // Collect all unique dates
  const allDates = new Set([
    ...Object.keys(state.revenue),
    ...Object.keys(state.expenses),
  ]);
  const sortedDates = [...allDates].sort();

  let cumPnL = 0;
  for (const day of sortedDates) {
    const rev = (state.revenue[day] || []).reduce((s, e) => s + e.amount, 0);
    const exp = (state.expenses[day] || []).reduce((s, e) => s + e.amount, 0);
    totalRevenue += rev;
    totalExpenses += exp;
    cumPnL += rev - exp;
    dailyHistory.push({
      date: day,
      revenue: round(rev),
      expenses: round(exp),
      dailyPnL: round(rev - exp),
      cumulativePnL: round(cumPnL),
    });
  }

  return {
    totalRevenue: round(totalRevenue),
    totalExpenses: round(totalExpenses),
    netPnL: round(totalRevenue - totalExpenses),
    days: sortedDates.length,
    dailyHistory,
  };
}

// ─── Customer Metrics ───────────────────────────────────

/**
 * Record a customer interaction event.
 * @param {string} customerId — unique customer/IP identifier
 * @param {string} eventType — "visit", "free-use", "paid", "signup", "churn"
 */
export function recordCustomerEvent(customerId, eventType) {
  const state = loadState();
  const id = String(customerId);
  if (!state.customers[id]) state.customers[id] = [];
  state.customers[id].push({
    eventType: String(eventType),
    ts: new Date().toISOString(),
  });
  saveState(state);
  return { recorded: true, customerId: id, eventType };
}

/**
 * Get unique customers for a given period.
 * @param {"today"|"7d"|"30d"|"all"} period
 * @returns {{ period, uniqueCustomers, count }}
 */
export function getUniqueCustomers(period = "today") {
  const state = loadState();
  const cutoff = periodCutoff(period);
  const unique = new Set();

  for (const [customerId, events] of Object.entries(state.customers)) {
    for (const e of events) {
      if (new Date(e.ts) >= cutoff) {
        unique.add(customerId);
        break;
      }
    }
  }

  return {
    period,
    uniqueCustomers: [...unique],
    count: unique.size,
  };
}

/**
 * Calculate free-to-paid conversion rate.
 * Conversion = unique paying customers / total unique customers.
 * @returns {{ totalCustomers, paidCustomers, conversionRate, belowThreshold }}
 */
export function getConversionRate() {
  const state = loadState();
  const totalCustomers = Object.keys(state.customers).length;
  const paidCount = state.paidCustomers.length;

  const rate = totalCustomers > 0 ? paidCount / totalCustomers : 0;

  return {
    totalCustomers,
    paidCustomers: paidCount,
    conversionRate: round(rate, 4),
    conversionPercent: `${(rate * 100).toFixed(1)}%`,
    belowThreshold: rate < CONFIG.conversionThreshold && totalCustomers >= 10,
  };
}

/**
 * Calculate churn rate.
 * A customer is "churned" if they have no events in the last 30 days
 * but had events before that.
 * @returns {{ totalCustomers, activeCustomers, churnedCustomers, churnRate }}
 */
export function getChurnRate() {
  const state = loadState();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let active = 0;
  let churned = 0;
  const totalCustomers = Object.keys(state.customers).length;

  for (const events of Object.values(state.customers)) {
    const lastEvent = events[events.length - 1];
    if (!lastEvent) continue;

    const lastDate = new Date(lastEvent.ts);
    if (lastDate >= thirtyDaysAgo) {
      active++;
    } else {
      churned++;
    }
  }

  const churnRate = totalCustomers > 0 ? churned / totalCustomers : 0;

  return {
    totalCustomers,
    activeCustomers: active,
    churnedCustomers: churned,
    churnRate: round(churnRate, 4),
    churnPercent: `${(churnRate * 100).toFixed(1)}%`,
  };
}

// ─── Performance Metrics ────────────────────────────────

/**
 * Record a latency sample for an endpoint.
 * @param {string} endpoint — API endpoint name
 * @param {number} ms — response time in milliseconds
 */
export function recordLatency(endpoint, ms) {
  const state = loadState();
  const ep = String(endpoint);
  if (!state.latency[ep]) state.latency[ep] = [];

  // Keep last 1000 samples per endpoint to bound memory
  if (state.latency[ep].length >= 1000) {
    state.latency[ep] = state.latency[ep].slice(-500);
  }

  state.latency[ep].push({
    ms: Number(ms),
    ts: new Date().toISOString(),
  });

  saveState(state);

  // Check latency alert
  if (ms > CONFIG.latencyThresholdMs) {
    addAlert(state, "latency", `Endpoint "${ep}" latency ${ms}ms exceeds ${CONFIG.latencyThresholdMs}ms threshold`, "warn");
    saveState(state);
  }

  return { recorded: true, endpoint: ep, ms };
}

/**
 * Get average latency for an endpoint (last 24h samples).
 * @param {string} endpoint — API endpoint name
 * @returns {{ endpoint, avgMs, minMs, maxMs, p95Ms, sampleCount }}
 */
export function getAvgLatency(endpoint) {
  const state = loadState();
  const ep = String(endpoint);
  const samples = state.latency[ep] || [];

  // Filter to last 24h
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 24);
  const recent = samples.filter((s) => new Date(s.ts) >= cutoff);

  if (recent.length === 0) {
    return { endpoint: ep, avgMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, sampleCount: 0 };
  }

  const values = recent.map((s) => s.ms).sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const p95Index = Math.floor(values.length * 0.95);

  return {
    endpoint: ep,
    avgMs: round(sum / values.length),
    minMs: values[0],
    maxMs: values[values.length - 1],
    p95Ms: values[Math.min(p95Index, values.length - 1)],
    sampleCount: values.length,
    exceedsThreshold: round(sum / values.length) > CONFIG.latencyThresholdMs,
  };
}

/**
 * Get latency summary across all endpoints.
 */
export function getAllLatency() {
  const state = loadState();
  const result = {};
  for (const ep of Object.keys(state.latency)) {
    result[ep] = getAvgLatency(ep);
  }
  return result;
}

// ─── Alerts ─────────────────────────────────────────────

function addAlert(state, type, message, severity = "warn") {
  state.alerts.push({
    type,
    message,
    severity,
    ts: new Date().toISOString(),
  });

  // Keep last 200 alerts
  if (state.alerts.length > 200) {
    state.alerts = state.alerts.slice(-100);
  }
}

/**
 * Run all alert checks against current state.
 */
function checkAlerts(state) {
  const alerts = [];

  // 1. Revenue drop > 50% from 7-day average
  const today = todayKey();
  const todayRev = (state.revenue[today] || []).reduce((s, e) => s + e.amount, 0);

  let sum7d = 0;
  let days7d = 0;
  for (let i = 1; i <= 7; i++) {
    const day = daysAgo(i);
    const dayRev = (state.revenue[day] || []).reduce((s, e) => s + e.amount, 0);
    if (state.revenue[day]) {
      sum7d += dayRev;
      days7d++;
    }
  }

  if (days7d >= 3) {
    const avg7d = sum7d / days7d;
    if (avg7d > 0 && todayRev < avg7d * (1 - CONFIG.revenueDropThreshold)) {
      const dropPct = ((1 - todayRev / avg7d) * 100).toFixed(0);
      const msg = `Revenue drop alert: today $${todayRev.toFixed(2)} is ${dropPct}% below 7-day avg $${avg7d.toFixed(2)}`;
      addAlert(state, "revenue-drop", msg, "critical");
      alerts.push(msg);
    }
  }

  // 2. Latency threshold (checked inline in recordLatency)

  // 3. Conversion rate below threshold
  const totalCustomers = Object.keys(state.customers).length;
  const paidCount = state.paidCustomers.length;
  if (totalCustomers >= 10) {
    const rate = paidCount / totalCustomers;
    if (rate < CONFIG.conversionThreshold) {
      const msg = `Conversion rate ${(rate * 100).toFixed(1)}% is below ${(CONFIG.conversionThreshold * 100).toFixed(0)}% threshold (${paidCount}/${totalCustomers})`;
      addAlert(state, "low-conversion", msg, "warn");
      alerts.push(msg);
    }
  }

  return alerts;
}

/**
 * Get recent alerts.
 * @param {number} limit — max alerts to return
 */
export function getAlerts(limit = 20) {
  const state = loadState();
  return state.alerts.slice(-limit);
}

// ─── Dashboard ──────────────────────────────────────────

/**
 * Get the complete revenue dashboard — single object with all key metrics.
 * This is THE dashboard per revenue-first doctrine.
 * @returns {object}
 */
export function getRevenueDashboard() {
  const state = loadState();
  const today = todayKey();
  const runningPnL = getRunningPnL();
  const dailyPnL = getDailyPnL(today);
  const conversion = getConversionRate();
  const churn = getChurnRate();
  const customersToday = getUniqueCustomers("today");
  const customers7d = getUniqueCustomers("7d");
  const latencySummary = getAllLatency();

  // 7-day revenue trend
  const revenueTrend = [];
  for (let i = 6; i >= 0; i--) {
    const day = daysAgo(i);
    const rev = (state.revenue[day] || []).reduce((s, e) => s + e.amount, 0);
    const exp = (state.expenses[day] || []).reduce((s, e) => s + e.amount, 0);
    revenueTrend.push({ date: day, revenue: round(rev), expenses: round(exp), pnl: round(rev - exp) });
  }

  // Run alerts check
  const alertMessages = checkAlerts(state);
  saveState(state);

  // Profitability target: $10/day
  const dailyTarget = 10;
  const onTrack = dailyPnL.revenue >= dailyTarget;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      todayRevenue: dailyPnL.revenue,
      todayExpenses: dailyPnL.expenses,
      todayPnL: dailyPnL.pnl,
      cumulativeRevenue: runningPnL.totalRevenue,
      cumulativeExpenses: runningPnL.totalExpenses,
      cumulativePnL: runningPnL.netPnL,
      daysTracked: runningPnL.days,
    },
    dailyTarget: {
      target: dailyTarget,
      current: dailyPnL.revenue,
      onTrack,
      gap: round(dailyTarget - dailyPnL.revenue),
    },
    customers: {
      today: customersToday.count,
      last7d: customers7d.count,
      totalAllTime: Object.keys(state.customers).length,
      paidAllTime: state.paidCustomers.length,
    },
    conversion: {
      rate: conversion.conversionRate,
      percent: conversion.conversionPercent,
      belowThreshold: conversion.belowThreshold,
    },
    churn: {
      rate: churn.churnRate,
      percent: churn.churnPercent,
      activeCustomers: churn.activeCustomers,
      churnedCustomers: churn.churnedCustomers,
    },
    latency: latencySummary,
    revenueTrend,
    recentAlerts: getAlerts(10),
    todayBreakdown: dailyPnL,
  };
}

// ─── ASCII Dashboard Rendering ──────────────────────────

function renderDashboard(dashboard) {
  const d = dashboard;
  const lines = [];
  const w = 64;
  const hr = "─".repeat(w);
  const dhr = "═".repeat(w);

  lines.push(dhr);
  lines.push("  REVENUE DASHBOARD — The Only Dashboard That Matters");
  lines.push(`  Generated: ${d.generatedAt}`);
  lines.push(dhr);

  // P&L Summary
  lines.push("");
  lines.push("  P&L SUMMARY");
  lines.push("  " + hr);
  lines.push(`  Today Revenue:    $${d.summary.todayRevenue.toFixed(2)}`);
  lines.push(`  Today Expenses:   $${d.summary.todayExpenses.toFixed(2)}`);
  lines.push(`  Today P&L:        $${d.summary.todayPnL.toFixed(2)}  ${d.summary.todayPnL >= 0 ? "[+]" : "[-]"}`);
  lines.push("");
  lines.push(`  Cumulative Rev:   $${d.summary.cumulativeRevenue.toFixed(2)}`);
  lines.push(`  Cumulative Exp:   $${d.summary.cumulativeExpenses.toFixed(2)}`);
  lines.push(`  Cumulative P&L:   $${d.summary.cumulativePnL.toFixed(2)}`);
  lines.push(`  Days Tracked:     ${d.summary.daysTracked}`);

  // Daily target
  lines.push("");
  lines.push("  DAILY TARGET ($10/day)");
  lines.push("  " + hr);
  const pct = Math.min(1, d.dailyTarget.current / d.dailyTarget.target);
  const barLen = 30;
  const filled = Math.round(pct * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  lines.push(`  [${bar}] ${(pct * 100).toFixed(0)}%`);
  lines.push(`  ${d.dailyTarget.onTrack ? "ON TRACK" : `Gap: $${d.dailyTarget.gap.toFixed(2)} to go`}`);

  // Customer metrics
  lines.push("");
  lines.push("  CUSTOMERS");
  lines.push("  " + hr);
  lines.push(`  Today:            ${d.customers.today}`);
  lines.push(`  Last 7 Days:      ${d.customers.last7d}`);
  lines.push(`  All-Time Total:   ${d.customers.totalAllTime}`);
  lines.push(`  All-Time Paid:    ${d.customers.paidAllTime}`);

  // Conversion & Churn
  lines.push("");
  lines.push("  CONVERSION & RETENTION");
  lines.push("  " + hr);
  lines.push(`  Conversion Rate:  ${d.conversion.percent}  ${d.conversion.belowThreshold ? "[!!! BELOW 5% !!!]" : "[OK]"}`);
  lines.push(`  Churn Rate:       ${d.churn.percent}`);
  lines.push(`  Active Customers: ${d.churn.activeCustomers}`);
  lines.push(`  Churned:          ${d.churn.churnedCustomers}`);

  // Latency
  const endpoints = Object.keys(d.latency);
  if (endpoints.length > 0) {
    lines.push("");
    lines.push("  LATENCY (last 24h)");
    lines.push("  " + hr);
    for (const ep of endpoints) {
      const l = d.latency[ep];
      const flag = l.exceedsThreshold ? " [!!! SLOW !!!]" : "";
      lines.push(`  ${ep.padEnd(24)} avg=${l.avgMs}ms  p95=${l.p95Ms}ms  n=${l.sampleCount}${flag}`);
    }
  }

  // 7-day trend
  lines.push("");
  lines.push("  7-DAY REVENUE TREND");
  lines.push("  " + hr);
  const maxRev = Math.max(1, ...d.revenueTrend.map((t) => t.revenue));
  for (const t of d.revenueTrend) {
    const miniBar = "█".repeat(Math.round((t.revenue / maxRev) * 20));
    const sign = t.pnl >= 0 ? "+" : "";
    lines.push(`  ${t.date}  ${miniBar.padEnd(20)} $${t.revenue.toFixed(2)} (${sign}$${t.pnl.toFixed(2)})`);
  }

  // Alerts
  if (d.recentAlerts.length > 0) {
    lines.push("");
    lines.push("  ALERTS");
    lines.push("  " + hr);
    for (const a of d.recentAlerts.slice(-5)) {
      const sev = a.severity === "critical" ? "[CRIT]" : "[WARN]";
      lines.push(`  ${sev} ${a.message}`);
      lines.push(`        ${a.ts}`);
    }
  }

  lines.push("");
  lines.push(dhr);
  lines.push("  Revenue-first doctrine: every compute cycle needs a revenue hypothesis.");
  lines.push(dhr);

  return lines.join("\n");
}

// ─── Utility ────────────────────────────────────────────

function round(n, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function periodCutoff(period) {
  const now = new Date();
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "7d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
    case "30d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "all":
    default:
      return new Date(0);
  }
}

// ─── Telegram Alerting ──────────────────────────────────

async function sendTelegramAlert(message) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error(`[revenue-tracker] Telegram alert failed: ${err.message}`);
  }
}

// ─── CLI ────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    json: args.includes("--json"),
    alertsOnly: args.includes("--alerts-only"),
    reset: args.includes("--reset"),
    watch: args.includes("--watch")
      ? parseInt(args[args.indexOf("--watch") + 1] || "60")
      : 0,
  };
}

async function main() {
  const args = parseArgs();

  if (args.reset) {
    saveState(emptyState());
    console.log("[revenue-tracker] Metrics reset.");
    return;
  }

  const run = () => {
    const dashboard = getRevenueDashboard();

    if (args.alertsOnly) {
      const alerts = dashboard.recentAlerts;
      if (alerts.length === 0) {
        console.log("[revenue-tracker] No alerts.");
      } else {
        if (args.json) {
          console.log(JSON.stringify(alerts, null, 2));
        } else {
          for (const a of alerts) {
            console.log(`[${a.severity.toUpperCase()}] ${a.message} (${a.ts})`);
          }
        }
      }
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(dashboard, null, 2));
    } else {
      console.log(renderDashboard(dashboard));
    }

    // Send critical alerts via telegram
    for (const a of dashboard.recentAlerts) {
      if (a.severity === "critical") {
        sendTelegramAlert(`*Revenue Alert*\n${a.message}`);
      }
    }
  };

  run();

  if (args.watch > 0) {
    console.log(`\n[revenue-tracker] Watching every ${args.watch}s. Ctrl+C to stop.\n`);
    setInterval(run, args.watch * 1000);
  }
}

// Run if called directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("revenue-tracker.mjs") ||
  process.argv[1].includes("revenue-tracker")
);

if (isMain) {
  main().catch((err) => {
    console.error(`[revenue-tracker] Fatal: ${err.message}`);
    process.exit(1);
  });
}
