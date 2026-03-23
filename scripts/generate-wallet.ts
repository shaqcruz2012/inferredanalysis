/**
 * Generate a new Ethereum wallet for the gateway.
 *
 * Creates ~/.automaton/wallet.json with a fresh private key.
 * Will NOT overwrite an existing wallet — use --force to replace.
 *
 * Usage: npx tsx scripts/generate-wallet.ts [--force]
 */
import fs from "fs";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const AUTOMATON_DIR = path.join(os.homedir(), ".automaton");
const WALLET_PATH = path.join(AUTOMATON_DIR, "wallet.json");
const force = process.argv.includes("--force");

if (fs.existsSync(WALLET_PATH) && !force) {
  const existing = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
  const account = privateKeyToAccount(existing.privateKey as `0x${string}`);
  console.log(`Wallet already exists: ${account.address}`);
  console.log(`File: ${WALLET_PATH}`);
  console.log(`Use --force to generate a new one (will overwrite!)`);
  process.exit(0);
}

// Create directory
if (!fs.existsSync(AUTOMATON_DIR)) {
  fs.mkdirSync(AUTOMATON_DIR, { recursive: true });
}

// Generate
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

fs.writeFileSync(
  WALLET_PATH,
  JSON.stringify({ privateKey }, null, 2),
  { mode: 0o600 }, // Owner read/write only
);

console.log(`Wallet generated successfully.`);
console.log(`Address: ${account.address}`);
console.log(`File:    ${WALLET_PATH}`);
console.log(``);
console.log(`IMPORTANT: This wallet needs USDC on Base to receive payments.`);
console.log(`Fund it at: https://bridge.base.org or send USDC to ${account.address}`);
