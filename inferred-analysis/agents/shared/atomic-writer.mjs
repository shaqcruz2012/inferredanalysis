/**
 * Atomic File Writer — Prevents concurrent corruption of TSV and JSON state files.
 *
 * Provides POSIX-safe atomic writes (write-to-temp + rename), advisory file locking
 * with retry, corruption-tolerant JSON reads, and thread-safe TSV append.
 *
 * Exports:
 *   atomicWriteFile(filePath, content)      — write to temp, rename (atomic on POSIX)
 *   atomicAppendFile(filePath, line)         — lock-based append with retry
 *   withFileLock(filePath, fn)              — advisory locking via .lock files with timeout
 *   safeReadJSON(filePath, defaultValue)    — read JSON with fallback on corruption
 *   safeWriteJSON(filePath, data)           — atomic JSON write with backup rotation
 *   appendTSV(filePath, row)               — thread-safe TSV append
 *   rotateBackups(filePath, maxBackups)     — keep last N versions of a file
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  openSync,
  closeSync,
  appendFileSync,
  statSync,
} from "fs";
import { dirname, basename, join } from "path";
import { randomBytes } from "crypto";

// ─── Constants ──────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_STALE_MS = 30000; // locks older than 30s are considered stale
const MAX_BACKUPS = 3;

// ─── atomicWriteFile ────────────────────────────────────
/**
 * Write content to a file atomically.
 * Writes to a temporary file in the same directory, then renames.
 * rename() is atomic on POSIX when src and dst are on the same filesystem.
 *
 * @param {string} filePath — target file path
 * @param {string|Buffer} content — data to write
 */
