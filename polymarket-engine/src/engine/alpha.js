// Alpha signal generation (NLP, momentum, orderflow, stat-arb) and
// signal-to-recommendation pipeline (processSigs).
// All behavior preserved byte-for-byte from V5.0.

import { cl, r4 } from "../utils/math.js";
import { CFG } from "../config/config.js";
import { NEWS, PAIRS } from "../config/marketDefs.js";
import { SRC_W, SRCS } from "../config/constants.js";
import { hRoc, hSma, hStd, hVol } from "./history.js";

/**
 * Generate a random news event from the NEWS templates.
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {import('./types.js').Rng} rng
 * @param {number} time
 * @returns {import('./types.js').NewsEvent}
 */
export function genNews(mkts, rng, time) {
  const tpl = NEWS[Math.floor(rng() * NEWS.length)];
  const rel = tpl.m.map(id => mkts[id]).filter(Boolean);
  const avgMove = rel.reduce((s, m) => s + (m.yes - m.prevYes), 0) / (rel.length || 1);
  const raw = cl(avgMove * 20 + (rng() - 0.5) * 0.3, -1, 1);
  const src = SRCS[Math.floor(rng() * SRCS.length)];
  const abs = Math.abs(raw), sw = SRC_W[src], lat = Math.floor(rng() * 5000);
  const ic = abs > 0.55 ? "binary_catalyst" : abs > 0.2 ? "gradual_shift" : "noise";
  return {
    id: "n" + time, time, source: src, headline: tpl.h, markets: tpl.m,
    sentiment: r4(raw), impactClass: ic,
    confidence: +cl((0.5 + abs * 0.4) * sw * cl(1 - lat / 10000, 0.5, 1), 0, 0.99).toFixed(3),
    baseImpact: tpl.imp, srcWeight: sw, latencyMs: lat,
  };
}

/**
 * NLP-sourced alpha signals with latency + confidence penalty.
 * @param {import('./types.js').NewsEvent} nev
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {number} time
 * @returns {import('./types.js').Signal[]}
 */
export function nlpSigs(nev, mkts, time) {
  // Phase 3: lower threshold, latency-penalized confidence
  if (nev.confidence < 0.45) return [];
  const sigs = [];
  const latPenalty = cl(1 - nev.latencyMs / 8000, 0.3, 1);
  for (const mid of nev.markets) {
    const m = mkts[mid]; if (!m) continue;
    const e = nev.sentiment * nev.baseImpact * nev.confidence * nev.srcWeight * latPenalty * 0.04;
    if (Math.abs(e) < 0.004) continue;
    const adjConf = +(nev.confidence * latPenalty).toFixed(3);
    sigs.push({
      id: "nlp_" + mid + "_" + time, source: "nlp", time, cid: mid,
      dir: e > 0 ? "BUY_YES" : "BUY_NO",
      edge: +Math.abs(e).toFixed(4),
      conf: adjConf,
      fv: r4(cl(m.yes + e, 0.02, 0.98)),
      px: m.yes,
      hl: 180000, exp: time + 720000,
      qs: +(adjConf * nev.srcWeight).toFixed(3),
    });
  }
  return sigs;
}

/**
 * Multi-timeframe, volatility-adjusted momentum signals with regime-aware flipping.
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {Object<string, import('./types.js').History>} hists
 * @param {number} time
 * @param {import('./types.js').Regime} regime
 * @returns {import('./types.js').Signal[]}
 */
