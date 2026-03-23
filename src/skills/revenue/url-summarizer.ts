/**
 * URL Summarizer Earning Skill
 *
 * Datchi skill wrapper that calls the local URL Summarizer Pro
 * microservice and records revenue/expense in the accounting ledger.
 *
 * This skill:
 * - Calls the local HTTP API at localhost:9003
 * - Tracks success/failure metrics in state repo
 * - Logs revenue (price-per-call) and expense (LLM cost estimate)
 * - Exposes stats so Datchi can reason about profitability
 *
 * Config:
 * - production-mode safe (stable cashflow, low risk)
 * - Expected revenue per call: $0.01
 * - Expected cost per call: ~$0.002 (Mistral free tier)
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { logRevenue, logExpense } from "../../local/accounting.js";
import { createLogger } from "../../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("skill.url-summarizer");

/** Validate URL to prevent SSRF attacks */
export function validateUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw.slice(0, 100)}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]") {
    throw new Error("Blocked URL: localhost is not allowed");
  }

  // Block private/internal IP ranges
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 127 ||                           // 127.0.0.0/8
      a === 10 ||                            // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||   // 172.16.0.0/12
      (a === 192 && b === 168) ||            // 192.168.0.0/16
      (a === 169 && b === 254) ||            // 169.254.0.0/16
      a === 0                                // 0.0.0.0
    ) {
      throw new Error("Blocked URL: private/internal IP address");
    }
  }
}

/** Port the URL Summarizer microservice runs on */
const SERVICE_PORT = parseInt(process.env.URL_SUMMARIZER_PORT ?? "9003", 10);
const SERVICE_BASE = `http://localhost:${SERVICE_PORT}`;

/** Cached health status with TTL to avoid blocking every request */
let cachedHealthy: boolean | null = null;
let healthCheckedAt = 0;
const HEALTH_CACHE_TTL_MS = 30_000; // 30 seconds

/** Price charged per summary call (cents) */
const PRICE_PER_CALL_CENTS = 1; // $0.01

/**
 * Estimated cost per call in millicents - Mistral free tier + infra.
 * Using millicents to avoid Math.ceil(0.2) = 1 rounding to full cent.
 * 20 millicents = 0.2 cents = $0.002
 */
const ESTIMATED_COST_MILLICENTS = 20;

export interface SummarizeUrlInput {
  readonly url: string;
  readonly detail_level?: "short" | "medium" | "long";
  readonly language?: string;
  readonly apiKey: string;
}

export interface SummarizeUrlResult {
  readonly success: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly keyPoints?: readonly string[];
  readonly wordCount?: number;
  readonly error?: string;
  readonly requestId: string;
  readonly latencyMs: number;
}

/**
 * Call the URL Summarizer service and record accounting.
 *
 * This is the function Datchi's agent loop calls when a client
 * requests URL summarization through an x402 or API-key payment.
 */
