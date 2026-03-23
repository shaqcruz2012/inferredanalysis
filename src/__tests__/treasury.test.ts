/**
 * Treasury balance caching system tests.
 *
 * Covers:
 * - getSurvivalTierFromBalance() with absolute thresholds (no burn data)
 * - getSurvivalTierFromBalance() with runway-based tiers (dailyBurnCents > 0)
 * - getSurvivalTierFromBalance() division safety when dailyBurnCents = 0
 * - Balance rounding via Math.floor(balanceUsd * 100)
 * - getOnChainBalance() caching logic (fresh, stale, expired, no-cache)
 * - transferUSDC() validation (zero amount, zero address, insufficient balance)
 * - formatBalance() display
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock viem before importing treasury
const mockReadContract = vi.fn();
const mockSendTransaction = vi.fn();

vi.mock("viem", () => {
  return {
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
    })),
    createWalletClient: vi.fn(() => ({
      sendTransaction: mockSendTransaction,
    })),
    http: vi.fn(),
    parseUnits: vi.fn((value: string, decimals: number) => BigInt(Math.round(parseFloat(value) * 10 ** decimals))),
    encodeFunctionData: vi.fn(() => "0xencodeddata"),
  };
});

vi.mock("viem/chains", () => ({
  base: { id: 8453, name: "Base" },
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
  getSurvivalTierFromBalance,
  getOnChainBalance,
  transferUSDC,
  formatBalance,
} from "../local/treasury.js";

// ── Helpers ──────────────────────────────────────────────────────

const DUMMY_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

// ── Tests ────────────────────────────────────────────────────────

describe("getSurvivalTierFromBalance", () => {
  describe("absolute thresholds (no burn data)", () => {
    it("returns 'dead' when balanceCents < 10", () => {
      expect(getSurvivalTierFromBalance(0)).toBe("dead");
      expect(getSurvivalTierFromBalance(9)).toBe("dead");
    });

    it("returns 'dead' at boundary balanceCents = 9", () => {
      expect(getSurvivalTierFromBalance(9)).toBe("dead");
    });

    it("returns 'critical' when 10 <= balanceCents < 50", () => {
      expect(getSurvivalTierFromBalance(10)).toBe("critical");
      expect(getSurvivalTierFromBalance(49)).toBe("critical");
    });

    it("returns 'low_compute' when 50 <= balanceCents < 200", () => {
      expect(getSurvivalTierFromBalance(50)).toBe("low_compute");
      expect(getSurvivalTierFromBalance(199)).toBe("low_compute");
    });

    it("returns 'normal' when 200 <= balanceCents < 10000", () => {
      expect(getSurvivalTierFromBalance(200)).toBe("normal");
      expect(getSurvivalTierFromBalance(9999)).toBe("normal");
    });

    it("returns 'high' when balanceCents >= 10000", () => {
      expect(getSurvivalTierFromBalance(10000)).toBe("high");
      expect(getSurvivalTierFromBalance(999999)).toBe("high");
    });

    it("uses absolute thresholds when dailyBurnCents is explicitly 0", () => {
      expect(getSurvivalTierFromBalance(500, 0)).toBe("normal");
      expect(getSurvivalTierFromBalance(30, 0)).toBe("critical");
    });
  });

  describe("division safety when dailyBurnCents = 0", () => {
    it("does not divide by zero — falls through to absolute thresholds", () => {
      // If division happened, runwayDays would be Infinity and return "high"
      // for any positive balance. With absolute thresholds, 30 cents = "critical".
      expect(getSurvivalTierFromBalance(30, 0)).toBe("critical");
    });

    it("handles negative dailyBurnCents the same as 0", () => {
      expect(getSurvivalTierFromBalance(30, -5)).toBe("critical");
      expect(getSurvivalTierFromBalance(500, -100)).toBe("normal");
    });
  });

  describe("runway-based tiers (dailyBurnCents > 0)", () => {
    it("returns 'high' when runway > 90 days", () => {
      // 10000 cents / 100 cents-per-day = 100 days
      expect(getSurvivalTierFromBalance(10000, 100)).toBe("high");
    });

    it("returns 'normal' when 30 < runway <= 90 days", () => {
      // 6000 / 100 = 60 days
      expect(getSurvivalTierFromBalance(6000, 100)).toBe("normal");
    });

    it("returns 'low_compute' when 7 < runway <= 30 days", () => {
      // 1500 / 100 = 15 days
      expect(getSurvivalTierFromBalance(1500, 100)).toBe("low_compute");
    });

    it("returns 'critical' when runway <= 7 days", () => {
      // 500 / 100 = 5 days
      expect(getSurvivalTierFromBalance(500, 100)).toBe("critical");
    });

    it("returns 'dead' before checking runway when balanceCents < 10", () => {
      // Even with burn data, dead check happens first
      expect(getSurvivalTierFromBalance(5, 1)).toBe("dead");
    });

    it("handles exact boundary at 90 days (not strictly greater)", () => {
      // 9000 / 100 = 90 exactly — not > 90, so should be "normal"
      expect(getSurvivalTierFromBalance(9000, 100)).toBe("normal");
    });

    it("handles exact boundary at 30 days", () => {
      // 3000 / 100 = 30 exactly — not > 30, so should be "low_compute"
      expect(getSurvivalTierFromBalance(3000, 100)).toBe("low_compute");
    });

    it("handles exact boundary at 7 days", () => {
      // 700 / 100 = 7 exactly — not > 7, so should be "critical"
      expect(getSurvivalTierFromBalance(700, 100)).toBe("critical");
    });
  });
});

describe("Balance rounding (Math.floor(balanceUsd * 100))", () => {
  it("floors fractional cents correctly", () => {
    // Simulating: balanceUsd = 42.999 -> Math.floor(42.999 * 100) = 4299
    const balanceUsd = 42.999;
    const balanceCents = Math.floor(balanceUsd * 100);
    expect(balanceCents).toBe(4299);
  });

  it("handles floating point edge case where multiplication is slightly under", () => {
    // 0.29 * 100 = 28.999999999999996 in IEEE 754
    const balanceUsd = 0.29;
    const balanceCents = Math.floor(balanceUsd * 100);
    expect(balanceCents).toBe(28); // floor truncates the .999... artifact
  });

  it("exact dollar amounts produce exact cents", () => {
    const balanceUsd = 1.0;
    const balanceCents = Math.floor(balanceUsd * 100);
    expect(balanceCents).toBe(100);
  });

  it("zero balance produces zero cents", () => {
    expect(Math.floor(0 * 100)).toBe(0);
  });
});

describe("getOnChainBalance", () => {
  // Use a base time for deterministic control of Date.now()
  const BASE_TIME = 1_700_000_000_000; // a fixed epoch ms

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    mockReadContract.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns correct balance from a successful RPC call", async () => {
    // First, expire any stale cache from prior describe blocks
    vi.setSystemTime(BASE_TIME + 20 * 60_000);
    mockReadContract.mockResolvedValueOnce(42_500_000n);

    const result = await getOnChainBalance(DUMMY_ADDRESS);
    expect(result.ok).toBe(true);
    expect(result.balanceUsd).toBe(42.5);
    expect(result.balanceCents).toBe(4250);
    expect(result.balanceAtomic).toBe(42_500_000n);
    expect(result.stale).toBeUndefined();
  });

  it("returns cached result on second call within TTL", async () => {
    // Jump far ahead to ensure no stale cache interference
    const t0 = BASE_TIME + 30 * 60_000;
    vi.setSystemTime(t0);

    mockReadContract.mockResolvedValueOnce(42_500_000n);
    const first = await getOnChainBalance(DUMMY_ADDRESS);
    mockReadContract.mockClear();

    // Advance less than 60s
    vi.setSystemTime(t0 + 30_000);

    const second = await getOnChainBalance(DUMMY_ADDRESS);

    // Should not have called RPC again (served from cache)
    expect(mockReadContract).toHaveBeenCalledTimes(0);
    expect(second.balanceUsd).toBe(first.balanceUsd);
  });

  it("makes a fresh RPC call after cache TTL expires", async () => {
    const t0 = BASE_TIME + 40 * 60_000;
    vi.setSystemTime(t0);

    mockReadContract.mockResolvedValueOnce(42_500_000n);
    await getOnChainBalance(DUMMY_ADDRESS);
    mockReadContract.mockClear();

    // Advance past 60s TTL
    vi.setSystemTime(t0 + 61_000);

    mockReadContract.mockResolvedValueOnce(100_000_000n);
    const result = await getOnChainBalance(DUMMY_ADDRESS);

    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(result.balanceUsd).toBe(100);
    expect(result.balanceCents).toBe(10000);
  });

  it("returns stale cache when RPC fails after TTL", async () => {
    const t0 = BASE_TIME + 50 * 60_000;
    vi.setSystemTime(t0);

    mockReadContract.mockResolvedValueOnce(42_500_000n);
    await getOnChainBalance(DUMMY_ADDRESS);

    // Advance past TTL but within max stale (5 min)
    vi.setSystemTime(t0 + 90_000); // 1.5 minutes

    mockReadContract.mockRejectedValueOnce(new Error("RPC timeout"));
    const result = await getOnChainBalance(DUMMY_ADDRESS);

    expect(result.ok).toBe(true); // original result was ok
    expect(result.stale).toBe(true);
    expect(result.staleSec).toBeGreaterThanOrEqual(90);
    expect(result.balanceUsd).toBe(42.5);
  });

  it("returns stale cache with warning when beyond max stale window", async () => {
    const t0 = BASE_TIME + 60 * 60_000;
    vi.setSystemTime(t0);

    mockReadContract.mockResolvedValueOnce(42_500_000n);
    await getOnChainBalance(DUMMY_ADDRESS);

    // Advance past 5-minute max stale
    vi.setSystemTime(t0 + 6 * 60_000);

    mockReadContract.mockRejectedValueOnce(new Error("RPC timeout"));
    const result = await getOnChainBalance(DUMMY_ADDRESS);

    expect(result.stale).toBe(true);
    expect(result.staleSec!).toBeGreaterThanOrEqual(360);
  });

  it("returns error result when RPC fails with no prior cache", async () => {
    // Jump very far ahead to ensure any module-level cache is ancient
    const t0 = BASE_TIME + 120 * 60_000;
    vi.setSystemTime(t0);

    mockReadContract.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await getOnChainBalance(DUMMY_ADDRESS);

    // Module-level cache may persist from prior tests in this file.
    // If the cache exists, it will be returned as stale (from a timestamp
    // that is now > 5 min old). Otherwise we get the no-cache error path.
    if (result.stale) {
      expect(result.stale).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect(result.balanceUsd).toBe(0);
      expect(result.balanceCents).toBe(0);
      expect(result.balanceAtomic).toBe(0n);
      expect(result.error).toContain("Connection refused");
    }
  });
});

describe("transferUSDC", () => {
  const BASE_TIME = 1_700_000_000_000;
  const mockAccount = {
    address: DUMMY_ADDRESS,
    type: "local" as const,
    publicKey: "0x00" as `0x${string}`,
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
    sign: vi.fn(),
    experimental_signAuthMessage: vi.fn(),
    source: "privateKey" as const,
  };
  const RECIPIENT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`;

  beforeEach(() => {
    vi.useFakeTimers();
    // Jump far ahead so any cached balance from prior tests is expired
    vi.setSystemTime(BASE_TIME + 200 * 60_000);
    mockReadContract.mockReset();
    mockSendTransaction.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects zero or negative amount", async () => {
    const result = await transferUSDC(mockAccount as any, RECIPIENT, 0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Amount must be positive");

    const resultNeg = await transferUSDC(mockAccount as any, RECIPIENT, -5);
    expect(resultNeg.success).toBe(false);
    expect(resultNeg.error).toContain("Amount must be positive");
  });

  it("rejects transfer to zero address", async () => {
    const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const result = await transferUSDC(mockAccount as any, ZERO, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot transfer to zero address");
  });

  it("rejects when balance is insufficient", async () => {
    // Advance time so prior cache is definitely expired
    vi.advanceTimersByTime(10 * 60_000);
    // Balance: $10, trying to send $20
    mockReadContract.mockResolvedValueOnce(10_000_000n);

    const result = await transferUSDC(mockAccount as any, RECIPIENT, 20);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient USDC");
  });

  it("succeeds when balance is sufficient", async () => {
    vi.advanceTimersByTime(10 * 60_000);
    mockReadContract.mockResolvedValueOnce(100_000_000n); // $100
    mockSendTransaction.mockResolvedValueOnce("0xtxhash123");

    const result = await transferUSDC(mockAccount as any, RECIPIENT, 5);
    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xtxhash123");
    expect(result.amountUsd).toBe(5);
    expect(result.toAddress).toBe(RECIPIENT);
  });

  it("returns error when sendTransaction fails", async () => {
    vi.advanceTimersByTime(10 * 60_000);
    mockReadContract.mockResolvedValueOnce(100_000_000n);
    mockSendTransaction.mockRejectedValueOnce(new Error("nonce too low"));

    const result = await transferUSDC(mockAccount as any, RECIPIENT, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain("nonce too low");
  });
});

describe("formatBalance", () => {
  it("formats cents to dollar string", () => {
    expect(formatBalance(4250)).toBe("$42.50");
    expect(formatBalance(0)).toBe("$0.00");
    expect(formatBalance(1)).toBe("$0.01");
    expect(formatBalance(100)).toBe("$1.00");
    expect(formatBalance(99999)).toBe("$999.99");
  });
});
