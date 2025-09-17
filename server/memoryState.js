/*
 * In‑memory state management for verification tokens and device locks.  The
 * Student/Collector server does not persist state between restarts.  Tokens
 * expire after a short TTL and can only be consumed once.  Device locks are
 * maintained to discourage multiple student IDs from being submitted from the
 * same device during a single session/phase.
 */

const crypto = require('crypto');

// Store verification tokens keyed by token ID.  Each entry contains:
// { key: connectionKey, expiresAt: timestampMs }
const tokens = new Map();

// Store device locks keyed by deviceKey (e.g. ip|ua|sid|phase).  Each entry
// contains { studentId, expiresAt: timestampMs }.  If a device attempts to
// submit a different studentId before expiry, this can be flagged by callers.
const deviceLocks = new Map();

// Default expiry durations (ms)
const TOKEN_TTL_MS = 30 * 1000; // 30 seconds
const DEVICE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a cryptographically secure random token string.  Tokens are
 * base64url‑encoded for URL safety.
 * @returns {string}
 */
function generateTokenId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Issue a verification token for a connection key.  Tokens expire after a
 * fixed TTL.  Multiple tokens can be issued concurrently; consumption is
 * tracked individually.
 *
 * @param {string} connectionKey A string identifying the client (e.g.
 *   ip+ua+sid+phase+pageSessionId)
 * @returns {string} The new verification token ID
 */
function issueVerification(connectionKey) {
  purgeExpired();
  const id = generateTokenId();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokens.set(id, { key: connectionKey, expiresAt });
  return id;
}

/**
 * Consume (invalidate) a verification token.  The token must exist and
 * belong to the specified connection key.  Once consumed, the token is
 * removed.  If the token does not exist, is expired, or belongs to a
 * different key, consumption fails.
 *
 * @param {string} tokenId The token ID to consume
 * @param {string} connectionKey The connection key for which the token
 *   should be valid
 * @returns {boolean} true if successfully consumed, false otherwise
 */
function consumeVerification(tokenId, connectionKey) {
  purgeExpired();
  const entry = tokens.get(tokenId);
  if (!entry) {
    return false;
  }
  if (entry.key !== connectionKey) {
    return false;
  }
  tokens.delete(tokenId);
  return true;
}

/**
 * Register a device lock for a device and session/phase.  If a lock
 * already exists for the same deviceKey and studentId, the expiry is
 * refreshed.  If a different studentId attempts to use the same deviceKey
 * while a lock is active, the call returns false and the lock remains.
 *
 * @param {string} deviceKey A key representing device+sid+phase (e.g.
 *   ip|ua|sid|phase)
 * @param {string} studentId The student ID being submitted
 * @returns {boolean} true if the device is not locked or is locked by
 *   the same studentId; false if the device is locked by a different
 *   studentId
 */
function acquireDeviceLock(deviceKey, studentId) {
  purgeExpired();
  const entry = deviceLocks.get(deviceKey);
  const now = Date.now();
  const expiresAt = now + DEVICE_LOCK_TTL_MS;
  if (!entry) {
    deviceLocks.set(deviceKey, { studentId, expiresAt });
    return true;
  }
  if (entry.studentId === studentId) {
    // refresh expiry
    entry.expiresAt = expiresAt;
    return true;
  }
  // another studentId attempted to use the same device
  return false;
}

/**
 * Remove expired tokens and device locks.  Called periodically to keep
 * memory usage low.
 */
function purgeExpired() {
  const now = Date.now();
  for (const [id, entry] of tokens) {
    if (entry.expiresAt <= now) {
      tokens.delete(id);
    }
  }
  for (const [key, entry] of deviceLocks) {
    if (entry.expiresAt <= now) {
      deviceLocks.delete(key);
    }
  }
}

module.exports = {
  issueVerification,
  consumeVerification,
  acquireDeviceLock,
};