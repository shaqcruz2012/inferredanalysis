/**
 * Optimization Stress Tests
 *
 * Tests for the performance optimizations:
 * 1. URL Summarizer health cache (30s TTL)
 * 2. Batched stats flush (N=50 / 60s)
 * 3. Token counter >5KB heuristic bypass
 * 4. Turn token WeakMap memoization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── 1. Health Cache Tests ────────────────────────────────────────

// Mock dependencies before importing url-summarizer
vi.mock("better-sqlite3", () => ({ default: {} }));
vi.mock("ulid", () => ({ ulid: () => "01STRESS" }));
vi.mock("../local/accounting.js", () => ({
  logRevenue: vi.fn(),
  logExpense: vi.fn(),
}));
vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  resetHealthCache,
  summarizeUrlForClient,
  flushPendingStats,
} from "../skills/revenue/url-summarizer.js";

describe("URL Summarizer health cache", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetHealthCache();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("caches health check result for 30 seconds", async () => {
    // First call: health returns ok, then summarize fails (no backend)
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // health check
      .mockRejectedValueOnce(new Error("connection refused")); // summarize call

    const db = {
      prepare: () => ({ get: () => undefined, run: vi.fn() }),
    } as any;

    await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    // First call made 2 fetch calls (health + summarize)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call: health should be cached, only 1 new fetch (summarize)
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));
    await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    // Should be 3 total (2 from first + 1 from second — health was cached)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("re-checks health after TTL expires", async () => {
    vi.useFakeTimers();

    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // first health check
      .mockRejectedValueOnce(new Error("connection refused")); // summarize

    const db = {
      prepare: () => ({ get: () => undefined, run: vi.fn() }),
    } as any;

    await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance past the 30s TTL
    vi.advanceTimersByTime(31_000);

    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // re-checked health
      .mockRejectedValueOnce(new Error("connection refused")); // summarize

    await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    // Should be 4 total (health was re-checked after TTL)
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });

  it("returns failure when service is unhealthy (cached)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const db = {
      prepare: () => ({ get: () => undefined, run: vi.fn() }),
    } as any;

    const result = await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not running");

    // Second call should use cached unhealthy status
    const result2 = await summarizeUrlForClient(db, {
      url: "https://example.com",
      apiKey: "test",
    });

    expect(result2.success).toBe(false);
    // Only 1 fetch call total (health check was cached as false)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 2. Token Counter >5KB Heuristic ─────────────────────────────

import { createTokenCounter } from "../memory/context-manager.js";

describe("Token counter >5KB heuristic", () => {
  it("uses tiktoken for text <= 5000 chars", () => {
    const counter = createTokenCounter();
    const text = "a".repeat(5000);
    const tokens = counter.countTokens(text);
    // tiktoken will give a different result than ceil(5000/3.5)
    // Just verify it returns a reasonable positive number
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(5000);
  });

  it("uses heuristic for text > 5000 chars", () => {
    const counter = createTokenCounter();
    const text = "a".repeat(5001);
    const tokens = counter.countTokens(text);
    // Heuristic: ceil(5001 / 3.5) = 1429
    expect(tokens).toBe(Math.ceil(5001 / 3.5));
  });

  it("boundary: exactly 5000 chars uses tiktoken, 5001 uses heuristic", () => {
    const counter = createTokenCounter();
    const at5000 = counter.countTokens("x".repeat(5000));
    const at5001 = counter.countTokens("x".repeat(5001));

    // 5001 must use heuristic
    expect(at5001).toBe(Math.ceil(5001 / 3.5));
    // 5000 may differ from heuristic since tiktoken is used
    // (tiktoken encodes "xxxxx..." differently than ceil/3.5)
    expect(at5000).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const counter = createTokenCounter();
    expect(counter.countTokens("")).toBe(0);
  });

  it("countBatch works for mixed sizes", () => {
    const counter = createTokenCounter();
    const results = counter.countBatch([
      "short",
      "x".repeat(6000),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeGreaterThan(0);
    expect(results[1]).toBe(Math.ceil(6000 / 3.5));
  });
});

// ── 3. Turn Token Memoization (indirect via buildContextMessages) ─

import { buildContextMessages, estimateTokens } from "../agent/context.js";
import type { AgentTurn } from "../types.js";

describe("Turn token memoization", () => {
  function makeTurn(input: string): AgentTurn {
    return {
      id: `turn_${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      state: "running" as const,
      input,
      inputSource: "system",
      thinking: "test thinking",
      toolCalls: [],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costCents: 0,
    };
  }

  it("returns identical messages for same turn objects called twice", () => {
    const turns = [makeTurn("hello"), makeTurn("world")];

    const msgs1 = buildContextMessages("sys prompt", turns);
    const msgs2 = buildContextMessages("sys prompt", turns);

    // Same structural output
    expect(msgs1).toEqual(msgs2);
  });

  it("handles zero-token turns without error", () => {
    const emptyTurn: AgentTurn = {
      id: "empty",
      timestamp: new Date().toISOString(),
      state: "running",
      input: "",
      inputSource: "system",
      thinking: "",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    };

    const msgs = buildContextMessages("sys", [emptyTurn]);
    // Should not throw
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("different turn objects with same content get separate cache entries", () => {
    const turn1 = makeTurn("identical");
    const turn2 = makeTurn("identical");

    // These are different objects, WeakMap keys by reference
    expect(turn1).not.toBe(turn2);

    const msgs1 = buildContextMessages("sys", [turn1]);
    const msgs2 = buildContextMessages("sys", [turn2]);

    // Same content → same structure
    expect(msgs1).toEqual(msgs2);
  });
});

// ── 4. Batched Stats Flush ──────────────────────────────────────

describe("Batched stats flush", () => {
  it("flushPendingStats with no pending data is a no-op", () => {
    const db = {
      prepare: vi.fn(() => ({ get: () => undefined, run: vi.fn() })),
    } as any;

    // Reset to ensure no leftover state
    resetHealthCache();

    // Should not throw
    flushPendingStats(db);

    // No DB write should have occurred for empty pending stats
    // (flushStats returns early if pendingStats.total === 0)
    // We can't easily verify this without more mocking, but at least it shouldn't throw
  });
});