export function momSigs(mkts, hists, time, regime) {
  const sigs = [];
  for (const [mid, m] of Object.entries(mkts)) {
    const h = hists[mid]; if (!h || h.prices.length < 25) continue;
    const p = h.prices, px = m.yes;
    // Short-term
    const r5 = hRoc(p, 5), s10 = hSma(p, 10), v20 = hVol(p, 20);
    // Medium-term
    const s30 = hSma(p, 30), r15 = hRoc(p, 15);
    // Long-term (if enough data)
    const s50 = p.length >= 50 ? hSma(p, 50) : s30;

    // Multi-timeframe trend composite
    const shortTrend = (px > s10 ? 0.3 : -0.3) + cl(r5 * 8, -0.4, 0.4);
    const medTrend = (px > s30 ? 0.25 : -0.25) + cl(r15 * 5, -0.3, 0.3);
    const longTrend = px > s50 ? 0.15 : -0.15;

    // Volatility adjustment: scale down in high-vol, up in low-vol
    const volAdj = v20 > 0.001 ? cl(0.015 / v20, 0.3, 2.0) : 1;

    // Mean-reversion overlay
    const ext = (px - s30) / (v20 || 0.01);
    const mr = ext > 2 ? -0.4 : ext < -2 ? 0.4 : 0;

    // Regime-aware: in mean-reverting regime, flip momentum
    const regimeFlip = regime.trend === "mean_reverting" ? -0.5 : regime.trend === "trending" ? 1.2 : 1;

    const comp = (shortTrend + medTrend + longTrend + mr) * volAdj * regimeFlip;
    const ac = Math.abs(comp);
    if (ac < 0.12) continue;

    sigs.push({
      id: "mom_" + mid + "_" + time, source: "momentum", time, cid: mid,
      dir: comp > 0 ? "BUY_YES" : "BUY_NO",
      edge: +(ac * 0.05).toFixed(4),
      conf: +cl(0.4 + ac * 0.25, 0, 0.95).toFixed(3),
      fv: r4(px + comp * 0.015), px,
      hl: 240000, exp: time + 300000,
      qs: +(ac * cl(p.length / 100, 0, 1)).toFixed(3),
    });
  }
  return sigs;
}

/**
 * Cointegration-aware statistical-arb signals. Requires corr + stability +
 * spread stationarity (ADF-like via lag-1 autocorrelation of diffs).
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {Object<string, import('./types.js').History>} hists
 * @param {number} time
 * @returns {import('./types.js').Signal[]}
 */
export function arbSigs(mkts, hists, time) {
  const sigs = [];
  for (const pair of PAIRS) {
    const mA = mkts[pair.a], mB = mkts[pair.b];
    if (!mA || !mB) continue;
    const hA = hists[pair.a], hB = hists[pair.b];
    if (!hA || !hB || hA.prices.length < 30 || hB.prices.length < 30) continue;
    const n = Math.min(hA.prices.length, hB.prices.length, 50);
    const pA = hA.prices.slice(-n), pB = hB.prices.slice(-n);
    const ma = pA.reduce((s, v) => s + v, 0) / n, mb = pB.reduce((s, v) => s + v, 0) / n;

    // Correlation
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) {
      cov += (pA[i] - ma) * (pB[i] - mb);
      va += (pA[i] - ma) ** 2;
      vb += (pB[i] - mb) ** 2;
    }
    const corr = (va && vb) ? cov / Math.sqrt(va * vb) : 0;
    if (Math.abs(corr) < 0.25) continue;

    // Stability check (split-half)
    const h = Math.floor(n / 2);
    const hc = (a, b) => {
      const l = a.length; if (l < 5) return 0;
      const am = a.reduce((s, v) => s + v, 0) / l, bm = b.reduce((s, v) => s + v, 0) / l;
      let c = 0, av = 0, bv = 0;
      for (let i = 0; i < l; i++) {
        c += (a[i] - am) * (b[i] - bm);
        av += (a[i] - am) ** 2;
        bv += (b[i] - bm) ** 2;
      }
      return (av && bv) ? c / Math.sqrt(av * bv) : 0;
    };
    const stab = 1 - Math.abs(hc(pA.slice(0, h), pB.slice(0, h)) - hc(pA.slice(h), pB.slice(h)));
    if (stab < 0.5) continue;

    // Cointegration check — ADF-like stationarity test on spread
    const beta = hStd(pA, 30) > 0 ? corr * (hStd(pB, 30) / hStd(pA, 30)) : 0;
    const spread = [];
    for (let i = 0; i < n; i++) spread.push(pB[i] - beta * pA[i]);
    const spreadMean = spread.reduce((s, v) => s + v, 0) / spread.length;
    const spreadStd = Math.sqrt(spread.reduce((s, v) => s + (v - spreadMean) ** 2, 0) / (spread.length - 1)) || 0.001;
    const spreadChanges = [];
    for (let i = 1; i < spread.length; i++) spreadChanges.push(spread[i] - spread[i - 1]);
    const lagCorr = spreadChanges.length > 5 ? (() => {
      const m = spreadChanges.reduce((s, v) => s + v, 0) / spreadChanges.length;
      let num = 0, den = 0;
      for (let i = 1; i < spreadChanges.length; i++) {
        num += (spreadChanges[i] - m) * (spreadChanges[i - 1] - m);
        den += (spreadChanges[i] - m) ** 2;
      }
      return den > 0 ? num / den : 0;
    })() : 0;
    // Negative lag-1 autocorrelation suggests mean-reversion (cointegrated)
    const isCointegrated = lagCorr < -0.15;
    if (!isCointegrated) continue;

    // Z-score of current spread
    const currentSpread = mB.yes - beta * mA.yes;
    const z = (currentSpread - spreadMean) / spreadStd;
    if (Math.abs(z) < 1.5) continue;  // Entry band

    const mismatch = currentSpread - spreadMean;
    const ne = Math.abs(mismatch) - 0.015 - 0.003;
    if (ne <= 0) continue;

    const cc = +(Math.abs(corr) * stab * cl(n / 50, 0, 1)).toFixed(3);
    sigs.push({
      id: "arb_" + pair.a + "_" + pair.b + "_" + time, source: "arb", time, cid: mB.id,
      dir: mismatch > 0 ? "BUY_NO" : "BUY_YES",
      edge: +ne.toFixed(4),
      conf: +cl(0.3 + Math.abs(z) * 0.12 * cc, 0, 0.95).toFixed(3),
      fv: r4(cl(spreadMean + beta * mA.yes, 0.02, 0.98)),
      px: mB.yes,
      hl: 600000, exp: time + 600000,
      qs: +(cc * cl(Math.abs(z) / 3, 0, 1)).toFixed(3),
      z: +z.toFixed(2), corr: +corr.toFixed(3), stab: +stab.toFixed(3),
      pair: pair.a + "\u2194" + pair.b, coint: true,
    });
  }
  return sigs;
}

