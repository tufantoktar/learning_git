// Regime detection (trend/vol/liquidity) and alpha-weight computation.

import { cl } from "../utils/math.js";
import { hVol } from "./history.js";

/**
 * Classify regime from recent price/spread/depth history.
 * Uses a simple Hurst-exponent proxy for trend and fast/slow vol ratio
 * for the vol regime.
 * @param {number[]} prices
 * @param {number[]} spreads
 * @param {number[]} depths
 * @returns {import('./types.js').Regime}
 */
export function detectRegime(prices, spreads, depths) {
  if (prices.length < 30) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  const p = prices.slice(-100);
  const rets = [];
  for (let i = 1; i < p.length; i++) rets.push(Math.log(p[i] / (p[i - 1] || 1)));
  if (!rets.length) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  const mR = rets.reduce((a, b) => a + b, 0) / rets.length;
  let cum = 0;
  const dev = rets.map(r => { cum += r - mR; return cum; });
  const R = Math.max(...dev) - Math.min(...dev);
  const S = Math.sqrt(rets.reduce((a, b) => a + (b - mR) ** 2, 0) / (rets.length - 1)) || 0.001;
  const hurst = +cl(Math.log((R / S) + 0.001) / Math.log(rets.length), 0.1, 0.9).toFixed(3);
  const fV = hVol(p, 20), sV = hVol(p, Math.min(80, p.length));
  const sp = spreads.slice(-20), dp = depths.slice(-20);
  const aS = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 0.05;
  const aD = dp.length ? dp.reduce((a, b) => a + b, 0) / dp.length : 1;
  return {
    trend: hurst > 0.55 ? "trending" : hurst < 0.45 ? "mean_reverting" : "neutral",
    vol: (fV / (sV || 0.001)) > 1.3 ? "high_vol" : "low_vol",
    liq: aD / (aS + 0.001) > 500 ? "high_liq" : "low_liq",
    confidence: +cl(prices.length / 100, 0, 1).toFixed(2),
    hurst,
  };
}

/**
 * Compute alpha weights across {nlp, momentum, arb} given regime, recent
 * meta-alpha performance, and news intensity.
 * @param {import('./types.js').Regime} regime
 * @param {import('./types.js').MetaPerf} metaPerf
 * @param {number} newsInt
 * @returns {import('./types.js').AlphaWeights}
 */
export function computeWeights(regime, metaPerf, newsInt) {
  const bases = { trending: [0.3, 0.5, 0.2], mean_reverting: [0.2, 0.2, 0.6], neutral: [0.4, 0.3, 0.3] };
  const w = [...(bases[regime.trend] || bases.neutral)];
  ["nlp", "momentum", "arb"].forEach((src, i) => {
    const p = metaPerf[src];
    if (p.length >= 10) {
      const m = p.reduce((a, b) => a + b, 0) / p.length;
      const s = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / (p.length - 1)) || 0.001;
      w[i] *= Math.max(0.1, 1 + 0.3 * (m / s));
    }
  });
  if (newsInt > 0.7) w[0] *= 1.5;
  if (regime.vol === "high_vol") w[1] *= 1.3;
  if (regime.liq === "low_liq") w[2] *= 0.5;
  const t = w[0] + w[1] + w[2];
  return {
    nlp: +(w[0] / t).toFixed(3),
    momentum: +(w[1] / t).toFixed(3),
    arb: +(w[2] / t).toFixed(3),
  };
}
