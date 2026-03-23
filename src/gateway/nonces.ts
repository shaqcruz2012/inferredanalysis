/**
 * Nonce Tracking for x402 Replay Prevention
 *
 * Stores EIP-712 TransferWithAuthorization nonces in SQLite.
 * Prevents the same signed payment from being used twice.
 */
import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const NONCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS x402_nonces (
    nonce       TEXT PRIMARY KEY,
    from_addr   TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    tier        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT,
    tx_hash     TEXT,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_x402_nonces_status ON x402_nonces(status);
  CREATE INDEX IF NOT EXISTS idx_x402_nonces_from ON x402_nonces(from_addr);
`;

export function initNonceSchema(db: Database): void {
  db.exec(NONCE_SCHEMA);
}

export function checkNonce(db: Database, nonce: string): boolean {
  const row = db.prepare("SELECT 1 FROM x402_nonces WHERE nonce = ?").get(nonce);
  return !row;
}

/**
 * Atomically check and reserve a nonce in a single transaction.
 * Returns true if the nonce was successfully reserved (not seen before).
 * Returns false if the nonce already exists (replay detected).
 */
export function checkAndReserveNonce(
  db: Database,
  params: {
    nonce: string;
    fromAddr: string;
    amountAtomic: string;
    tier: string;
  },
): boolean {
  // INSERT OR IGNORE will silently skip if nonce already exists (PRIMARY KEY conflict).
  // changes() returns 0 if the row was ignored, 1 if inserted.
  const result = db.prepare(
    `INSERT OR IGNORE INTO x402_nonces (nonce, from_addr, amount_atomic, tier, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(params.nonce, params.fromAddr, params.amountAtomic, params.tier);
  return result.changes > 0;
}

export function reserveNonce(
  db: Database,
  params: {
    nonce: string;
    fromAddr: string;
    amountAtomic: string;
    tier: string;
  },
): void {
  db.prepare(
    `INSERT INTO x402_nonces (nonce, from_addr, amount_atomic, tier, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(params.nonce, params.fromAddr, params.amountAtomic, params.tier);
}

export function markNonceExecuted(db: Database, nonce: string, txHash: string): void {
  db.prepare(
    `UPDATE x402_nonces SET status = 'executed', tx_hash = ?, executed_at = datetime('now')
     WHERE nonce = ?`,
  ).run(txHash, nonce);
}

export function markNonceFailed(db: Database, nonce: string, error: string): void {
  db.prepare(
    `UPDATE x402_nonces SET status = 'failed', error = ?, executed_at = datetime('now')
     WHERE nonce = ?`,
  ).run(error, nonce);
}