/**
 * Orderflow imbalance signals derived from LOB bid/ask depth ratio.
 * @param {Object<string, import('./types.js').Market>} mkts
 * @param {Object<string, import('./types.js').Lob>} lobs
 * @param {number} time
 * @returns {import('./types.js').Signal[]}
 */
export function orderflowSigs(mkts, lobs, time) {
  const sigs = [];
  for (const [mid, m] of Object.entries(mkts)) {
    const lob = lobs[mid];
    if (!lob || lob.bidDepth < 10 || lob.askDepth < 10) continue;
    // Orderflow imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)
    const imbalance = (lob.bidDepth - lob.askDepth) / (lob.bidDepth + lob.askDepth);
    const absImb = Math.abs(imbalance);
    if (absImb < 0.15) continue;  // Need meaningful imbalance
    // Trade intensity: volume relative to ADV
    const intensity = m.adv > 0 ? cl(lob.volumeThisTick / (m.adv * 0.01), 0, 2) : 0;
    // Edge from imbalance
    const edge = absImb * 0.03 * (1 + intensity * 0.5);
    if (edge < 0.004) continue;
    sigs.push({
      id: "oflow_" + mid + "_" + time, source: "momentum", time, cid: mid,
      dir: imbalance > 0 ? "BUY_YES" : "BUY_NO",
      edge: +edge.toFixed(4),
      conf: +cl(0.3 + absImb * 0.4, 0.2, 0.85).toFixed(3),
      fv: r4(cl(m.yes + imbalance * 0.02, 0.02, 0.98)),
      px: m.yes,
      hl: 120000, exp: time + 240000,
      qs: +(absImb * 0.8).toFixed(3),
    });
  }
  return sigs;
}

/**
 * Process raw signals into sized recommendations using live state.
 * Sizing respects: live equity, DD scale, remaining notional, per-market &
 * per-category position room, half-open CB cap, vol-target, regime Kelly cap.
 * Pre-trade risk still re-validates; this layer just keeps requests sane.
 * @param {import('./types.js').Signal[]} signals
 * @param {import('./types.js').AlphaWeights} weights
 * @param {number} regConf
 * @param {number} time
 * @param {import('./types.js').LiveSizingState} liveState
 * @returns {{filtered: import('./types.js').Signal[], recs: import('./types.js').Recommendation[]}}
 */
