/**
 * Policy Engine Tests
 *
 * Tests for the PolicyEngine class:
 * 1. Returns "allow" when no rules trigger
 * 2. Returns "deny" when a rule denies
 * 3. Continues evaluation when a rule throws (doesn't crash)
 * 4. Handles null request.args gracefully (JSON.stringify doesn't throw)
 * 5. Error logging uses instanceof check, not unsafe cast
 * 6. All evaluated rules are tracked in rulesEvaluated
 * 7. Triggered rules are tracked in rulesTriggered
 * 8. evaluate() with no rules (empty array) defaults to allow
 * 9. evaluate() with a single allow rule
 * 10. Rule exception stops subsequent rule evaluation
 * 11. Conflicting rules — priority ordering and first-deny-wins
 * 12. Empty/invalid action types and argument edge cases
 * 13. Quarantine escalation and deny-overrides-quarantine
 * 14. deriveAuthorityLevel for all InputSource variants
 * 15. ruleApplies selector filtering (name, category, risk, unknown)
 * 16. logDecision error path (DB closed)
 * 17. clearEvaluationCache optional call
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import type {
  AutomatonTool,
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  ToolContext,
  SpendTrackerInterface,
  ToolSelector,
  InputSource,
} from "../types.js";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Test Helpers ───────────────────────────────────────────────

function createRawTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY,
      turn_id TEXT,
      tool_name TEXT NOT NULL,
      tool_args_hash TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
      decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
      rules_evaluated TEXT NOT NULL DEFAULT '[]',
      rules_triggered TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS spend_tracking (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      recipient TEXT,
      domain TEXT,
      category TEXT NOT NULL CHECK(category IN ('transfer','x402','inference','other')),
      window_hour TEXT NOT NULL,
      window_day TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function createMockSpendTracker(): SpendTrackerInterface {
  return {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({
      allowed: true,
      currentHourlySpend: 0,
      currentDailySpend: 0,
      limitHourly: 10000,
      limitDaily: 25000,
    }),
    pruneOldRecords: () => 0,
  };
}

function createMockTool(overrides: Partial<AutomatonTool> = {}): AutomatonTool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    riskLevel: "safe",
    category: "vm",
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<PolicyRequest> = {},
): PolicyRequest {
  return {
    tool: createMockTool(),
    args: { foo: "bar" },
    context: {} as ToolContext,
    turnContext: {
      inputSource: "creator",
      turnToolCallCount: 0,
      sessionSpend: createMockSpendTracker(),
    },
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule> & { id: string }): PolicyRule {
  return {
    description: `Rule: ${overrides.id}`,
    priority: 100,
    appliesTo: { by: "all" },
    evaluate: () => null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("PolicyEngine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createRawTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns 'allow' when no rules trigger", () => {
    const noopRule = makeRule({
      id: "noop",
      evaluate: () => null,
    });
    const engine = new PolicyEngine(db, [noopRule]);
    const decision = engine.evaluate(createRequest());

    expect(decision.action).toBe("allow");
    expect(decision.reasonCode).toBe("ALLOWED");
    expect(decision.humanMessage).toBe("All policy checks passed");
  });

  it("returns 'deny' when a rule denies", () => {
    const denyRule = makeRule({
      id: "hard-deny",
      evaluate: (): PolicyRuleResult => ({
        rule: "hard-deny",
        action: "deny",
        reasonCode: "BLOCKED",
        humanMessage: "Blocked by test rule",
      }),
    });
    const engine = new PolicyEngine(db, [denyRule]);
    const decision = engine.evaluate(createRequest());

    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("BLOCKED");
    expect(decision.humanMessage).toBe("Blocked by test rule");
  });

  it("denies when a rule throws (fail-closed)", () => {
    const throwingRule = makeRule({
      id: "throws",
      priority: 10,
      evaluate: () => {
        throw new Error("kaboom");
      },
    });
    const allowRule = makeRule({
      id: "after-throw",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "after-throw",
        action: "allow",
        reasonCode: "OK",
        humanMessage: "Allowed",
      }),
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new PolicyEngine(db, [throwingRule, allowRule]);
    const decision = engine.evaluate(createRequest());

    // Fail-closed: throwing rule causes a deny, subsequent rules are not evaluated
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("RULE_EVALUATION_ERROR");
    expect(decision.rulesEvaluated).toContain("throws");
    expect(decision.rulesTriggered).toContain("throws");
    // The after-throw rule should NOT have been evaluated (break on deny)
    expect(decision.rulesEvaluated).not.toContain("after-throw");

    consoleSpy.mockRestore();
  });

  it("handles null request.args gracefully (JSON.stringify doesn't throw)", () => {
    const engine = new PolicyEngine(db, []);
    // Pass args as null (cast to satisfy TS) to exercise the `?? {}` fallback
    const request = createRequest({ args: null as unknown as Record<string, unknown> });

    const decision = engine.evaluate(request);

    expect(decision.action).toBe("allow");
    // argsHash should be a valid SHA-256 hex string for '{}'
    expect(decision.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("error logging uses instanceof check, not unsafe cast", () => {
    const throwingRule = makeRule({
      id: "non-error-throw",
      evaluate: () => {
        // Throw a non-Error value to exercise the String(err) branch
        throw "string-error";
      },
    });

    const engine = new PolicyEngine(db, [throwingRule]);
    const decision = engine.evaluate(createRequest());

    // The engine should still deny (fail-closed) even for non-Error throws
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("RULE_EVALUATION_ERROR");
    expect(decision.humanMessage).toContain("non-error-throw");
  });

  it("all evaluated rules are tracked in rulesEvaluated", () => {
    const ruleA = makeRule({
      id: "rule-a",
      priority: 10,
      evaluate: () => null,
    });
    const ruleB = makeRule({
      id: "rule-b",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "rule-b",
        action: "allow",
        reasonCode: "OK",
        humanMessage: "ok",
      }),
    });
    const ruleC = makeRule({
      id: "rule-c",
      priority: 30,
      evaluate: () => null,
    });

    const engine = new PolicyEngine(db, [ruleA, ruleB, ruleC]);
    const decision = engine.evaluate(createRequest());

    expect(decision.rulesEvaluated).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  it("triggered rules are tracked in rulesTriggered", () => {
    const nullRule = makeRule({
      id: "silent",
      priority: 10,
      evaluate: () => null,
    });
    const triggerA = makeRule({
      id: "trigger-a",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "trigger-a",
        action: "allow",
        reasonCode: "OK_A",
        humanMessage: "ok a",
      }),
    });
    const triggerB = makeRule({
      id: "trigger-b",
      priority: 30,
      evaluate: (): PolicyRuleResult => ({
        rule: "trigger-b",
        action: "quarantine",
        reasonCode: "Q_B",
        humanMessage: "quarantine b",
      }),
    });

    const engine = new PolicyEngine(db, [nullRule, triggerA, triggerB]);
    const decision = engine.evaluate(createRequest());

    // Only rules that returned a non-null result appear in rulesTriggered
    expect(decision.rulesTriggered).toEqual(["trigger-a", "trigger-b"]);
    // The silent rule was evaluated but not triggered
    expect(decision.rulesTriggered).not.toContain("silent");
    expect(decision.rulesEvaluated).toContain("silent");
  });

  // ── New: evaluate() with zero rules ─────────────────────────
  describe("evaluate() with no rules (empty array)", () => {
    it("allows by default when the rules array is empty", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("allow");
      expect(decision.reasonCode).toBe("ALLOWED");
      expect(decision.humanMessage).toBe("All policy checks passed");
      expect(decision.rulesEvaluated).toEqual([]);
      expect(decision.rulesTriggered).toEqual([]);
    });
  });

  // ── New: single allow rule ──────────────────────────────────
  describe("evaluate() with a single allow rule", () => {
    it("allows and records the rule as both evaluated and triggered", () => {
      const allowRule = makeRule({
        id: "single-allow",
        evaluate: (): PolicyRuleResult => ({
          rule: "single-allow",
          action: "allow",
          reasonCode: "SINGLE_OK",
          humanMessage: "Single allow passed",
        }),
      });
      const engine = new PolicyEngine(db, [allowRule]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("allow");
      expect(decision.rulesEvaluated).toContain("single-allow");
      expect(decision.rulesTriggered).toContain("single-allow");
    });
  });

  // ── New: rule exception stops subsequent evaluation ─────────
  describe("evaluate() rule exception halts pipeline", () => {
    it("stops evaluating rules after a crash (break)", () => {
      let secondCalled = false;
      const crasher = makeRule({
        id: "crasher",
        priority: 10,
        evaluate: () => {
          throw new Error("boom");
        },
      });
      const follower = makeRule({
        id: "follower",
        priority: 20,
        evaluate: () => {
          secondCalled = true;
          return null;
        },
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const engine = new PolicyEngine(db, [crasher, follower]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("deny");
      expect(secondCalled).toBe(false);
      expect(decision.rulesEvaluated).not.toContain("follower");
      consoleSpy.mockRestore();
    });
  });

  // ── New: conflicting rules / priority handling ──────────────
  describe("evaluate() with conflicting rules and priority", () => {
    it("rules are sorted by priority (lower number first)", () => {
      const order: string[] = [];
      const high = makeRule({
        id: "high",
        priority: 900,
        evaluate: () => { order.push("high"); return null; },
      });
      const low = makeRule({
        id: "low",
        priority: 100,
        evaluate: () => { order.push("low"); return null; },
      });
      const mid = makeRule({
        id: "mid",
        priority: 500,
        evaluate: () => { order.push("mid"); return null; },
      });

      // Deliberately pass in non-sorted order
      const engine = new PolicyEngine(db, [high, low, mid]);
      engine.evaluate(createRequest());

      expect(order).toEqual(["low", "mid", "high"]);
    });

    it("first deny wins and stops evaluation", () => {
      let thirdCalled = false;
      const allowRule = makeRule({
        id: "allow-first",
        priority: 100,
        evaluate: (): PolicyRuleResult => ({
          rule: "allow-first",
          action: "allow",
          reasonCode: "OK",
          humanMessage: "ok",
        }),
      });
      const denyRule = makeRule({
        id: "deny-mid",
        priority: 200,
        evaluate: (): PolicyRuleResult => ({
          rule: "deny-mid",
          action: "deny",
          reasonCode: "MID_DENY",
          humanMessage: "mid deny",
        }),
      });
      const afterDeny = makeRule({
        id: "after-deny",
        priority: 300,
        evaluate: () => {
          thirdCalled = true;
          return null;
        },
      });

      const engine = new PolicyEngine(db, [allowRule, denyRule, afterDeny]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("MID_DENY");
      expect(thirdCalled).toBe(false);
    });

    it("lower-priority deny prevents higher-priority allow from being reached", () => {
      const earlyDeny = makeRule({
        id: "early-deny",
        priority: 50,
        evaluate: (): PolicyRuleResult => ({
          rule: "early-deny",
          action: "deny",
          reasonCode: "EARLY",
          humanMessage: "early deny",
        }),
      });
      const lateAllow = makeRule({
        id: "late-allow",
        priority: 999,
        evaluate: (): PolicyRuleResult => ({
          rule: "late-allow",
          action: "allow",
          reasonCode: "LATE",
          humanMessage: "late allow",
        }),
      });

      const engine = new PolicyEngine(db, [lateAllow, earlyDeny]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("EARLY");
    });
  });

  // ── New: empty / unusual arguments ──────────────────────────
  describe("evaluate() with empty or unusual arguments", () => {
    it("handles empty args object", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(createRequest({ args: {} }));

      expect(decision.action).toBe("allow");
      expect(decision.argsHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces consistent argsHash for identical arguments", () => {
      const engine = new PolicyEngine(db, []);
      const args = { x: 1, y: "two" };
      const d1 = engine.evaluate(createRequest({ args }));
      const d2 = engine.evaluate(createRequest({ args }));
      expect(d1.argsHash).toBe(d2.argsHash);
    });

    it("produces different argsHash for different arguments", () => {
      const engine = new PolicyEngine(db, []);
      const d1 = engine.evaluate(createRequest({ args: { a: 1 } }));
      const d2 = engine.evaluate(createRequest({ args: { b: 2 } }));
      expect(d1.argsHash).not.toBe(d2.argsHash);
    });
  });

  // ── New: quarantine behavior ────────────────────────────────
  describe("quarantine escalation", () => {
    it("quarantine overrides allow", () => {
      const qRule = makeRule({
        id: "q",
        evaluate: (): PolicyRuleResult => ({
          rule: "q",
          action: "quarantine",
          reasonCode: "Q_REASON",
          humanMessage: "quarantined",
        }),
      });
      const engine = new PolicyEngine(db, [qRule]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("quarantine");
      expect(decision.reasonCode).toBe("Q_REASON");
    });

    it("deny overrides a prior quarantine", () => {
      const qRule = makeRule({
        id: "q-first",
        priority: 10,
        evaluate: (): PolicyRuleResult => ({
          rule: "q-first",
          action: "quarantine",
          reasonCode: "Q_FIRST",
          humanMessage: "quarantine first",
        }),
      });
      const denyRule = makeRule({
        id: "deny-second",
        priority: 20,
        evaluate: (): PolicyRuleResult => ({
          rule: "deny-second",
          action: "deny",
          reasonCode: "DENY_WINS",
          humanMessage: "deny wins",
        }),
      });
      const engine = new PolicyEngine(db, [qRule, denyRule]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("DENY_WINS");
    });

    it("second quarantine does not overwrite the first quarantine reason", () => {
      const q1 = makeRule({
        id: "q1",
        priority: 10,
        evaluate: (): PolicyRuleResult => ({
          rule: "q1",
          action: "quarantine",
          reasonCode: "FIRST_Q",
          humanMessage: "first quarantine",
        }),
      });
      const q2 = makeRule({
        id: "q2",
        priority: 20,
        evaluate: (): PolicyRuleResult => ({
          rule: "q2",
          action: "quarantine",
          reasonCode: "SECOND_Q",
          humanMessage: "second quarantine",
        }),
      });
      const engine = new PolicyEngine(db, [q1, q2]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("quarantine");
      // Code only sets quarantine when overallAction === "allow", so first wins
      expect(decision.reasonCode).toBe("FIRST_Q");
    });
  });

  // ── New: deriveAuthorityLevel ───────────────────────────────
  describe("deriveAuthorityLevel", () => {
    it("returns 'external' for undefined", () => {
      expect(PolicyEngine.deriveAuthorityLevel(undefined)).toBe("external");
    });

    it("returns 'external' for heartbeat", () => {
      expect(PolicyEngine.deriveAuthorityLevel("heartbeat")).toBe("external");
    });

    it("returns 'agent' for creator", () => {
      expect(PolicyEngine.deriveAuthorityLevel("creator")).toBe("agent");
    });

    it("returns 'agent' for agent", () => {
      expect(PolicyEngine.deriveAuthorityLevel("agent")).toBe("agent");
    });

    it("returns 'system' for system", () => {
      expect(PolicyEngine.deriveAuthorityLevel("system")).toBe("system");
    });

    it("returns 'system' for wakeup", () => {
      expect(PolicyEngine.deriveAuthorityLevel("wakeup")).toBe("system");
    });

    it("returns 'external' for unknown input source", () => {
      expect(PolicyEngine.deriveAuthorityLevel("unknown" as InputSource)).toBe("external");
    });
  });

  // ── New: ruleApplies selector filtering ─────────────────────
  describe("ruleApplies selector filtering", () => {
    it("by:name matches only listed tool names", () => {
      const rule = makeRule({
        id: "name-filter",
        appliesTo: { by: "name", names: ["target_tool"] },
        evaluate: (): PolicyRuleResult => ({
          rule: "name-filter",
          action: "deny",
          reasonCode: "NAME_HIT",
          humanMessage: "name match",
        }),
      });
      const engine = new PolicyEngine(db, [rule]);

      // Non-matching tool
      const d1 = engine.evaluate(createRequest({ tool: createMockTool({ name: "other_tool" }) }));
      expect(d1.action).toBe("allow");

      // Matching tool
      const d2 = engine.evaluate(createRequest({ tool: createMockTool({ name: "target_tool" }) }));
      expect(d2.action).toBe("deny");
    });

    it("by:category matches only listed categories", () => {
      const rule = makeRule({
        id: "cat-filter",
        appliesTo: { by: "category", categories: ["financial"] } as ToolSelector,
        evaluate: (): PolicyRuleResult => ({
          rule: "cat-filter",
          action: "deny",
          reasonCode: "CAT_HIT",
          humanMessage: "category match",
        }),
      });
      const engine = new PolicyEngine(db, [rule]);

      const d1 = engine.evaluate(createRequest({ tool: createMockTool({ category: "vm" }) }));
      expect(d1.action).toBe("allow");

      const d2 = engine.evaluate(createRequest({ tool: createMockTool({ category: "financial" } as any) }));
      expect(d2.action).toBe("deny");
    });

    it("by:risk matches only listed risk levels", () => {
      const rule = makeRule({
        id: "risk-filter",
        appliesTo: { by: "risk", levels: ["dangerous", "forbidden"] } as ToolSelector,
        evaluate: (): PolicyRuleResult => ({
          rule: "risk-filter",
          action: "deny",
          reasonCode: "RISK_HIT",
          humanMessage: "risk match",
        }),
      });
      const engine = new PolicyEngine(db, [rule]);

      const d1 = engine.evaluate(createRequest({ tool: createMockTool({ riskLevel: "safe" }) }));
      expect(d1.action).toBe("allow");

      const d2 = engine.evaluate(createRequest({ tool: createMockTool({ riskLevel: "dangerous" }) }));
      expect(d2.action).toBe("deny");
    });

    it("unknown selector type causes rule to not apply", () => {
      const rule = makeRule({
        id: "unknown-selector",
        appliesTo: { by: "nonexistent" } as unknown as ToolSelector,
        evaluate: (): PolicyRuleResult => ({
          rule: "unknown-selector",
          action: "deny",
          reasonCode: "NEVER",
          humanMessage: "should never fire",
        }),
      });
      const engine = new PolicyEngine(db, [rule]);
      const decision = engine.evaluate(createRequest());

      expect(decision.action).toBe("allow");
      expect(decision.rulesEvaluated).not.toContain("unknown-selector");
    });
  });

  // ── New: logDecision error path ─────────────────────────────
  describe("logDecision", () => {
    it("persists a decision without throwing", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(createRequest());
      expect(() => engine.logDecision(decision)).not.toThrow();
      expect(() => engine.logDecision(decision, "turn-abc")).not.toThrow();
    });

    it("does not throw when database insert fails", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(createRequest());

      // Close the DB to force an insert error
      db.close();

      // logDecision catches errors internally
      expect(() => engine.logDecision(decision)).not.toThrow();
    });
  });

  // ── New: clearEvaluationCache ───────────────────────────────
  describe("clearEvaluationCache interaction", () => {
    it("calls clearEvaluationCache on the spend tracker when present", () => {
      let cleared = false;
      const spendTracker = createMockSpendTracker();
      spendTracker.clearEvaluationCache = () => { cleared = true; };

      const request: PolicyRequest = {
        tool: createMockTool(),
        args: {},
        context: {} as ToolContext,
        turnContext: {
          inputSource: "agent",
          turnToolCallCount: 0,
          sessionSpend: spendTracker,
        },
      };

      const engine = new PolicyEngine(db, []);
      engine.evaluate(request);
      expect(cleared).toBe(true);
    });

    it("does not crash when clearEvaluationCache is absent", () => {
      const spendTracker = createMockSpendTracker();
      delete (spendTracker as any).clearEvaluationCache;

      const request: PolicyRequest = {
        tool: createMockTool(),
        args: {},
        context: {} as ToolContext,
        turnContext: {
          inputSource: "agent",
          turnToolCallCount: 0,
          sessionSpend: spendTracker,
        },
      };

      const engine = new PolicyEngine(db, []);
      expect(() => engine.evaluate(request)).not.toThrow();
    });
  });

  // ── New: decision metadata correctness ──────────────────────
  describe("decision metadata", () => {
    it("includes toolName from the request", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(
        createRequest({ tool: createMockTool({ name: "my_tool" }) }),
      );
      expect(decision.toolName).toBe("my_tool");
    });

    it("includes riskLevel from the tool", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(
        createRequest({ tool: createMockTool({ riskLevel: "dangerous" }) }),
      );
      expect(decision.riskLevel).toBe("dangerous");
    });

    it("includes a valid ISO timestamp", () => {
      const engine = new PolicyEngine(db, []);
      const decision = engine.evaluate(createRequest());
      expect(decision.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("derives authorityLevel from inputSource in turnContext", () => {
      const engine = new PolicyEngine(db, []);
      const request: PolicyRequest = {
        tool: createMockTool(),
        args: {},
        context: {} as ToolContext,
        turnContext: {
          inputSource: "system",
          turnToolCallCount: 0,
          sessionSpend: createMockSpendTracker(),
        },
      };
      const decision = engine.evaluate(request);
      expect(decision.authorityLevel).toBe("system");
    });
  });
});
