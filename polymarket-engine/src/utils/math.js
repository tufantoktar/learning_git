// Pure math helpers shared across the engine.
// Kept free of external dependencies.

/**
 * Clamp a number to [lo, hi].
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Round to 4 decimal places and coerce to number.
 * @param {number} v
 * @returns {number}
 */
export const r4 = (v) => +(+v).toFixed(4);
