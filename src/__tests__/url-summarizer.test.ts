/**
 * URL Summarizer – validateUrl SSRF prevention tests
 *
 * Covers protocol enforcement, localhost blocking, and private/internal
 * IP range rejection to prevent Server-Side Request Forgery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock heavy dependencies so the module can be imported without OOM
vi.mock("better-sqlite3", () => ({ default: {} }));
vi.mock("ulid", () => ({ ulid: () => "01TEST" }));
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
  validateUrl,
  summarizeUrlForClient,
  resetHealthCache,
  flushPendingStats,
  SKILL_METADATA,
} from "../skills/revenue/url-summarizer.js";
import { logRevenue, logExpense } from "../local/accounting.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Assert that validateUrl does NOT throw for the given URL */
function expectAccepted(url: string): void {
  expect(() => validateUrl(url)).not.toThrow();
}

/** Assert that validateUrl throws with a message matching `pattern` */
function expectBlocked(url: string, pattern: RegExp): void {
  expect(() => validateUrl(url)).toThrow(pattern);
}

// ─── Tests ──────────────────────────────────────────────────────

describe("validateUrl", () => {
  // ── Accepted protocols ──────────────────────────────────────

  it("accepts valid https URLs", () => {
    expectAccepted("https://example.com");
    expectAccepted("https://example.com/path?q=1#frag");
  });

  it("accepts valid http URLs", () => {
    expectAccepted("http://example.com");
    expectAccepted("http://example.com:8080/api");
  });

  // ── Rejected protocols ──────────────────────────────────────

  it("rejects file:// protocol", () => {
    expectBlocked("file:///etc/passwd", /Blocked URL protocol/);
  });

  it("rejects ftp:// protocol", () => {
    expectBlocked("ftp://files.example.com/data.csv", /Blocked URL protocol/);
  });

  // ── Localhost blocking ──────────────────────────────────────

  it("blocks localhost", () => {
    expectBlocked("http://localhost/admin", /localhost/);
    expectBlocked("https://localhost:3000", /localhost/);
  });

  it("blocks 127.0.0.1", () => {
    expectBlocked("http://127.0.0.1/secret", /private\/internal IP/);
    expectBlocked("http://127.0.0.1:9003/health", /private\/internal IP/);
  });

  // ── Private IP ranges ──────────────────────────────────────

  it("blocks 10.x.x.x (10.0.0.0/8)", () => {
    expectBlocked("http://10.0.0.1/api", /private\/internal IP/);
    expectBlocked("http://10.255.255.255", /private\/internal IP/);
  });

  it("blocks 172.16.x.x (172.16.0.0/12)", () => {
    expectBlocked("http://172.16.0.1", /private\/internal IP/);
    expectBlocked("http://172.31.255.255", /private\/internal IP/);
  });

  it("blocks 192.168.x.x (192.168.0.0/16)", () => {
    expectBlocked("http://192.168.0.1", /private\/internal IP/);
    expectBlocked("http://192.168.255.255", /private\/internal IP/);
  });

  it("blocks 169.254.x.x (link-local / cloud metadata)", () => {
    expectBlocked("http://169.254.169.254/latest/meta-data", /private\/internal IP/);
    expectBlocked("http://169.254.0.1", /private\/internal IP/);
  });

  it("blocks 0.0.0.0", () => {
    expectBlocked("http://0.0.0.0", /private\/internal IP/);
    expectBlocked("http://0.0.0.0:8080", /private\/internal IP/);
  });

  // ── Invalid URLs ────────────────────────────────────────────

  it("rejects invalid URLs", () => {
    expectBlocked("not-a-url", /Invalid URL/);
    expectBlocked("", /Invalid URL/);
    expectBlocked("://missing-protocol", /Invalid URL/);
  });

  // ── Public IPs allowed ──────────────────────────────────────

  it("accepts public IPs like 8.8.8.8", () => {
    expectAccepted("http://8.8.8.8");
    expectAccepted("https://1.1.1.1/dns-query");
  });
});

// ─── summarizeUrlForClient E2E Tests ─────────────────────────────

