const crypto = require('crypto');

const ROTATION_MS = parseInt(process.env.SALT_ROTATION_MS || '600', 10);
const ACCEPT_WINDOW_MS = parseInt(process.env.SALT_ACCEPT_WINDOW_MS || '1000', 10);

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

module.exports = {
  getSalts,
  ROTATION_MS,
  ACCEPT_WINDOW_MS,
};

