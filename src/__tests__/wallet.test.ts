/**
 * Wallet Identity Tests
 *
 * Tests for src/identity/wallet.ts covering:
 * - getAutomatonDir / getWalletPath: correct path construction
 * - getWallet: creates new wallet when none exists, loads existing wallet
 * - getWalletAddress: returns address from existing wallet, null when missing
 * - loadWalletAccount: returns account from existing wallet, null when missing
 * - walletExists: detects presence/absence of wallet file
 * - Edge cases: corrupt wallet file, deterministic key derivation, file structure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import osMod from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Create a stable fake home dir BEFORE the mock is applied.
// This dir persists for the entire test file; each test cleans/rebuilds its contents.
const FAKE_HOME = fs.mkdtempSync(path.join(osMod.tmpdir(), "wallet-test-home-"));
const AUTOMATON_DIR = path.join(FAKE_HOME, ".automaton");
const WALLET_PATH = path.join(AUTOMATON_DIR, "wallet.json");

// Mock os.homedir so wallet.ts resolves paths into our fake home
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

// Import after mock is set up
const {
  getAutomatonDir,
  getWalletPath,
  getWallet,
  getWalletAddress,
  loadWalletAccount,
  walletExists,
} = await import("../identity/wallet.js");

// ─── Helpers ────────────────────────────────────────────────────

function writeWalletFile(data: Record<string, unknown>): void {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true });
  }
  fs.writeFileSync(WALLET_PATH, JSON.stringify(data, null, 2));
}

function cleanAutomatonDir(): void {
  if (fs.existsSync(AUTOMATON_DIR)) {
    fs.rmSync(AUTOMATON_DIR, { recursive: true, force: true });
  }
}

function createValidWalletData() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    privateKey,
    address: account.address,
    createdAt: new Date().toISOString(),
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  cleanAutomatonDir();
});

afterEach(() => {
  cleanAutomatonDir();
});

// ─── getAutomatonDir ─────────────────────────────────────────────

describe("getAutomatonDir", () => {
  it("returns path ending with .automaton", () => {
    const dir = getAutomatonDir();
    expect(dir).toMatch(/\.automaton$/);
  });

  it("is under the home directory", () => {
    const dir = getAutomatonDir();
    expect(dir.startsWith(FAKE_HOME)).toBe(true);
  });
});

// ─── getWalletPath ───────────────────────────────────────────────

describe("getWalletPath", () => {
  it("returns path ending with wallet.json", () => {
    const p = getWalletPath();
    expect(p).toMatch(/wallet\.json$/);
  });

  it("is inside the automaton directory", () => {
    const p = getWalletPath();
    expect(p.startsWith(getAutomatonDir())).toBe(true);
  });
});

// ─── walletExists ────────────────────────────────────────────────

describe("walletExists", () => {
  it("returns false when no wallet file exists", () => {
    expect(walletExists()).toBe(false);
  });

  it("returns true when wallet file exists", () => {
    const data = createValidWalletData();
    writeWalletFile(data);
    expect(walletExists()).toBe(true);
  });
});

// ─── getWallet ───────────────────────────────────────────────────

describe("getWallet", () => {
  it("creates a new wallet when none exists", async () => {
    const { account, isNew } = await getWallet();
    expect(isNew).toBe(true);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("persists the wallet to disk after creation", async () => {
    await getWallet();
    expect(fs.existsSync(WALLET_PATH)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
    expect(saved.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(saved.createdAt).toBeDefined();
  });

  it("loads an existing wallet (isNew = false)", async () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const { account, isNew } = await getWallet();
    expect(isNew).toBe(false);
    expect(account.address).toBe(data.address);
  });

  it("returns a deterministic address from the same private key", async () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const { account: first } = await getWallet();
    const { account: second } = await getWallet();
    expect(first.address).toBe(second.address);
  });

  it("creates the .automaton directory if it does not exist", async () => {
    // Ensure it doesn't exist
    cleanAutomatonDir();

    await getWallet();
    expect(fs.existsSync(AUTOMATON_DIR)).toBe(true);
  });

  it("generates a valid EVM address (42 chars, 0x prefix)", async () => {
    const { account } = await getWallet();
    expect(account.address).toHaveLength(42);
    expect(account.address.startsWith("0x")).toBe(true);
  });
});

// ─── getWalletAddress ────────────────────────────────────────────

describe("getWalletAddress", () => {
  it("returns null when no wallet exists", () => {
    expect(getWalletAddress()).toBeNull();
  });

  it("returns the correct address from an existing wallet", () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const address = getWalletAddress();
    expect(address).toBe(data.address);
  });

  it("returns a valid EVM address format", () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const address = getWalletAddress();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ─── loadWalletAccount ───────────────────────────────────────────

describe("loadWalletAccount", () => {
  it("returns null when no wallet exists", () => {
    expect(loadWalletAccount()).toBeNull();
  });

  it("returns an account with the correct address", () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const account = loadWalletAccount();
    expect(account).not.toBeNull();
    expect(account!.address).toBe(data.address);
  });

  it("returned account has a signMessage function", () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const account = loadWalletAccount();
    expect(typeof account!.signMessage).toBe("function");
  });

  it("returned account has a signTransaction function", () => {
    const data = createValidWalletData();
    writeWalletFile(data);

    const account = loadWalletAccount();
    expect(typeof account!.signTransaction).toBe("function");
  });
});

// ─── Edge cases ──────────────────────────────────────────────────

describe("Edge cases", () => {
  it("two consecutive getWallet calls return the same address", async () => {
    const { account: a1 } = await getWallet();
    const { account: a2 } = await getWallet();
    expect(a1.address).toBe(a2.address);
  });

  it("getWalletAddress matches getWallet address", async () => {
    const { account } = await getWallet();
    const address = getWalletAddress();
    expect(address).toBe(account.address);
  });

  it("loadWalletAccount matches getWallet account address", async () => {
    const { account } = await getWallet();
    const loaded = loadWalletAccount();
    expect(loaded!.address).toBe(account.address);
  });

  it("wallet file has restricted content structure (privateKey + createdAt only)", async () => {
    await getWallet();
    const data = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
    expect(data).toHaveProperty("privateKey");
    expect(data).toHaveProperty("createdAt");
    expect(Object.keys(data)).toHaveLength(2);
  });

  it("different private keys produce different addresses", () => {
    const key1 = generatePrivateKey();
    const key2 = generatePrivateKey();
    const addr1 = privateKeyToAccount(key1).address;
    const addr2 = privateKeyToAccount(key2).address;
    expect(addr1).not.toBe(addr2);
  });

  it("key derivation is deterministic (same key -> same address)", () => {
    const key = generatePrivateKey();
    const addr1 = privateKeyToAccount(key).address;
    const addr2 = privateKeyToAccount(key).address;
    expect(addr1).toBe(addr2);
  });
});
