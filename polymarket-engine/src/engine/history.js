// History buffer helpers + rolling statistics used by regime detection and
// momentum/arb alpha. All functions are pure and deterministic.

/**
 * Append one tick of price/spread/depth to a bounded history buffer.
 * @param {import('./types.js').History} h
 * @param {number} p  price
 * @param {number} sp spread
 * @param {number} dp depth
 * @returns {import('./types.js').History}
 */
export function pushHist(h, p, sp, dp) {
  const mx = h.maxLen;
  const np = [...h.prices, p], ns = [...h.spreads, sp], nd = [...h.depths, dp];
  return {
    ...h,
    prices: np.length > mx ? np.slice(-mx) : np,
    spreads: ns.length > mx ? ns.slice(-mx) : ns,
    depths: nd.length > mx ? nd.slice(-mx) : nd,
  };
}

/**
 * Rate of change over the last n bars.
 * @param {number[]} p
 * @param {number} n
 * @returns {number}
 */
export function hRoc(p, n) {
  return p.length < n + 1 ? 0 : p[p.length - n - 1]
    ? (p[p.length - 1] - p[p.length - n - 1]) / p[p.length - n - 1]
    : 0;
}

/**
 * Simple moving average over the last n bars.
 * @param {number[]} p
 * @param {number} n
 * @returns {number}
 */
export function hSma(p, n) {
  const s = p.slice(-n);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

/**
 * Sample standard deviation over the last n bars.
 * @param {number[]} p
 * @param {number} n
 * @returns {number}
 */
export function hStd(p, n) {
  const s = p.slice(-n);
  if (s.length < 2) return 0;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1));
}

/**
 * Log-return volatility over the last n bars.
 * @param {number[]} p
 * @param {number} n
 * @returns {number}
 */
export function hVol(p, n) {
  const s = p.slice(-n);
  if (s.length < 3) return 0;
  const r = [];
  for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / (s[i - 1] || 1)));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}
