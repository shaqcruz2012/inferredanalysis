/**
 * Free Tier — comprehensive tests
 *
 * Covers checkFreeTier() boundary enforcement, rolling 24-hour window,
 * multi-IP isolation, recordFreeTierUsage() logging, and schema idempotency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Mock ulid so we get predictable but unique IDs
let ulidCounter = 0;
vi.mock("ulid", () => ({
  ulid: () => `01TEST${String(++ulidCounter).padStart(6, "0")}`,
}));

import {
  checkFreeTier,
  recordFreeTierUsage,
  ensureFreeTierSchema,
} from "../skills/revenue/free-tier.js";

// ─── Helpers ──────────────────────────────────────────────────────

function createDb(): InstanceType<typeof Database> {
  return new Database(":memory:");
}

/**
 * Insert a usage row with an explicit timestamp so we can simulate
 * old entries that fall outside the 24-hour window.
 */
function insertUsageAt(
  db: InstanceType<typeof Database>,
  clientIp: string,
  usedAt: Date,
  skillName = "test-skill",
): void {
  ensureFreeTierSchema(db);
  db.prepare(
    "INSERT INTO free_tier_usage (id, client_ip, skill_name, used_at) VALUES (?, ?, ?, ?)",
  ).run(`manual-${++ulidCounter}`, clientIp, skillName, usedAt.toISOString());
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ensureFreeTierSchema", () => {
  it("creates the free_tier_usage table", () => {
    const db = createDb();
    ensureFreeTierSchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='free_tier_usage'",
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("free_tier_usage");
  });

  it("is idempotent — calling twice does not throw", () => {
    const db = createDb();
    ensureFreeTierSchema(db);
    expect(() => ensureFreeTierSchema(db)).not.toThrow();
  });

  it("is idempotent — table structure unchanged after second call", () => {
    const db = createDb();
    ensureFreeTierSchema(db);

    // Insert a row before the second call
    db.prepare(
      "INSERT INTO free_tier_usage (id, client_ip, skill_name, used_at) VALUES (?, ?, ?, ?)",
    ).run("idempotent-test", "1.2.3.4", "skill", new Date().toISOString());

    ensureFreeTierSchema(db);

    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM free_tier_usage")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("creates the index on (client_ip, used_at)", () => {
    const db = createDb();
    ensureFreeTierSchema(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_free_tier_ip_used'",
      )
      .all() as { name: string }[];

    expect(indexes).toHaveLength(1);
  });
});

