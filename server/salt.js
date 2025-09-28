const crypto = require('crypto');

const ROTATION_MS = parseInt(process.env.SALT_ROTATION_MS || '600', 10);
const ACCEPT_WINDOW_MS = parseInt(process.env.SALT_ACCEPT_WINDOW_MS || '1000', 10);
const TIME_TOLERANCE_SECONDS = parseInt(process.env.CODE_TIME_TOLERANCE_SEC || '1', 10);

let currentSalt = createSalt();
let previousSalt = createSalt();

function createSalt() {
  return {
    value: crypto.randomInt(0, 0x7fffffff),
    createdAt: Date.now(),
    expiresAt: Date.now() + ROTATION_MS,
  };
}

function rotateSalt() {
  previousSalt = currentSalt;
  currentSalt = createSalt();
}

setInterval(rotateSalt, ROTATION_MS).unref();

function getSalts() {
  return { current: currentSalt, previous: previousSalt, rotationMs: ROTATION_MS, acceptWindowMs: ACCEPT_WINDOW_MS };
}

function parseCode(code) {
  const match = /^([0-5][0-9]):([0-5][0-9]):([0-9]{2})$/.exec(code);
  if (!match) return null;
  return {
    minutes: parseInt(match[1], 10),
    seconds: parseInt(match[2], 10),
    saltDigits: match[3],
  };
}

function formatCodeForSalt(saltValue, now = Date.now()) {
  const date = new Date(now);
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const saltDigits = String(Math.abs(saltValue || 0) % 100).padStart(2, '0');
  return `${mm}:${ss}:${saltDigits}`;
}

function matchesSaltDigits(parsed, saltValue) {
  const expected = String(Math.abs(saltValue || 0) % 100).padStart(2, '0');
  return parsed.saltDigits === expected;
}

function secondsDifference(parsed, now = Date.now()) {
  const codeSeconds = parsed.minutes * 60 + parsed.seconds;
  const date = new Date(now);
  const currentSeconds = date.getMinutes() * 60 + date.getSeconds();
  const diff = Math.abs(codeSeconds - currentSeconds);
  return Math.min(diff, Math.abs(codeSeconds + 60 - currentSeconds), Math.abs(codeSeconds - 60 - currentSeconds));
}

function validateCode(code) {
  const parsed = parseCode(code);
  if (!parsed) {
    return { ok: false, reason: 'format', expected: [] };
  }
  const now = Date.now();
  const salts = getSalts();
  const expectedCodes = [formatCodeForSalt(salts.current.value, now)];
  if (salts.previous && salts.previous.value !== salts.current.value) {
    expectedCodes.push(formatCodeForSalt(salts.previous.value, now));
  }

  const diffSeconds = secondsDifference(parsed, now);
  if (diffSeconds > TIME_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'time', expected: expectedCodes };
  }

  const ageCurrent = now - salts.current.createdAt;
  if (ageCurrent <= ACCEPT_WINDOW_MS && matchesSaltDigits(parsed, salts.current.value)) {
    return { ok: true };
  }

  const agePrevious = now - salts.previous.createdAt;
  if (agePrevious <= ACCEPT_WINDOW_MS && matchesSaltDigits(parsed, salts.previous.value)) {
    return { ok: true };
  }

  return { ok: false, reason: 'salt', expected: expectedCodes };
}

module.exports = {
  getSalts,
  ROTATION_MS,
  ACCEPT_WINDOW_MS,
  formatCodeForSalt,
  validateCode,
};