describe("summarizeUrlForClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const mockRun = vi.fn();
  const mockGet = vi.fn();
  const mockDb = {
    prepare: () => ({ get: mockGet, run: mockRun }),
  } as any;

  const validInput = {
    url: "https://example.com/article",
    apiKey: "test-key-123",
    detail_level: "medium" as const,
  };

  beforeEach(() => {
    resetHealthCache();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockRun.mockReset();
    mockGet.mockReset();
    mockGet.mockReturnValue(undefined); // no prior stats
    vi.mocked(logRevenue).mockReset();
    vi.mocked(logExpense).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Success path ──────────────────────────────────────────────

  it("returns summary and logs revenue + expense on success", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // health check
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Test Article",
          summary: "This is a summary.",
          key_points: ["Point 1", "Point 2"],
          word_count: 42,
        }),
      });

    const result = await summarizeUrlForClient(mockDb, validInput, {
      nicheId: "niche-1",
      experimentId: "exp-1",
    });

    expect(result.success).toBe(true);
    expect(result.title).toBe("Test Article");
    expect(result.summary).toBe("This is a summary.");
    expect(result.keyPoints).toEqual(["Point 1", "Point 2"]);
    expect(result.wordCount).toBe(42);
    expect(result.requestId).toBe("01TEST");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Revenue logged at 1 cent
    expect(logRevenue).toHaveBeenCalledOnce();
    expect(logRevenue).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      source: "skill:url-summarizer",
      amountCents: 1,
      nicheId: "niche-1",
      experimentId: "exp-1",
    }));

    // Expense logged at Math.round(20/10) = 2 cents
    expect(logExpense).toHaveBeenCalledOnce();
    expect(logExpense).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      category: "inference",
      amountCents: 2,
      nicheId: "niche-1",
      experimentId: "exp-1",
    }));
  });

  // ── Service down ──────────────────────────────────────────────

  it("returns error when service health check fails", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await summarizeUrlForClient(mockDb, validInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not running");
    expect(result.requestId).toBe("01TEST");

    // No revenue or expense should be logged
    expect(logRevenue).not.toHaveBeenCalled();
    expect(logExpense).not.toHaveBeenCalled();
  });

  // ── Service returns non-200 ───────────────────────────────────

  it("returns failure and updates stats when service returns non-200", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // health check OK
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal server error" }),
      });

    const result = await summarizeUrlForClient(mockDb, validInput);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Internal server error");

    // No revenue logged on failure
    expect(logRevenue).not.toHaveBeenCalled();
    expect(logExpense).not.toHaveBeenCalled();
  });

  it("generates default error message when service returns non-200 without error body", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // health check OK
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      });

    const result = await summarizeUrlForClient(mockDb, validInput);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Service returned 502");
  });

  // ── Network timeout ───────────────────────────────────────────

  it("handles network timeout during summarize call", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // health check OK
      .mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const result = await summarizeUrlForClient(mockDb, validInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // No revenue on failure
    expect(logRevenue).not.toHaveBeenCalled();
  });

  // ── Invalid URL (SSRF) ───────────────────────────────────────

  it("rejects SSRF URLs before making any fetch call", async () => {
    const ssrfInputs = [
      { ...validInput, url: "http://169.254.169.254/latest/meta-data" },
      { ...validInput, url: "http://10.0.0.1/internal" },
      { ...validInput, url: "http://localhost/admin" },
      { ...validInput, url: "file:///etc/passwd" },
      { ...validInput, url: "not-a-url" },
    ];

    for (const input of ssrfInputs) {
      resetHealthCache();
      fetchSpy.mockClear();

      const result = await summarizeUrlForClient(mockDb, input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // No fetch should have been made — SSRF rejected before network call
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  // ── Pricing math ──────────────────────────────────────────────

  it("PRICE_PER_CALL_CENTS is 1 and ESTIMATED_COST_MILLICENTS rounds to 2 cents", () => {
    expect(SKILL_METADATA.pricePerCallCents).toBe(1);
    expect(SKILL_METADATA.estimatedCostMillicents).toBe(20);

    // The code does Math.round(ESTIMATED_COST_MILLICENTS / 10)
    // Math.round(20 / 10) = Math.round(2) = 2
    expect(Math.round(20 / 10)).toBe(2);
  });

  it("logs the correct expense amount derived from millicents conversion", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Pricing Test",
          summary: "Testing pricing math.",
          key_points: [],
          word_count: 10,
        }),
      });

    await summarizeUrlForClient(mockDb, validInput);

    // Verify the exact amountCents passed to logExpense
    const expenseCall = vi.mocked(logExpense).mock.calls[0];
    expect(expenseCall[1].amountCents).toBe(2); // Math.round(20/10) = 2
    expect(expenseCall[1].metadata).toEqual(
      expect.objectContaining({ millicents: 20 }),
    );

    // Revenue should be 1 cent
    const revenueCall = vi.mocked(logRevenue).mock.calls[0];
    expect(revenueCall[1].amountCents).toBe(1);
  });

  // ── Stats flushing on success ─────────────────────────────────

  it("flushPendingStats writes accumulated stats to DB", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Stats Test",
          summary: "Testing stats.",
          key_points: [],
          word_count: 5,
        }),
      });

    await summarizeUrlForClient(mockDb, validInput);

    // Force flush pending stats
    flushPendingStats(mockDb);

    // DB should have been written to via prepare().run()
    expect(mockRun).toHaveBeenCalled();
    // The last run call should write to kv with url_summarizer_stats
    const lastRunCall = mockRun.mock.calls[mockRun.mock.calls.length - 1];
    expect(lastRunCall[0]).toBe("url_summarizer_stats");
    const writtenStats = JSON.parse(lastRunCall[1]);
    expect(writtenStats.total).toBeGreaterThanOrEqual(1);
    expect(writtenStats.success).toBeGreaterThanOrEqual(1);
  });
});