export function processSigs(signals, weights, regConf, time, liveState) {
  const live = liveState || {};
  const liveEquity = typeof live.equity === "number" && live.equity > 0 ? live.equity : CFG.initialEquity;
  const liveDD = typeof live.currentDD === "number" ? live.currentDD : 0;
  const liveGross = typeof live.grossExposure === "number" ? live.grossExposure : 0;
  const livePositions = live.positions || {};
  const liveMarkets = live.markets || {};
  const liveCbState = live.cbState || "closed";
  const ddScale = liveDD >= CFG.maxDD ? 0 : liveDD > CFG.softDD ? 1 - Math.pow(liveDD / CFG.maxDD, 1.5) : 1;
  const capitalBase = liveEquity * ddScale;
  const remainingNotionalRoom = Math.max(0, CFG.maxExpNotional - liveGross);

  let sigs = signals.filter(s => s.exp > time && (time - s.time) / (s.exp - s.time) < 0.8);
  sigs = sigs.map(s => {
    const fr = Math.pow(0.5, (time - s.time) / (s.hl || 300000));
    return { ...s, fr: +fr.toFixed(3), ee: +(s.edge * fr).toFixed(4) };
  });
  const best = {};
  for (const s of sigs) {
    const k = s.source + ":" + s.cid;
    if (!best[k] || s.ee > best[k].ee) best[k] = s;
  }
  sigs = Object.values(best).filter(s => (s.qs || 0.5) > 0.15);
  const byM = {};
  for (const s of sigs) (byM[s.cid] || (byM[s.cid] = [])).push(s);
  const recs = [];
  for (const [mid, ms] of Object.entries(byM)) {
    let comp = 0;
    for (const s of ms) comp += s.ee * (s.dir === "BUY_YES" ? 1 : -1) * s.conf * (weights[s.source] || 0.33);
    const signs = ms.map(s => s.dir === "BUY_YES" ? 1 : -1);
    const conc = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    const conf = +cl(
      0.4 * conc +
      0.3 * cl(Math.abs(comp) * 2, 0, 1) +
      0.15 * cl(ms.length / 3, 0, 1) +
      0.15 * regConf,
      0, 0.95
    ).toFixed(3);
    const dir = comp >= 0 ? "BUY_YES" : "BUY_NO";
    const ae = Math.abs(comp) * (0.5 + conc * 0.5);
    if (ae < 0.006) continue;
    const px = ms[0].px || 0.5;
    const odds = comp > 0 ? px / (1 - px + 1e-4) : (1 - px) / (px + 1e-4);
    // Kelly capped by regime confidence
    const regimeKellyCap = regConf > 0.7 ? 0.25 : regConf > 0.4 ? 0.18 : 0.10;
    const kelly = cl((ae * odds - (1 - ae)) / (odds + 1e-4) * 0.5, 0, regimeKellyCap) * conf;
    const mkt = liveMarkets[mid];
    const sidePrice = mkt ? (dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;
    // Volatility-targeted sizing
    const mktVol = mkt ? mkt.vol || 0.02 : 0.02;
    const volScale = mktVol > 0.001 ? cl(CFG.volTargetAnnual / (mktVol * Math.sqrt(252)), 0.3, 2) : 1;
    let desiredQty = Math.floor(kelly * capitalBase * volScale);
    if (sidePrice > 0) desiredQty = Math.min(desiredQty, Math.floor(remainingNotionalRoom / sidePrice));
    const pos = livePositions[mid] || { yesQty: 0, noQty: 0 };
    desiredQty = Math.min(desiredQty, Math.max(0, CFG.maxPos - pos.yesQty - pos.noQty));
    if (mkt) {
      let catQty = 0;
      for (const [om, op] of Object.entries(livePositions)) {
        const omk = liveMarkets[om];
        if (omk && omk.cat === mkt.cat) catQty += op.yesQty + op.noQty;
      }
      desiredQty = Math.min(desiredQty, Math.max(0, CFG.maxCatQty - catQty));
    }
    if (liveCbState === "half_open" && sidePrice > 0) {
      desiredQty = Math.min(desiredQty, Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice));
    }
    if (desiredQty < 15) continue;
    const attr = {};
    ms.forEach(s => { attr[s.source] = (attr[s.source] || 0) + s.ee * s.conf; });
    const ta = Object.values(attr).reduce((s, v) => s + Math.abs(v), 0) || 1;
    Object.keys(attr).forEach(k2 => attr[k2] = +((Math.abs(attr[k2]) / ta) * 100).toFixed(1));
    recs.push({
      id: "rec_" + mid + "_" + time, time, cid: mid, dir,
      ce: +ae.toFixed(4), conf, conc: +conc.toFixed(2),
      sz: desiredQty, attr, nSigs: ms.length,
      urg: ae > 0.025 ? "immediate" : ae > 0.012 ? "patient" : "passive",
      aq: +(ms.reduce((s, x) => s + (x.qs || 0.5), 0) / ms.length).toFixed(3),
    });
  }
  return { filtered: sigs, recs };
}
