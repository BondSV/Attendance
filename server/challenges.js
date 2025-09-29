const crypto = require('crypto');

const DEFAULT_TTL_MS = parseInt(process.env.CHALLENGE_TTL_MS || '3000', 10);

const challenges = new Map();

function makeKey(sid, phase) {
  return `${sid}__${phase || ''}`;
}

function purgeExpired(records) {
  const now = Date.now();
  return records.filter(entry => entry.expiresAt > now);
}

function issueChallenge(sid, phase, ttlMs = DEFAULT_TTL_MS) {
  const key = makeKey(sid, phase);
  const list = purgeExpired(challenges.get(key) || []);

  const value = crypto.randomBytes(16).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  list.push({ value, expiresAt });
  challenges.set(key, list);

  return { challenge: value, expiresAt, ttlMs };
}

function validateChallenge(sid, phase, value) {
  const key = makeKey(sid, phase);
  const list = purgeExpired(challenges.get(key) || []);
  if (list.length === 0) {
    challenges.delete(key);
    return { ok: false };
  }

  const now = Date.now();
  const match = list.find(entry => entry.value === value);
  challenges.set(key, list);
  if (!match) return { ok: false };
  return { ok: match.expiresAt > now };
}

module.exports = {
  DEFAULT_TTL_MS,
  issueChallenge,
  validateChallenge,
};

