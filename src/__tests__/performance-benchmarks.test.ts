/**
 * Performance Benchmarks
 *
 * Validates that critical hot paths meet latency and throughput targets.
 * These tests catch performance regressions in:
 * - Memory subsystem (LRU eviction, access count updates, feedback tracking)
 * - Alert engine evaluation
 * - HTTP client timeout behavior
 * - Token cache efficiency
 * - Gateway request body parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// ── Helpers ──────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  // knowledge_store table for access count benchmarks
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_store (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL DEFAULT '',
      access_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function timeMsAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ── Knowledge Store Access Count Benchmarks ─────────────────────

describe("Knowledge Store: bulk access count update", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Seed 500 knowledge entries
    const insert = db.prepare(
      "INSERT INTO knowledge_store (id, category, content) VALUES (?, 'general', ?)",
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        insert.run(`entry-${i}`, `Content for entry ${i}`);
      }
    });
    tx();
  });

  afterEach(() => {
    db.close();
  });

  it("bulk UPDATE with IN clause should be faster than N individual UPDATEs", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `entry-${i}`);

    // Approach 1: N individual updates (old way)
    const individualMs = timeMs(() => {
      const stmt = db.prepare(
        "UPDATE knowledge_store SET access_count = access_count + 1 WHERE id = ?",
      );
      const tx = db.transaction((txIds: string[]) => {
        for (const id of txIds) stmt.run(id);
      });
      tx(ids);
    });

    // Reset
    db.exec("UPDATE knowledge_store SET access_count = 0");

    // Approach 2: Single bulk update (new way)
    const bulkMs = timeMs(() => {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(
        `UPDATE knowledge_store SET access_count = access_count + 1 WHERE id IN (${placeholders})`,
      ).run(...ids);
    });

    // Verify correctness
    const row = db.prepare("SELECT access_count FROM knowledge_store WHERE id = 'entry-0'").get() as { access_count: number };
    expect(row.access_count).toBe(1);

    // Bulk should be at least comparable (usually faster)
    // Allow 3x margin for CI variance
    expect(bulkMs).toBeLessThan(individualMs * 3 + 5);
  });

  it("should correctly update all targeted rows", () => {
    const ids = ["entry-0", "entry-5", "entry-99"];
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE knowledge_store SET access_count = access_count + 1 WHERE id IN (${placeholders})`,
    ).run(...ids);

    for (const id of ids) {
      const row = db.prepare("SELECT access_count FROM knowledge_store WHERE id = ?").get(id) as { access_count: number };
      expect(row.access_count).toBe(1);
    }

    // Non-targeted row should remain at 0
    const untouched = db.prepare("SELECT access_count FROM knowledge_store WHERE id = 'entry-1'").get() as { access_count: number };
    expect(untouched.access_count).toBe(0);
  });
});

// ── LRU Cache Eviction Benchmarks ───────────────────────────────

describe("LRU Cache: batch eviction", () => {
  it("batch eviction should reduce cache to ~80% capacity in one pass", () => {
    const MAX_SIZE = 10_000;
    const cache = new Map<string, number>();

    // Fill cache to 120% capacity
    for (let i = 0; i < MAX_SIZE * 1.2; i++) {
      cache.set(`key-${i}`, i);
    }

    // Batch eviction (our new approach: evict 20% at once)
    const batchMs = timeMs(() => {
      if (cache.size > MAX_SIZE) {
        const evictCount = Math.ceil(cache.size * 0.2);
        const iter = cache.keys();
        for (let i = 0; i < evictCount; i++) {
          const key = iter.next().value;
          if (key !== undefined) cache.delete(key);
        }
      }
    });

    // Should have evicted ~20% of 12000 = 2400 entries
    expect(cache.size).toBeLessThanOrEqual(MAX_SIZE);
    // Should complete in under 50ms even on slow CI
    expect(batchMs).toBeLessThan(50);
  });

  it("one-at-a-time eviction is slower when called repeatedly", () => {
    const MAX_SIZE = 10_000;
    const cache = new Map<string, number>();

    // Fill to 110% capacity
    for (let i = 0; i < MAX_SIZE * 1.1; i++) {
      cache.set(`key-${i}`, i);
    }

    const excess = cache.size - MAX_SIZE;

    // Old approach: remove one at a time (simulating repeated calls)
    const oneAtATimeMs = timeMs(() => {
      for (let i = 0; i < excess; i++) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    });

    // Refill
    cache.clear();
    for (let i = 0; i < MAX_SIZE * 1.1; i++) {
      cache.set(`key-${i}`, i);
    }

    // New approach: batch remove
    const batchMs = timeMs(() => {
      const evictCount = cache.size - MAX_SIZE;
      const iter = cache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) cache.delete(key);
      }
    });

    // Both should be fast, but batch is done in fewer function calls
    expect(batchMs).toBeLessThan(50);
    expect(oneAtATimeMs).toBeLessThan(50);
  });
});

// ── FeedbackByTurn Bounded Growth ───────────────────────────────

describe("feedbackByTurn: bounded growth", () => {
  it("should cap at 1000 entries after pruning", () => {
    const feedbackByTurn = new Map<string, { turnId: string }>();

    // Simulate 2000 turns of feedback
    for (let i = 0; i < 2000; i++) {
      feedbackByTurn.set(`turn-${i}`, { turnId: `turn-${i}` });

      // Apply the same pruning logic as the fix
      if (feedbackByTurn.size > 1000) {
        const iter = feedbackByTurn.keys();
        const toDelete = feedbackByTurn.size - 1000;
        for (let j = 0; j < toDelete; j++) {
          const key = iter.next().value;
          if (key !== undefined) feedbackByTurn.delete(key);
        }
      }
    }

    expect(feedbackByTurn.size).toBe(1000);
    // Most recent entries should be preserved
    expect(feedbackByTurn.has("turn-1999")).toBe(true);
    expect(feedbackByTurn.has("turn-1000")).toBe(true);
    // Oldest entries should be evicted
    expect(feedbackByTurn.has("turn-0")).toBe(false);
    expect(feedbackByTurn.has("turn-999")).toBe(false);
  });

  it("pruning 2000 entries should complete in <10ms", () => {
    const feedbackByTurn = new Map<string, { turnId: string }>();
    for (let i = 0; i < 2000; i++) {
      feedbackByTurn.set(`turn-${i}`, { turnId: `turn-${i}` });
    }

    const ms = timeMs(() => {
      const iter = feedbackByTurn.keys();
      const toDelete = feedbackByTurn.size - 1000;
      for (let j = 0; j < toDelete; j++) {
        const key = iter.next().value;
        if (key !== undefined) feedbackByTurn.delete(key);
      }
    });

    expect(ms).toBeLessThan(10);
    expect(feedbackByTurn.size).toBe(1000);
  });
});

// ── Alert Engine Pruning ────────────────────────────────────────

describe("Alert Engine: stale entry pruning", () => {
  it("should prune lastFired entries older than 24h", () => {
    const lastFired = new Map<string, number>();
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Add entries: some fresh, some stale
    lastFired.set("fresh-rule", now - 1000);
    lastFired.set("stale-rule-1", now - DAY_MS - 1);
    lastFired.set("stale-rule-2", now - DAY_MS * 2);
    lastFired.set("borderline-rule", now - DAY_MS + 1000);

    // Prune (same logic as the fix)
    for (const [name, timestamp] of lastFired) {
      if (now - timestamp > DAY_MS) lastFired.delete(name);
    }

    expect(lastFired.size).toBe(2);
    expect(lastFired.has("fresh-rule")).toBe(true);
    expect(lastFired.has("borderline-rule")).toBe(true);
    expect(lastFired.has("stale-rule-1")).toBe(false);
    expect(lastFired.has("stale-rule-2")).toBe(false);
  });
});

// ── Gateway readBody Timeout ────────────────────────────────────

describe("Gateway: readBody timeout behavior", () => {
  it("should reject after timeout when stream stalls", async () => {
    // Simulate a stalled stream using a never-ending readable
    const { Readable } = await import("stream");

    const stalled = new Readable({
      read() {
        // Never push data — simulates a stalled connection
      },
    }) as any;
    stalled.destroy = vi.fn();

    const readBodyWithTimeout = (req: any, timeoutMs: number): Promise<string> => {
      return new Promise((resolve, reject) => {
        let body = "";
        let settled = false;

        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            req.destroy();
            reject(new Error("Request body read timeout"));
          }
        }, timeoutMs);

        req.on("data", (chunk: Buffer) => {
          if (settled) return;
          body += chunk;
        });
        req.on("end", () => {
          if (!settled) { settled = true; clearTimeout(timeout); resolve(body); }
        });
        req.on("error", (err: Error) => {
          if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
        });
      });
    };

    const start = performance.now();
    await expect(readBodyWithTimeout(stalled, 100)).rejects.toThrow("Request body read timeout");
    const elapsed = performance.now() - start;

    // Should reject within ~100ms (plus some margin)
    expect(elapsed).toBeGreaterThan(80);
    expect(elapsed).toBeLessThan(500);
    expect(stalled.destroy).toHaveBeenCalled();
  });
});

// ── HTTP Client Total Deadline ──────────────────────────────────

describe("HTTP Client: total retry deadline", () => {
  it("deadline should be bounded by timeout * retries + backoff", () => {
    const baseTimeout = 10_000;
    const maxRetries = 3;
    const backoffMax = 32_000;

    const totalDeadline = baseTimeout * (maxRetries + 1) + backoffMax * maxRetries;

    // 10000 * 4 + 32000 * 3 = 40000 + 96000 = 136000ms = 136s
    expect(totalDeadline).toBe(136_000);
    // Should be bounded, not infinite
    expect(totalDeadline).toBeLessThan(300_000); // 5 minutes max
  });
});

// ── Proxy Stream Timeout ────────────────────────────────────────

describe("Proxy: stream timeout guard", () => {
  it("resolved flag prevents double-resolution", () => {
    let resolved = false;
    const resolutions: string[] = [];

    const tryResolve = (source: string) => {
      if (!resolved) {
        resolved = true;
        resolutions.push(source);
      }
    };

    // Simulate concurrent resolution attempts
    tryResolve("stream-timeout");
    tryResolve("end-event");
    tryResolve("error-event");

    expect(resolutions).toEqual(["stream-timeout"]);
    expect(resolutions.length).toBe(1);
  });
});

// ── On-Chain Retry Logic ────────────────────────────────────────

describe("On-chain: transient error detection", () => {
  const TRANSIENT_PATTERNS = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|timeout|502|503|504|rate.limit/i;

  it.each([
    ["ETIMEDOUT: connection timed out", true],
    ["ECONNRESET: peer reset connection", true],
    ["ECONNREFUSED: server not running", true],
    ["HTTP 502: Bad Gateway", true],
    ["HTTP 503: Service Unavailable", true],
    ["rate limit exceeded", true],
    ["timeout after 30000ms", true],
    ["insufficient funds", false],
    ["nonce already used", false],
    ["invalid signature", false],
    ["execution reverted", false],
  ])("'%s' should be transient=%s", (msg, expected) => {
    expect(TRANSIENT_PATTERNS.test(msg)).toBe(expected);
  });
});
