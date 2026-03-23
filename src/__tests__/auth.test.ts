/**
 * Auth & API Key Management Tests
 *
 * Tests for src/local/auth.ts covering:
 * - loadProviderKeys: env vars > keys.json > automaton.json priority
 * - saveProviderKeys: persists keys to disk, skips empty values
 * - hasInferenceProvider: detects at least one inference provider
 * - loadApiKey: legacy API key resolution chain
 * - Edge cases: empty strings, special characters, very long keys, malformed JSON
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// We need to mock getAutomatonDir before importing auth functions,
// so that all file operations target our temp directory.
let tmpDir: string;

vi.mock("../identity/wallet.js", () => ({
  getAutomatonDir: () => tmpDir,
}));

// Import after mock is set up
const {
  loadProviderKeys,
  saveProviderKeys,
  hasInferenceProvider,
  loadApiKey,
} = await import("../local/auth.js");

// ─── Helpers ────────────────────────────────────────────────────

function writeKeysJson(data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpDir, "keys.json"),
    JSON.stringify(data, null, 2),
  );
}

function writeAutomatonJson(data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpDir, "automaton.json"),
    JSON.stringify(data, null, 2),
  );
}

function writeConfigJson(data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify(data, null, 2),
  );
}

function clearEnvKeys(): void {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.CONWAY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  clearEnvKeys();
});

afterEach(() => {
  clearEnvKeys();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── loadProviderKeys ───────────────────────────────────────────

describe("loadProviderKeys", () => {
  it("returns empty object when no sources exist", () => {
    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBeUndefined();
    expect(keys.openaiApiKey).toBeUndefined();
    expect(keys.ollamaBaseUrl).toBeUndefined();
    expect(keys.conwayApiKey).toBeUndefined();
    expect(keys.perplexityApiKey).toBeUndefined();
  });

  it("loads keys from keys.json", () => {
    writeKeysJson({
      anthropicApiKey: "sk-ant-test123",
      openaiApiKey: "sk-openai-test456",
    });

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("sk-ant-test123");
    expect(keys.openaiApiKey).toBe("sk-openai-test456");
  });

  it("loads keys from automaton.json config", () => {
    writeAutomatonJson({
      anthropicApiKey: "sk-ant-config",
      ollamaBaseUrl: "http://localhost:11434",
    });

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("sk-ant-config");
    expect(keys.ollamaBaseUrl).toBe("http://localhost:11434");
  });

  it("keys.json overrides automaton.json", () => {
    writeAutomatonJson({ anthropicApiKey: "from-config" });
    writeKeysJson({ anthropicApiKey: "from-keys-json" });

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("from-keys-json");
  });

  it("env vars override everything", () => {
    writeKeysJson({ anthropicApiKey: "from-keys-json" });
    writeAutomatonJson({ anthropicApiKey: "from-config" });
    process.env.ANTHROPIC_API_KEY = "from-env";

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("from-env");
  });

  it("loads all five env vars when set", () => {
    process.env.ANTHROPIC_API_KEY = "ant-env";
    process.env.OPENAI_API_KEY = "oai-env";
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    process.env.CONWAY_API_KEY = "conway-env";
    process.env.PERPLEXITY_API_KEY = "pplx-env";

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("ant-env");
    expect(keys.openaiApiKey).toBe("oai-env");
    expect(keys.ollamaBaseUrl).toBe("http://ollama:11434");
    expect(keys.conwayApiKey).toBe("conway-env");
    expect(keys.perplexityApiKey).toBe("pplx-env");
  });

  it("merges keys from different sources", () => {
    writeAutomatonJson({ ollamaBaseUrl: "http://localhost:11434" });
    writeKeysJson({ openaiApiKey: "sk-from-keys" });
    process.env.ANTHROPIC_API_KEY = "sk-from-env";

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe("sk-from-env");
    expect(keys.openaiApiKey).toBe("sk-from-keys");
    expect(keys.ollamaBaseUrl).toBe("http://localhost:11434");
  });

  it("handles malformed keys.json gracefully (returns empty)", () => {
    fs.writeFileSync(path.join(tmpDir, "keys.json"), "NOT VALID JSON{{{");

    const keys = loadProviderKeys();
    // Should not throw, should return empty / fallback
    expect(keys.anthropicApiKey).toBeUndefined();
  });

  it("handles malformed automaton.json gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "automaton.json"), "<<<broken>>>");

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBeUndefined();
  });

  // Edge cases
  it("handles key with special characters", () => {
    const specialKey = "sk-ant-!@#$%^&*()_+-=[]{}|;':\",./<>?";
    writeKeysJson({ anthropicApiKey: specialKey });

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe(specialKey);
  });

  it("handles very long key (10000 chars)", () => {
    const longKey = "sk-" + "a".repeat(10000);
    writeKeysJson({ anthropicApiKey: longKey });

    const keys = loadProviderKeys();
    expect(keys.anthropicApiKey).toBe(longKey);
  });

  it("does not pick up empty string from keys.json as a truthy key", () => {
    // The code uses `if (stored.conwayApiKey)` which is falsy for ""
    writeKeysJson({ anthropicApiKey: "" });

    const keys = loadProviderKeys();
    // Spread will include it, but config layer won't overwrite
    // The merged object will have anthropicApiKey = ""
    expect(keys.anthropicApiKey).toBe("");
  });
});

// ─── saveProviderKeys ───────────────────────────────────────────

describe("saveProviderKeys", () => {
  it("saves non-empty keys to keys.json", () => {
    saveProviderKeys({
      anthropicApiKey: "sk-save-test",
      openaiApiKey: "sk-oai-save",
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(saved.anthropicApiKey).toBe("sk-save-test");
    expect(saved.openaiApiKey).toBe("sk-oai-save");
  });

  it("omits undefined keys from saved file", () => {
    saveProviderKeys({ anthropicApiKey: "sk-only-this" });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(saved.anthropicApiKey).toBe("sk-only-this");
    expect(saved.openaiApiKey).toBeUndefined();
    expect(saved.ollamaBaseUrl).toBeUndefined();
  });

  it("omits empty string keys (falsy check)", () => {
    saveProviderKeys({
      anthropicApiKey: "",
      openaiApiKey: "sk-real-key",
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(saved.anthropicApiKey).toBeUndefined();
    expect(saved.openaiApiKey).toBe("sk-real-key");
  });

  it("creates the automaton directory if it does not exist", () => {
    // Remove the temp dir so saveProviderKeys must recreate it
    fs.rmSync(tmpDir, { recursive: true, force: true });

    saveProviderKeys({ anthropicApiKey: "sk-creates-dir" });

    expect(fs.existsSync(tmpDir)).toBe(true);
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(saved.anthropicApiKey).toBe("sk-creates-dir");
  });

  it("overwrites existing keys.json", () => {
    writeKeysJson({ anthropicApiKey: "old-key" });

    saveProviderKeys({ anthropicApiKey: "new-key" });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(saved.anthropicApiKey).toBe("new-key");
  });

  it("saves all five key types when provided", () => {
    saveProviderKeys({
      anthropicApiKey: "ant",
      openaiApiKey: "oai",
      ollamaBaseUrl: "http://ollama",
      conwayApiKey: "conway",
      perplexityApiKey: "pplx",
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keys.json"), "utf-8"),
    );
    expect(Object.keys(saved)).toHaveLength(5);
  });
});

// ─── hasInferenceProvider ───────────────────────────────────────

describe("hasInferenceProvider", () => {
  it("returns false when no providers configured", () => {
    expect(hasInferenceProvider()).toBe(false);
  });

  it("returns true when Anthropic key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasInferenceProvider()).toBe(true);
  });

  it("returns true when OpenAI key is set", () => {
    process.env.OPENAI_API_KEY = "sk-oai-test";
    expect(hasInferenceProvider()).toBe(true);
  });

  it("returns true when Ollama URL is set", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    expect(hasInferenceProvider()).toBe(true);
  });

  it("returns false when only Conway key is set (not an inference provider)", () => {
    process.env.CONWAY_API_KEY = "conway-only";
    expect(hasInferenceProvider()).toBe(false);
  });

  it("returns false when only Perplexity key is set (not an inference provider)", () => {
    process.env.PERPLEXITY_API_KEY = "pplx-only";
    expect(hasInferenceProvider()).toBe(false);
  });

  it("returns true when provider key is in keys.json", () => {
    writeKeysJson({ openaiApiKey: "sk-from-file" });
    expect(hasInferenceProvider()).toBe(true);
  });

  it("returns true when provider key is in automaton.json", () => {
    writeAutomatonJson({ anthropicApiKey: "sk-from-config" });
    expect(hasInferenceProvider()).toBe(true);
  });
});

// ─── loadApiKey (legacy) ────────────────────────────────────────

describe("loadApiKey", () => {
  it("returns null when no sources have a key", () => {
    expect(loadApiKey()).toBeNull();
  });

  it("returns key from CONWAY_API_KEY env var", () => {
    process.env.CONWAY_API_KEY = "env-conway-key";
    expect(loadApiKey()).toBe("env-conway-key");
  });

  it("returns key from keys.json conwayApiKey field", () => {
    writeKeysJson({ conwayApiKey: "keys-json-conway" });
    expect(loadApiKey()).toBe("keys-json-conway");
  });

  it("returns key from config.json apiKey field (legacy)", () => {
    writeConfigJson({ apiKey: "legacy-config-key" });
    expect(loadApiKey()).toBe("legacy-config-key");
  });

  it("env var takes priority over keys.json", () => {
    writeKeysJson({ conwayApiKey: "from-file" });
    process.env.CONWAY_API_KEY = "from-env";
    expect(loadApiKey()).toBe("from-env");
  });

  it("keys.json takes priority over config.json", () => {
    writeConfigJson({ apiKey: "from-legacy-config" });
    writeKeysJson({ conwayApiKey: "from-keys-json" });
    expect(loadApiKey()).toBe("from-keys-json");
  });

  it("handles malformed config.json gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "BROKEN JSON!!!");
    expect(loadApiKey()).toBeNull();
  });

  it("returns null when config.json exists but has no apiKey", () => {
    writeConfigJson({ somethingElse: "value" });
    expect(loadApiKey()).toBeNull();
  });

  // Edge cases
  it("handles API key with special characters", () => {
    process.env.CONWAY_API_KEY = "key-with-$pecial_ch@rs!";
    expect(loadApiKey()).toBe("key-with-$pecial_ch@rs!");
  });

  it("handles very long API key", () => {
    const longKey = "ck_" + "x".repeat(5000);
    process.env.CONWAY_API_KEY = longKey;
    expect(loadApiKey()).toBe(longKey);
  });

  it("empty string env var is falsy — falls through to next source", () => {
    process.env.CONWAY_API_KEY = "";
    writeKeysJson({ conwayApiKey: "fallback" });
    // process.env.CONWAY_API_KEY is "" which is falsy, so it skips
    expect(loadApiKey()).toBe("fallback");
  });
});