export function atomicWriteFile(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpName = `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = join(dir, tmpName);

  try {
    writeFileSync(tmpPath, content, { mode: 0o644 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ─── withFileLock ───────────────────────────────────────
/**
 * Advisory file locking using .lock files.
 * Creates a lock file, runs fn(), then releases the lock.
 * Retries acquisition with exponential backoff up to LOCK_TIMEOUT_MS.
 * Stale locks (older than LOCK_STALE_MS) are automatically broken.
 *
 * @param {string} filePath — the file to lock (lock file will be filePath + '.lock')
 * @param {Function} fn — function to execute while holding the lock
 * @returns {*} — return value of fn()
 */
export function withFileLock(filePath, fn) {
  const lockPath = filePath + ".lock";
  const lockContent = JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    host: process.env.HOSTNAME || "unknown",
  });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  let retryDelay = LOCK_RETRY_INTERVAL_MS;

  while (Date.now() < deadline) {
    try {
      // O_CREAT | O_EXCL — fails if file exists (atomic on POSIX)
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, lockContent);
      closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        // Check for stale lock
        if (isLockStale(lockPath)) {
          try { unlinkSync(lockPath); } catch { /* race is ok */ }
          continue; // retry immediately after breaking stale lock
        }
        // Wait and retry
        sleepSync(retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, 500);
        continue;
      }
      throw err; // unexpected error
    }
  }

  if (!acquired) {
    throw new Error(
      `Failed to acquire lock for ${filePath} within ${LOCK_TIMEOUT_MS}ms. ` +
      `Lock file: ${lockPath}`
    );
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

/**
 * Check if a lock file is stale (older than LOCK_STALE_MS).
 */
function isLockStale(lockPath) {
  try {
    const content = readFileSync(lockPath, "utf-8");
    const lock = JSON.parse(content);
    return (Date.now() - lock.timestamp) > LOCK_STALE_MS;
  } catch {
    // If we can't read it, check mtime
    try {
      const stat = statSync(lockPath);
      return (Date.now() - stat.mtimeMs) > LOCK_STALE_MS;
    } catch {
      return true; // can't stat, treat as stale
    }
  }
}

/**
 * Synchronous sleep (blocking). Used only for lock retry.
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait — acceptable for short lock retry intervals
  }
}

// ─── atomicAppendFile ──────────────────────────────────
/**
 * Append a line to a file with advisory locking.
 * Ensures concurrent appenders don't interleave or corrupt data.
 *
 * @param {string} filePath — target file path
 * @param {string} line — line to append (newline added automatically)
 */
export function atomicAppendFile(filePath, line) {
  withFileLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line + "\n");
  });
}

// ─── safeReadJSON ──────────────────────────────────────
/**
 * Read a JSON file with corruption tolerance.
 * Falls back to defaultValue if the file doesn't exist, is empty,
 * or contains invalid JSON. Also tries the most recent backup.
 *
 * @param {string} filePath — path to JSON file
 * @param {*} defaultValue — fallback value (default: {})
 * @returns {*} — parsed JSON or defaultValue
 */
export function safeReadJSON(filePath, defaultValue = {}) {
  // Try the primary file first
  const result = tryParseJSON(filePath);
  if (result !== undefined) return result;

  // Try backups in reverse order (most recent first)
  for (let i = 1; i <= MAX_BACKUPS; i++) {
    const backupPath = `${filePath}.bak.${i}`;
    const backupResult = tryParseJSON(backupPath);
    if (backupResult !== undefined) {
      console.error(`[atomic-writer] Primary ${filePath} corrupt/missing, recovered from ${backupPath}`);
      // Restore from backup
      try { atomicWriteFile(filePath, JSON.stringify(backupResult, null, 2) + "\n"); } catch { /* best effort */ }
      return backupResult;
    }
  }

  return defaultValue;
}

/**
 * Attempt to parse a JSON file; return undefined on failure.
 */
function tryParseJSON(filePath) {
  try {
    if (!existsSync(filePath)) return undefined;
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ─── rotateBackups ─────────────────────────────────────
/**
 * Rotate backup files for a given path.
 * Keeps up to maxBackups versions: file.bak.1 (newest) .. file.bak.N (oldest).
 *
 * @param {string} filePath — the file to back up
 * @param {number} maxBackups — max backup versions to keep (default: 3)
 */
export function rotateBackups(filePath, maxBackups = MAX_BACKUPS) {
  if (!existsSync(filePath)) return;

  try {
    // Shift existing backups: .bak.2 → .bak.3, .bak.1 → .bak.2
    for (let i = maxBackups; i > 1; i--) {
      const older = `${filePath}.bak.${i - 1}`;
      const newer = `${filePath}.bak.${i}`;
      if (existsSync(older)) {
        try { copyFileSync(older, newer); } catch { /* best effort */ }
      }
    }

    // Current file becomes .bak.1
    try { copyFileSync(filePath, `${filePath}.bak.1`); } catch { /* best effort */ }
  } catch {
    // Backup rotation is best-effort; don't block writes
  }
}

// ─── safeWriteJSON ─────────────────────────────────────
/**
 * Atomic JSON write with backup rotation.
 * Rotates existing file to backup, then writes atomically.
 *
 * @param {string} filePath — target JSON file
 * @param {*} data — data to serialize
 */
export function safeWriteJSON(filePath, data) {
  withFileLock(filePath, () => {
    rotateBackups(filePath);
    const content = JSON.stringify(data, null, 2) + "\n";
    atomicWriteFile(filePath, content);
  });
}

// ─── appendTSV ─────────────────────────────────────────
/**
 * Thread-safe TSV append. Ensures the file exists with a header,
 * then appends a row under advisory lock.
 *
 * @param {string} filePath — target TSV file
 * @param {string} row — tab-separated row (no trailing newline)
 * @param {string} [header] — header line to write if file doesn't exist
 */
export function appendTSV(filePath, row, header) {
  withFileLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath) && header) {
      writeFileSync(filePath, header + "\n");
    }
    appendFileSync(filePath, row + "\n");
  });
}

// ─── initTSV ───────────────────────────────────────────
/**
 * Ensure a TSV file exists with a header. Thread-safe.
 *
 * @param {string} filePath — target TSV file
 * @param {string} header — header line
 */
export function initTSV(filePath, header) {
  withFileLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, header + "\n");
    }
  });
}