describe("checkFreeTier", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = createDb();
  });

  it("allows the first call for a new IP", () => {
    const result = checkFreeTier(db, "10.0.0.1");
    expect(result.eligible).toBe(true);
    expect(result.remaining).toBe(3);
  });

  it("decrements remaining after each recorded usage", () => {
    recordFreeTierUsage(db, "10.0.0.1", "summarize");
    const r1 = checkFreeTier(db, "10.0.0.1");
    expect(r1.eligible).toBe(true);
    expect(r1.remaining).toBe(2);

    recordFreeTierUsage(db, "10.0.0.1", "summarize");
    const r2 = checkFreeTier(db, "10.0.0.1");
    expect(r2.eligible).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it("allows exactly 3 calls, rejects the 4th", () => {
    recordFreeTierUsage(db, "10.0.0.1", "summarize");
    recordFreeTierUsage(db, "10.0.0.1", "summarize");
    recordFreeTierUsage(db, "10.0.0.1", "summarize");

    const result = checkFreeTier(db, "10.0.0.1");
    expect(result.eligible).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("returns remaining=0 when exactly at the limit (3 used)", () => {
    recordFreeTierUsage(db, "10.0.0.1", "a");
    recordFreeTierUsage(db, "10.0.0.1", "b");
    recordFreeTierUsage(db, "10.0.0.1", "c");

    const result = checkFreeTier(db, "10.0.0.1");
    expect(result.eligible).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("stays at remaining=0 even with more than 3 usages recorded", () => {
    // Manually insert 5 rows to simulate an edge case
    for (let i = 0; i < 5; i++) {
      recordFreeTierUsage(db, "10.0.0.1", "over-use");
    }

    const result = checkFreeTier(db, "10.0.0.1");
    expect(result.eligible).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("checkFreeTier — rolling 24-hour window", () => {
  let db: InstanceType<typeof Database>;
  const IP = "192.168.1.100";

  beforeEach(() => {
    db = createDb();
  });

  it("ignores usage older than 24 hours", () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);

    // Insert 3 expired usages
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, twentyFiveHoursAgo);

    const result = checkFreeTier(db, IP);
    expect(result.eligible).toBe(true);
    expect(result.remaining).toBe(3);
  });

  it("counts only recent usage within 24 hours", () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);

    // 2 expired + 1 recent = 1 counted
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, oneHourAgo);

    const result = checkFreeTier(db, IP);
    expect(result.eligible).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("resets eligibility once old entries expire", () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);

    // Fill quota with expired rows
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, twentyFiveHoursAgo);
    insertUsageAt(db, IP, twentyFiveHoursAgo);

    // Should be eligible again
    const result = checkFreeTier(db, IP);
    expect(result.eligible).toBe(true);
    expect(result.remaining).toBe(3);

    // Now record a fresh usage
    recordFreeTierUsage(db, IP, "summarize");

    const result2 = checkFreeTier(db, IP);
    expect(result2.eligible).toBe(true);
    expect(result2.remaining).toBe(2);
  });

  it("usage exactly at the 24-hour boundary is excluded", () => {
    // Insert usage at exactly 24 hours ago (should be just barely excluded
    // since the query uses > not >=)
    const exactly24hAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    insertUsageAt(db, IP, exactly24hAgo);
    insertUsageAt(db, IP, exactly24hAgo);
    insertUsageAt(db, IP, exactly24hAgo);

    // The cutoff is computed as Date.now() - 24h; the query uses "used_at > cutoff".
    // Rows at exactly the cutoff are NOT counted (strict >), so all 3 are free.
    const result = checkFreeTier(db, IP);
    expect(result.eligible).toBe(true);
    expect(result.remaining).toBe(3);
  });

  it("usage just inside the window is counted", () => {
    const justInside = new Date(Date.now() - 23 * 60 * 60 * 1000);

    insertUsageAt(db, IP, justInside);
    insertUsageAt(db, IP, justInside);
    insertUsageAt(db, IP, justInside);

    const result = checkFreeTier(db, IP);
    expect(result.eligible).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("checkFreeTier — multiple IPs tracked independently", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = createDb();
  });

  it("separate IPs have independent quotas", () => {
    // Exhaust IP-A
    recordFreeTierUsage(db, "1.1.1.1", "summarize");
    recordFreeTierUsage(db, "1.1.1.1", "summarize");
    recordFreeTierUsage(db, "1.1.1.1", "summarize");

    // IP-B should still be fully eligible
    const resultB = checkFreeTier(db, "2.2.2.2");
    expect(resultB.eligible).toBe(true);
    expect(resultB.remaining).toBe(3);

    // IP-A should be exhausted
    const resultA = checkFreeTier(db, "1.1.1.1");
    expect(resultA.eligible).toBe(false);
    expect(resultA.remaining).toBe(0);
  });

  it("usage by one IP does not affect another", () => {
    recordFreeTierUsage(db, "1.1.1.1", "summarize");
    recordFreeTierUsage(db, "2.2.2.2", "summarize");

    const r1 = checkFreeTier(db, "1.1.1.1");
    const r2 = checkFreeTier(db, "2.2.2.2");

    expect(r1.remaining).toBe(2);
    expect(r2.remaining).toBe(2);
  });

  it("handles many IPs without crosstalk", () => {
    const ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"];

    // Record varying usage per IP
    for (let i = 0; i < ips.length; i++) {
      for (let j = 0; j <= i; j++) {
        recordFreeTierUsage(db, ips[i], "skill");
      }
    }

    // IP 0 used 1, IP 1 used 2, IP 2 used 3, IP 3 used 4, IP 4 used 5
    expect(checkFreeTier(db, ips[0]).remaining).toBe(2); // 3-1
    expect(checkFreeTier(db, ips[1]).remaining).toBe(1); // 3-2
    expect(checkFreeTier(db, ips[2]).remaining).toBe(0); // 3-3
    expect(checkFreeTier(db, ips[3]).remaining).toBe(0); // 3-4, clamped
    expect(checkFreeTier(db, ips[4]).remaining).toBe(0); // 3-5, clamped
  });
});

describe("recordFreeTierUsage", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = createDb();
  });

  it("inserts a row into free_tier_usage", () => {
    recordFreeTierUsage(db, "1.2.3.4", "summarize");

    const rows = db.prepare("SELECT * FROM free_tier_usage").all() as {
      client_ip: string;
      skill_name: string;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].client_ip).toBe("1.2.3.4");
    expect(rows[0].skill_name).toBe("summarize");
  });

  it("records the correct skill name", () => {
    recordFreeTierUsage(db, "1.2.3.4", "translate");
    recordFreeTierUsage(db, "1.2.3.4", "summarize");

    const rows = db
      .prepare("SELECT skill_name FROM free_tier_usage ORDER BY used_at")
      .all() as { skill_name: string }[];

    expect(rows.map((r) => r.skill_name)).toEqual(["translate", "summarize"]);
  });

  it("assigns a unique ID per row", () => {
    recordFreeTierUsage(db, "1.2.3.4", "a");
    recordFreeTierUsage(db, "1.2.3.4", "b");

    const rows = db.prepare("SELECT id FROM free_tier_usage").all() as {
      id: string;
    }[];

    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("records a valid ISO 8601 used_at timestamp", () => {
    const before = new Date().toISOString();
    recordFreeTierUsage(db, "1.2.3.4", "summarize");
    const after = new Date().toISOString();

    const row = db.prepare("SELECT used_at FROM free_tier_usage").get() as {
      used_at: string;
    };

    expect(row.used_at >= before).toBe(true);
    expect(row.used_at <= after).toBe(true);
  });

  it("counts toward checkFreeTier usage", () => {
    expect(checkFreeTier(db, "1.2.3.4").remaining).toBe(3);

    recordFreeTierUsage(db, "1.2.3.4", "summarize");
    expect(checkFreeTier(db, "1.2.3.4").remaining).toBe(2);

    recordFreeTierUsage(db, "1.2.3.4", "translate");
    expect(checkFreeTier(db, "1.2.3.4").remaining).toBe(1);
  });

  it("counts usage across different skills against the same quota", () => {
    recordFreeTierUsage(db, "1.2.3.4", "summarize");
    recordFreeTierUsage(db, "1.2.3.4", "translate");
    recordFreeTierUsage(db, "1.2.3.4", "analyze");

    const result = checkFreeTier(db, "1.2.3.4");
    expect(result.eligible).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
