/*
 * validator.js
 *
 * Utilities for generating deterministic bit sequences and validating
 * observed bits against the server's own time. This module exports
 * helper functions used by the API implementation in server/index.js.
 */

// Simple 32‑bit hash function for strings. Produces a deterministic
// signed 32‑bit integer in the range [−2^31, 2^31). This allows us to
// derive a PRNG seed from a session identifier and phase. The hash
// implementation is based on Java's String.hashCode algorithm.
function hash32(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash * 31 + chr) | 0;
  }
  return hash;
}

// Deterministic pseudorandom number generator (mulberry32). Takes a
// 32‑bit integer seed and returns a function that produces uniformly
// distributed floating point numbers in [0, 1). Each call mutates
// the internal state. See https://stackoverflow.com/a/47593316
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Compute the bit value (0 or 1) at a given index for a particular
// seed. The bit is computed by seeding mulberry32 with (seed + index)
// and taking the least significant bit of the first output. This
// ensures that the same seed produces a reproducible sequence of
// pseudorandom bits across teacher and server.
function getBit(seed, index) {
  const prng = mulberry32((seed + index) | 0);
  return (prng() * 2) | 0;
}

/**
 * Validate an observed bit array against the server's expected
 * sequence. The server derives the expected bit sequence based on
 * the current system time (Date.now()), the configured bit period
 * (delta) and a PRNG seed. The algorithm allows a small amount of
 * misalignment by sliding the expected sequence window up to a few
 * indices. It also tolerates a single mismatch to account for
 * occasional camera noise.
 *
 * @param {number[]} bits Observed bits captured by the student UI.
 * @param {number} seed PRNG seed computed from sessionId and phase.
 * @param {number} delta Bit period in milliseconds.
 * @param {object} [opts] Optional parameters:
 *   - lenWindow {number} How many candidate start offsets to try
 *     (default 4). The validator will test offsets −N..0 where N =
 *     lenWindow − 1.
 *   - threshold {number} Minimum number of matching bits required
 *     to accept the sequence (default bits.length − 2).
 * @returns {boolean} True if the observed bits match the expected
 *   sequence for some alignment, false otherwise.
 */
function validateBits(bits, seed, delta, opts = {}) {
  const now = Date.now();
  const len = bits.length;
  const windowSize = opts.lenWindow ?? 4;
  const threshold = opts.threshold ?? Math.max(0, len - 2);
  const iNow = Math.floor(now / delta);
  // Try offsets from 0 down to −(windowSize−1). Offset 0 means we
  // assume the last bit corresponds to index iNow; offset −1 means
  // the last bit corresponds to iNow − 1; etc. This allows for
  // network/camera delays.
  for (let offset = 0; offset > -windowSize; offset--) {
    let matches = 0;
    for (let j = 0; j < len; j++) {
      const expectedBit = getBit(seed, iNow + offset - (len - 1 - j));
      if (bits[j] === expectedBit) matches++;
    }
    if (matches >= threshold) {
      return true;
    }
  }
  return false;
}

module.exports = {
  hash32,
  getBit,
  validateBits,
};