export async function summarizeUrlForClient(
  db: Database,
  input: SummarizeUrlInput,
  options?: {
    readonly nicheId?: string;
    readonly experimentId?: string;
  },
): Promise<SummarizeUrlResult> {
  const requestId = ulid();
  const startMs = Date.now();

  try {
    // Validate user-supplied URL to prevent SSRF
    validateUrl(input.url);

    // Check if service is alive first
    const alive = await checkServiceHealth();
    if (!alive) {
      logger.warn("URL Summarizer service is not running", { port: SERVICE_PORT });
      return {
        success: false,
        error: "URL Summarizer service is not running",
        requestId,
        latencyMs: Date.now() - startMs,
      };
    }

    // Call the service
    const response = await fetch(`${SERVICE_BASE}/summarize-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": input.apiKey,
      },
      body: JSON.stringify({
        url: input.url,
        detail_level: input.detail_level ?? "medium",
        language: input.language ?? "English",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const latencyMs = Date.now() - startMs;
    const body = await response.json() as any;

    if (response.ok && body.summary) {
      // Success: log revenue and expense
      logRevenue(db, {
        source: "skill:url-summarizer",
        amountCents: PRICE_PER_CALL_CENTS,
        description: `URL summary delivered: ${input.url}`,
        metadata: { requestId, url: input.url, latencyMs },
        nicheId: options?.nicheId,
        experimentId: options?.experimentId,
      });

      // Accumulate fractional cents: round to nearest cent, minimum 0
      const expenseCents = Math.round(ESTIMATED_COST_MILLICENTS / 10);
      logExpense(db, {
        category: "inference",
        amountCents: expenseCents,
        description: `URL summarizer inference cost`,
        metadata: { requestId, model: "mistral-small-latest", millicents: ESTIMATED_COST_MILLICENTS },
        nicheId: options?.nicheId,
        experimentId: options?.experimentId,
      });

      // Update success stats
      updateStats(db, true, latencyMs);

      logger.info("URL summary delivered", {
        requestId,
        url: input.url,
        wordCount: body.word_count,
        latencyMs,
      });

      return {
        success: true,
        title: body.title,
        summary: body.summary,
        keyPoints: body.key_points,
        wordCount: body.word_count,
        requestId,
        latencyMs,
      };
    }

    // Failure from service
    updateStats(db, false, latencyMs);

    return {
      success: false,
      error: body.error ?? `Service returned ${response.status}`,
      requestId,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const message = err instanceof Error ? err.message : String(err);

    updateStats(db, false, latencyMs);
    logger.error("URL summarizer skill failed", err instanceof Error ? err : undefined);

    return {
      success: false,
      error: message,
      requestId,
      latencyMs,
    };
  }
}

/** Quick health check for the summarizer service (cached with TTL) */
async function checkServiceHealth(): Promise<boolean> {
  const now = Date.now();
  if (cachedHealthy !== null && now - healthCheckedAt < HEALTH_CACHE_TTL_MS) {
    return cachedHealthy;
  }
  try {
    const res = await fetch(`${SERVICE_BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    cachedHealthy = res.ok;
  } catch {
    cachedHealthy = false;
  }
  healthCheckedAt = now;
  return cachedHealthy;
}

/** Reset health cache (for testing) */
export function resetHealthCache(): void {
  cachedHealthy = null;
  healthCheckedAt = 0;
}

/**
 * In-memory stats accumulator — batched to DB every FLUSH_INTERVAL calls
 * or FLUSH_TIMEOUT_MS, whichever comes first. Eliminates per-request
 * JSON parse → modify → serialize → write round-trip.
 */
const STATS_FLUSH_INTERVAL = 50;  // flush every N calls
const STATS_FLUSH_TIMEOUT_MS = 60_000; // or every 60s

let pendingStats = { total: 0, success: 0, failure: 0, latencySum: 0 };
let lastFlushTime = Date.now();

/** Update skill stats — accumulates in memory, flushes periodically */
function updateStats(db: Database, success: boolean, latencyMs: number): void {
  pendingStats.total += 1;
  pendingStats.success += success ? 1 : 0;
  pendingStats.failure += success ? 0 : 1;
  pendingStats.latencySum += latencyMs;

  const now = Date.now();
  if (pendingStats.total >= STATS_FLUSH_INTERVAL || now - lastFlushTime >= STATS_FLUSH_TIMEOUT_MS) {
    flushStats(db);
  }
}

/** Flush accumulated stats to the KV store */
function flushStats(db: Database): void {
  if (pendingStats.total === 0) return;
  const batch = { ...pendingStats };
  pendingStats = { total: 0, success: 0, failure: 0, latencySum: 0 };
  lastFlushTime = Date.now();

  try {
    const rawStats = db.prepare(
      `SELECT value FROM kv WHERE key = ?`,
    ).get("url_summarizer_stats") as { value: string } | undefined;

    const stats = rawStats
      ? JSON.parse(rawStats.value)
      : { total: 0, success: 0, failure: 0, avgLatencyMs: 0, lastRun: "" };

    const newTotal = stats.total + batch.total;
    const newSuccess = stats.success + batch.success;
    const updatedStats = {
      total: newTotal,
      success: newSuccess,
      failure: stats.failure + batch.failure,
      avgLatencyMs: Math.round(
        (stats.avgLatencyMs * stats.total + batch.latencySum) / newTotal,
      ),
      lastRun: new Date().toISOString(),
      successRate: ((newSuccess / newTotal) * 100).toFixed(1) + "%",
    };

    db.prepare(
      `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
    ).run("url_summarizer_stats", JSON.stringify(updatedStats));
  } catch {
    // Stats are best-effort, never fail the main flow
  }
}

/** Export for testing / graceful shutdown */
export function flushPendingStats(db: Database): void {
  flushStats(db);
}

/**
 * Skill metadata for Datchi's skill discovery.
 * Returned by GET /info on the service, but also declared here
 * so the automaton can reason about it without calling the service.
 */
export const SKILL_METADATA = {
  name: "url-summarizer",
  description: "AI-powered URL summarization with structured output",
  productionSafe: true,
  revenueModel: "pay-per-use" as const,
  pricePerCallCents: PRICE_PER_CALL_CENTS,
  estimatedCostMillicents: ESTIMATED_COST_MILLICENTS,
  expectedMarginPercent: 80, // $0.01 revenue, ~$0.002 cost
  successKpi: "successful_summaries_per_day",
  servicePort: SERVICE_PORT,
  healthEndpoint: "/health",
} as const;
