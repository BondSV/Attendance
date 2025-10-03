const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_PATH = process.env.MANUAL_OVERRIDE_LOG_PATH || path.join(__dirname, '..', 'manual-overrides.log');
const ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

const manualOverrideTokens = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [tokenId, entry] of manualOverrideTokens) {
    if ((now - entry.issuedAt) > ENTRY_TTL_MS) {
      manualOverrideTokens.delete(tokenId);
    }
  }
}

function registerManualOverride(tokenId, meta) {
  purgeExpired();
  const manualOverrideId = crypto.randomBytes(10).toString('hex');
  manualOverrideTokens.set(tokenId, {
    manualOverrideId,
    issuedAt: Date.now(),
    meta,
  });
  return manualOverrideId;
}

function consumeManualOverride(tokenId) {
  purgeExpired();
  const entry = manualOverrideTokens.get(tokenId);
  if (!entry) return null;
  manualOverrideTokens.delete(tokenId);
  return { manualOverrideId: entry.manualOverrideId, ...entry.meta };
}

function logManualOverrideUsage(record) {
  const line = JSON.stringify({
    ts_utc: new Date().toISOString(),
    manual_override_id: record.manualOverrideId,
    sid: record.sid,
    module: record.module,
    group: record.group,
    phase: record.phase,
    student_id: record.studentId,
    device_id: record.deviceId,
    verification_id: record.verificationId,
    password_version: record.passwordVersion,
  });
  try {
    fs.appendFile(LOG_PATH, line + '\n', (err) => {
      if (err) {
        console.warn('Failed to write manual override log', err);
      }
    });
  } catch (err) {
    console.warn('Manual override logging error', err);
  }
}

module.exports = {
  registerManualOverride,
  consumeManualOverride,
  logManualOverrideUsage,
};
