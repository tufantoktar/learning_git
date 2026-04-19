// Seeded PRNG. Deterministic given same seed.
// Implementation preserved byte-for-byte from V5.0 single-file to guarantee
// identical replay behavior after the refactor.

/**
 * Create a seeded pseudo-random number generator.
 * @param {number} seed
 * @returns {import('./types.js').Rng}
 */
export function createRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
