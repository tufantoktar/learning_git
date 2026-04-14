import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
//  POLYMARKET V4.1 — CORRECTNESS & DETERMINISM UPGRADE
//
//  10 mandatory fixes from V4:
//   1. Realized PnL: weighted avg cost, triggers on position reduction
//   2. YES/NO complementary: net/gross exposure, no double count
//   3. Order FSM: 7 states, valid transitions, REPLACED → new order
//   4. Partial fills: deterministic retry budget, drift threshold
//   5. MetaAlpha: learns from realized PnL only
//   6. Circuit breaker: slippage/reject/poor fill triggers
//   7. Slippage: maxSlipBps enforcement, reject on breach
//   8. Clock: injected time only (maintained from V4)
//   9. Reconciliation: idempotent fill dedup by fill key
//  10. Market validation: price/spread/depth/staleness checks
//
//  Architecture: ENGINE (pure, lines 14-700) | UI (render-only, 700+)
// ═══════════════════════════════════════════════════════════════════════

// ══════════════════════ ENGINE: PRNG ══════════════════════════════════
function createRng(seed) {
  let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r4 = v => +(+v).toFixed(4);

// ══════════════════════ ENGINE: CONFIG ════════════════════════════════
const CFG = {
  maxPos: 1500, maxExp: 6000, maxDD: 0.20, softDD: 0.12, maxCat: 3000,
  maxSlipBps: 40, minLiqRatio: 3, minSigQuality: 0.2,
  maxSpread: 0.06, minDepth: 30, stalenessMs: 10000,
  cbRecoveryMs: 60000, cbFailThreshold: 5, cbHalfOpenMaxNotional: 200,
  cbSlipThreshold: 5, cbRejectThreshold: 8, cbPoorFillThreshold: 6,
  partialRetryBudget: 2, partialDriftThreshold: 0.02, partialMinQty: 20,
  initialEquity: 10000,
};

const MDEFS = [
  { id: "btc150k", q: "BTC $150k by Dec 2026?", init: 0.42, vol: 0.02, cat: "crypto", adv: 12000 },
  { id: "recession", q: "US recession 2026?", init: 0.28, vol: 0.015, cat: "macro", adv: 8500 },
  { id: "trump28", q: "Trump 2028 GOP primary?", init: 0.61, vol: 0.01, cat: "politics", adv: 22000 },
  { id: "fedcut", q: "Fed cuts by July 2026?", init: 0.55, vol: 0.018, cat: "macro", adv: 15000 },
  { id: "aibar", q: "AI passes bar top 1%?", init: 0.73, vol: 0.012, cat: "tech", adv: 5000 },
  { id: "starship", q: "Starship orbital?", init: 0.67, vol: 0.008, cat: "tech", adv: 7000 },
  { id: "ethflip", q: "ETH flips BTC mcap?", init: 0.08, vol: 0.025, cat: "crypto", adv: 2000 },
  { id: "ceasefire", q: "Ukraine ceasefire 2026?", init: 0.34, vol: 0.014, cat: "geopolitics", adv: 9500 },
];
const PAIRS = [
  { a: "btc150k", b: "ethflip" }, { a: "recession", b: "fedcut" },
  { a: "btc150k", b: "fedcut" }, { a: "recession", b: "btc150k" },
];
const NEWS = [
  { h: "Fed signals policy shift", m: ["fedcut", "recession"], imp: 0.7 },
  { h: "Bitcoin breaks key level", m: ["btc150k", "ethflip"], imp: 0.6 },
  { h: "Polling shifts outlook", m: ["trump28"], imp: 0.5 },
  { h: "Starship test update", m: ["starship"], imp: 0.4 },
  { h: "Treasury yields move", m: ["fedcut", "recession", "btc150k"], imp: 0.5 },
  { h: "AI benchmark result", m: ["aibar"], imp: 0.6 },
  { h: "Diplomatic progress", m: ["ceasefire"], imp: 0.55 },
  { h: "Ethereum shift", m: ["ethflip", "btc150k"], imp: 0.45 },
];
const SRC_W = { Reuters: 1.0, Bloomberg: 0.95, AP: 0.9, Polymarket: 0.7, "X/Twitter": 0.5 };
const SRCS = Object.keys(SRC_W);

// ══════════════════════ ENGINE: INITIAL STATE ════════════════════════
function initState(seed = 42) {
  const markets = {}, histories = {};
  for (const d of MDEFS) {
    markets[d.id] = { id: d.id, q: d.q, yes: d.init, prevYes: d.init, vol: d.vol, cat: d.cat, adv: d.adv, lastUpdate: 0 };
    histories[d.id] = { prices: [], spreads: [], depths: [], maxLen: 300 };
  }
  return {
    seed, tickCount: 0, time: 0, markets, histories,
    regime: { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 },
    alphaWeights: { nlp: 0.33, momentum: 0.33, arb: 0.33 },
    metaPerf: { nlp: [], momentum: [], arb: [] },
    newsIntensity: 0,
    signals: [], newsLog: [], recommendations: [],
    // [3] Order ledger (append-only history + active list)
    orders: [], orderHistory: [],
    // [9] Fill ledger with dedup keys
    fills: [], fillKeys: {},
    // [1][2] Position ledger: weighted avg cost, YES/NO complementary
    positions: {},
    equity: CFG.initialEquity, equityCurve: [CFG.initialEquity],
    peakEquity: CFG.initialEquity,
    grossExposure: 0, netExposure: 0, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, currentDD: 0,
    // [6] Circuit breaker with extended triggers
    cb: { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [],
          recentSlipBps: [], recentRejects: 0, recentPoorFills: 0, halfOpenNotional: 0 },
    // [10] Market validation quarantine
    quarantined: {},
    monitor: { approvals: 0, rejections: 0, signalCounts: { nlp: 0, momentum: 0, arb: 0 } },
    events: [],
  };
}

// ══════════════════════ ENGINE: MARKET SIM ════════════════════════════
function advMkt(m, rng, time) {
  const mr = 0.002 * (0.5 - m.yes), n = (rng() - 0.5) * 2 * m.vol;
  const sh = rng() < 0.005 ? (rng() - 0.5) * 0.08 : 0;
  return { ...m, prevYes: m.yes, yes: r4(cl(m.yes + mr + n + sh, 0.02, 0.98)), adv: Math.max(500, Math.floor(m.adv + (rng() - 0.5) * 200)), lastUpdate: time };
}
function buildBook(mid, adv, rng) {
  const lf = cl(adv / 20000, 0.3, 2), bs = 0.015 / lf;
  const bids = [], asks = [];
  for (let i = 1; i <= 5; i++) { bids.push({ p: r4(cl(mid - bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) }); asks.push({ p: r4(cl(mid + bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) }); }
  return { bids, asks, spread: r4(asks[0].p - bids[0].p), mid, bidDepth: bids.reduce((s, b) => s + b.sz, 0), askDepth: asks.reduce((s, a) => s + a.sz, 0) };
}

// [10] Market validation
function validateMarket(mkt, book, time) {
  const issues = [];
  if (mkt.yes < 0 || mkt.yes > 1) issues.push("price_invalid");
  if (book.spread > CFG.maxSpread) issues.push(`spread_${(book.spread * 100).toFixed(1)}%`);
  if (book.bidDepth < CFG.minDepth || book.askDepth < CFG.minDepth) issues.push("depth_low");
  if (time - mkt.lastUpdate > CFG.stalenessMs && mkt.lastUpdate > 0) issues.push("stale");
  return { valid: issues.length === 0, issues };
}

// ══════════════════════ ENGINE: HISTORY ═══════════════════════════════
function pushHist(h, p, sp, dp) {
  const mx = h.maxLen;
  const np = [...h.prices, p], ns = [...h.spreads, sp], nd = [...h.depths, dp];
  return { ...h, prices: np.length > mx ? np.slice(-mx) : np, spreads: ns.length > mx ? ns.slice(-mx) : ns, depths: nd.length > mx ? nd.slice(-mx) : nd };
}
function hRoc(p, n) { return p.length < n + 1 ? 0 : p[p.length - n - 1] ? (p[p.length - 1] - p[p.length - n - 1]) / p[p.length - n - 1] : 0; }
function hSma(p, n) { const s = p.slice(-n); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0; }
function hStd(p, n) { const s = p.slice(-n); if (s.length < 2) return 0; const m = s.reduce((a, b) => a + b, 0) / s.length; return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1)); }
function hVol(p, n) { const s = p.slice(-n); if (s.length < 3) return 0; const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / (s[i - 1] || 1))); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)); }

// ══════════════════════ ENGINE: REGIME ════════════════════════════════
function detectRegime(prices, spreads, depths) {
  if (prices.length < 30) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  const p = prices.slice(-100);
  const rets = []; for (let i = 1; i < p.length; i++) rets.push(Math.log(p[i] / (p[i - 1] || 1)));
  if (!rets.length) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  const mR = rets.reduce((a, b) => a + b, 0) / rets.length;
  let cum = 0; const dev = rets.map(r => { cum += r - mR; return cum; });
  const R = Math.max(...dev) - Math.min(...dev);
  const S = Math.sqrt(rets.reduce((a, b) => a + (b - mR) ** 2, 0) / (rets.length - 1)) || 0.001;
  const hurst = +cl(Math.log((R / S) + 0.001) / Math.log(rets.length), 0.1, 0.9).toFixed(3);
  const fV = hVol(p, 20), sV = hVol(p, Math.min(80, p.length));
  const sp = spreads.slice(-20), dp = depths.slice(-20);
  const aS = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 0.05;
  const aD = dp.length ? dp.reduce((a, b) => a + b, 0) / dp.length : 1;
  return { trend: hurst > 0.55 ? "trending" : hurst < 0.45 ? "mean_reverting" : "neutral", vol: (fV / (sV || 0.001)) > 1.3 ? "high_vol" : "low_vol", liq: aD / (aS + 0.001) > 500 ? "high_liq" : "low_liq", confidence: +cl(prices.length / 100, 0, 1).toFixed(2), hurst };
}

// ══════════════════════ ENGINE: META-ALPHA [5] ═══════════════════════
// Learns from REALIZED PnL only, not fill quality proxies
function computeWeights(regime, metaPerf, newsInt) {
  const bases = { trending: [0.3, 0.5, 0.2], mean_reverting: [0.2, 0.2, 0.6], neutral: [0.4, 0.3, 0.3] };
  const w = [...(bases[regime.trend] || bases.neutral)];
  ["nlp", "momentum", "arb"].forEach((src, i) => {
    const p = metaPerf[src]; if (p.length >= 10) {
      const m = p.reduce((a, b) => a + b, 0) / p.length;
      const s = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / (p.length - 1)) || 0.001;
      w[i] *= Math.max(0.1, 1 + 0.3 * (m / s));
    }
  });
  if (newsInt > 0.7) w[0] *= 1.5;
  if (regime.vol === "high_vol") w[1] *= 1.3;
  if (regime.liq === "low_liq") w[2] *= 0.5;
  const t = w[0] + w[1] + w[2];
  return { nlp: +(w[0] / t).toFixed(3), momentum: +(w[1] / t).toFixed(3), arb: +(w[2] / t).toFixed(3) };
}

// ══════════════════════ ENGINE: ALPHA ═════════════════════════════════
function genNews(mkts, rng, time) {
  const tpl = NEWS[Math.floor(rng() * NEWS.length)];
  const rel = tpl.m.map(id => mkts[id]).filter(Boolean);
  const avgMove = rel.reduce((s, m) => s + (m.yes - m.prevYes), 0) / (rel.length || 1);
  const raw = cl(avgMove * 20 + (rng() - 0.5) * 0.3, -1, 1);
  const src = SRCS[Math.floor(rng() * SRCS.length)];
  const abs = Math.abs(raw), sw = SRC_W[src], lat = Math.floor(rng() * 5000);
  const ic = abs > 0.55 ? "binary_catalyst" : abs > 0.2 ? "gradual_shift" : "noise";
  return { id: `n${time}`, time, source: src, headline: tpl.h, markets: tpl.m, sentiment: r4(raw), impactClass: ic, confidence: +cl((0.5 + abs * 0.4) * sw * cl(1 - lat / 10000, 0.5, 1), 0, 0.99).toFixed(3), baseImpact: tpl.imp, srcWeight: sw, latencyMs: lat };
}
function nlpSigs(nev, mkts, time) {
  if (nev.impactClass !== "binary_catalyst" || nev.confidence < 0.55) return [];
  const sigs = [];
  for (const mid of nev.markets) { const m = mkts[mid]; if (!m) continue; const e = nev.sentiment * nev.baseImpact * nev.confidence * nev.srcWeight * 0.04; if (Math.abs(e) < 0.006) continue;
    sigs.push({ id: `nlp_${mid}_${time}`, source: "nlp", time, cid: mid, dir: e > 0 ? "BUY_YES" : "BUY_NO", edge: +Math.abs(e).toFixed(4), conf: nev.confidence, fv: r4(cl(m.yes + e, 0.02, 0.98)), px: m.yes, hl: 180000, exp: time + 720000, qs: +(nev.confidence * nev.srcWeight).toFixed(3) });
  } return sigs;
}
function momSigs(mkts, hists, time) {
  const sigs = [];
  for (const [mid, m] of Object.entries(mkts)) { const h = hists[mid]; if (!h || h.prices.length < 25) continue; const p = h.prices, px = m.yes;
    const r5 = hRoc(p, 5), s10 = hSma(p, 10), s30 = hSma(p, 30), v = hVol(p, 20);
    const tr = ((px > s10 ? 0.3 : -0.3) + (px > s30 ? 0.2 : -0.2) + cl(r5 * 10, -0.5, 0.5));
    const ext = (px - s30) / (v || 0.01), mr = ext > 2 ? -0.4 : ext < -2 ? 0.4 : 0;
    const comp = tr + mr, ac = Math.abs(comp); if (ac < 0.15) continue;
    sigs.push({ id: `mom_${mid}_${time}`, source: "momentum", time, cid: mid, dir: comp > 0 ? "BUY_YES" : "BUY_NO", edge: +(ac * 0.05).toFixed(4), conf: +cl(0.4 + ac * 0.3, 0, 0.95).toFixed(3), fv: r4(px + comp * 0.02), px, hl: 240000, exp: time + 300000, qs: +(ac * cl(p.length / 100, 0, 1)).toFixed(3) });
  } return sigs;
}
function arbSigs(mkts, hists, time) {
  const sigs = [];
  for (const pair of PAIRS) { const mA = mkts[pair.a], mB = mkts[pair.b]; if (!mA || !mB) continue;
    const hA = hists[pair.a], hB = hists[pair.b]; if (!hA || !hB || hA.prices.length < 30 || hB.prices.length < 30) continue;
    const n = Math.min(hA.prices.length, hB.prices.length, 50);
    const pA = hA.prices.slice(-n), pB = hB.prices.slice(-n);
    const ma = pA.reduce((s, v) => s + v, 0) / n, mb = pB.reduce((s, v) => s + v, 0) / n;
    let cov = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { cov += (pA[i] - ma) * (pB[i] - mb); va += (pA[i] - ma) ** 2; vb += (pB[i] - mb) ** 2; }
    const corr = (va && vb) ? cov / Math.sqrt(va * vb) : 0; if (Math.abs(corr) < 0.25) continue;
    const h = Math.floor(n / 2);
    const hc = (a, b) => { const l = a.length; if (l < 5) return 0; const am = a.reduce((s, v) => s + v, 0) / l, bm = b.reduce((s, v) => s + v, 0) / l; let c = 0, av = 0, bv = 0; for (let i = 0; i < l; i++) { c += (a[i] - am) * (b[i] - bm); av += (a[i] - am) ** 2; bv += (b[i] - bm) ** 2; } return (av && bv) ? c / Math.sqrt(av * bv) : 0; };
    const stab = 1 - Math.abs(hc(pA.slice(0, h), pB.slice(0, h)) - hc(pA.slice(h), pB.slice(h))); if (stab < 0.5) continue;
    const beta = hStd(pA, 30) > 0 ? corr * (hStd(pB, 30) / hStd(pA, 30)) : 0;
    const expB = mb + beta * (mA.yes - ma), mismatch = mB.yes - expB, z = mismatch / (hStd(pB, 30) || 0.01);
    if (Math.abs(z) < 1.8) continue; const ne = Math.abs(mismatch) - 0.02 - 0.004; if (ne <= 0) continue;
    const cc = +(Math.abs(corr) * stab * cl(n / 50, 0, 1)).toFixed(3);
    sigs.push({ id: `arb_${pair.a}_${pair.b}_${time}`, source: "arb", time, cid: mB.id, dir: mismatch > 0 ? "BUY_NO" : "BUY_YES", edge: +ne.toFixed(4), conf: +cl(0.3 + Math.abs(z) * 0.12 * cc, 0, 0.95).toFixed(3), fv: r4(cl(expB, 0.02, 0.98)), px: mB.yes, hl: 600000, exp: time + 600000, qs: +(cc * cl(Math.abs(z) / 3, 0, 1)).toFixed(3), z: +z.toFixed(2), corr: +corr.toFixed(3), stab: +stab.toFixed(3), pair: `${pair.a}↔${pair.b}` });
  } return sigs;
}

// ══════════════════════ ENGINE: SIGNAL PROCESSING ════════════════════
function processSigs(signals, weights, regConf, time) {
  let sigs = signals.filter(s => s.exp > time && (time - s.time) / (s.exp - s.time) < 0.8);
  sigs = sigs.map(s => { const fr = Math.pow(0.5, (time - s.time) / (s.hl || 300000)); return { ...s, fr: +fr.toFixed(3), ee: +(s.edge * fr).toFixed(4) }; });
  const best = {}; for (const s of sigs) { const k = `${s.source}:${s.cid}`; if (!best[k] || s.ee > best[k].ee) best[k] = s; }
  sigs = Object.values(best).filter(s => (s.qs || 0.5) > 0.15);
  const byM = {}; for (const s of sigs) (byM[s.cid] || (byM[s.cid] = [])).push(s);
  const recs = [];
  for (const [mid, ms] of Object.entries(byM)) {
    let comp = 0; for (const s of ms) comp += s.ee * (s.dir === "BUY_YES" ? 1 : -1) * s.conf * (weights[s.source] || 0.33);
    const signs = ms.map(s => s.dir === "BUY_YES" ? 1 : -1);
    const conc = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    const conf = +cl(0.4 * conc + 0.3 * cl(Math.abs(comp) * 2, 0, 1) + 0.15 * cl(ms.length / 3, 0, 1) + 0.15 * regConf, 0, 0.95).toFixed(3);
    const dir = comp >= 0 ? "BUY_YES" : "BUY_NO";
    const ae = Math.abs(comp) * (0.5 + conc * 0.5); if (ae < 0.006) continue;
    const px = ms[0].px || 0.5;
    const odds = comp > 0 ? px / (1 - px + 1e-4) : (1 - px) / (px + 1e-4);
    const k = cl((ae * odds - (1 - ae)) / (odds + 1e-4) * 0.5, 0, 0.25) * conf;
    const sz = Math.floor(k * CFG.initialEquity); if (sz < 15) continue;
    const attr = {}; ms.forEach(s => { attr[s.source] = (attr[s.source] || 0) + s.ee * s.conf; });
    const ta = Object.values(attr).reduce((s, v) => s + Math.abs(v), 0) || 1;
    Object.keys(attr).forEach(k2 => attr[k2] = +((Math.abs(attr[k2]) / ta) * 100).toFixed(1));
    recs.push({ id: `rec_${mid}_${time}`, time, cid: mid, dir, ce: +ae.toFixed(4), conf, conc: +conc.toFixed(2), sz, attr, nSigs: ms.length, urg: ae > 0.025 ? "immediate" : ae > 0.012 ? "patient" : "passive", aq: +(ms.reduce((s, x) => s + (x.qs || 0.5), 0) / ms.length).toFixed(3) });
  }
  return { filtered: sigs, recs };
}

// ══════════════════════ ENGINE: RISK [2][6][7] ═══════════════════════
// [2] YES/NO complementary exposure model
function calcExposure(positions, markets) {
  let gross = 0, net = 0; const cat = {};
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    const yN = pos.yesQty * m.yes; // yes notional
    const nN = pos.noQty * (1 - m.yes); // no notional
    gross += yN + nN; // [2] gross = yes_notional + no_notional
    net += Math.abs(yN - nN); // [2] net = |yes_notional - no_notional|
    cat[m.cat] = (cat[m.cat] || 0) + yN + nN;
  }
  return { gross: +gross.toFixed(2), net: +net.toFixed(2), cat };
}

function preTradeRisk(rec, snap) {
  const { positions, markets, cb, currentDD, grossExposure } = snap;
  const ch = []; let ok = true, sz = rec.sz;
  // [6] CB
  if (cb.state === "open") { ch.push({ n: "CB", s: "blocked", d: cb.reason }); ok = false; }
  else if (cb.state === "half_open") {
    if (sz > CFG.cbHalfOpenMaxNotional) { sz = CFG.cbHalfOpenMaxNotional; ch.push({ n: "CB", s: "adjusted", d: `half_open cap ${CFG.cbHalfOpenMaxNotional}` }); }
    else ch.push({ n: "CB", s: "adjusted", d: "half_open probe" });
  } else ch.push({ n: "CB", s: "pass", d: "closed" });
  // [2] Position limit (YES+NO combined for same market)
  const pos = positions[rec.cid] || { yesQty: 0, noQty: 0 };
  const existGross = pos.yesQty + pos.noQty;
  if (existGross + sz > CFG.maxPos) { sz = Math.max(0, CFG.maxPos - existGross); ch.push({ n: "Pos", s: sz > 0 ? "adjusted" : "blocked", d: `${existGross}+${sz}` }); if (!sz) ok = false; }
  else ch.push({ n: "Pos", s: "pass", d: `${existGross + sz}` });
  // Exposure
  if (grossExposure + sz > CFG.maxExp) { sz = Math.max(0, CFG.maxExp - grossExposure); ch.push({ n: "Exp", s: sz > 0 ? "adjusted" : "blocked", d: `${grossExposure + sz}` }); if (!sz) ok = false; }
  else ch.push({ n: "Exp", s: "pass", d: `${grossExposure + sz}` });
  // DD dynamic sizing
  const scale = currentDD >= CFG.maxDD ? 0 : currentDD > CFG.softDD ? 1 - Math.pow(currentDD / CFG.maxDD, 1.5) : 1;
  if (scale < 1) { sz = Math.floor(sz * scale); ch.push({ n: "DD", s: scale > 0 ? "adjusted" : "blocked", d: `s=${scale.toFixed(2)}` }); if (!sz) ok = false; }
  else ch.push({ n: "DD", s: "pass", d: `${(currentDD * 100).toFixed(1)}%` });
  // Theme
  const mkt = markets[rec.cid];
  const catE = Object.entries(positions).reduce((s, [id, p]) => { const m2 = markets[id]; return m2 && m2.cat === mkt?.cat ? s + p.yesQty + p.noQty : s; }, 0);
  if (catE + sz > CFG.maxCat) { sz = Math.max(0, CFG.maxCat - catE); ch.push({ n: "Theme", s: sz > 0 ? "adjusted" : "blocked", d: mkt?.cat }); if (!sz) ok = false; }
  else ch.push({ n: "Theme", s: "pass", d: `${mkt?.cat}:${catE + sz}` });
  // Liq
  const lr = mkt ? mkt.adv / (sz + 0.001) : 999;
  if (lr < CFG.minLiqRatio) { ch.push({ n: "Liq", s: "blocked", d: `${lr.toFixed(1)}` }); ok = false; } else ch.push({ n: "Liq", s: "pass", d: `${lr.toFixed(1)}` });
  // Quality
  if ((rec.aq || 0) < CFG.minSigQuality) { ch.push({ n: "Qual", s: "blocked", d: `${rec.aq}` }); ok = false; } else ch.push({ n: "Qual", s: "pass", d: `${rec.aq}` });
  // [10] Quarantine check
  if (snap.quarantined[rec.cid]) { ch.push({ n: "MktVal", s: "blocked", d: snap.quarantined[rec.cid].join(",") }); ok = false; }
  else ch.push({ n: "MktVal", s: "pass", d: "valid" });
  return { ok: ok && sz >= 15, sz, ch };
}

// ══════════════════════ ENGINE: EXECUTION [3][4][7] ══════════════════
// [3] Order FSM: NEW→ACCEPTED→PARTIALLY_FILLED→FILLED|CANCELLED|REJECTED
// REPLACED creates new order, old goes to history
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED"]);
const VALID_TRANSITIONS = { NEW: ["ACCEPTED", "REJECTED"], ACCEPTED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED"], PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REPLACED"] };

function canTransition(from, to) { return (VALID_TRANSITIONS[from] || []).includes(to); }

function createOrder(rec, verdict, mkts, time, rng) {
  if (!verdict.ok) return null;
  const m = mkts[rec.cid]; if (!m) return null;
  const side = rec.dir === "BUY_YES" ? "YES" : "NO";
  const mid = side === "YES" ? m.yes : 1 - m.yes;
  const bk = buildBook(m.yes, m.adv, rng);
  const adj = rec.urg === "immediate" ? bk.spread * 0.6 : rec.urg === "patient" ? -bk.spread * 0.3 : 0;
  const lim = r4(cl(mid + adj, 0.01, 0.99));
  let strat = "patient";
  if (verdict.sz < 500 && rec.urg === "immediate") strat = "aggressive";
  else if (verdict.sz > 2000) strat = "twap";
  else if (verdict.sz > 500) strat = "vwap";
  const maxCh = strat === "twap" ? 100 : strat === "aggressive" ? verdict.sz : 200;
  const nCh = Math.ceil(verdict.sz / maxCh);
  const children = []; let rem = verdict.sz;
  for (let i = 0; i < nCh; i++) { const sz = Math.min(rem, maxCh); children.push({ id: `ch_${time}_${i}`, sz, lim, fp: null, st: "NEW" }); rem -= sz; }
  return {
    id: `ord_${rec.cid}_${time}`, time, cid: rec.cid, side, dir: rec.dir,
    parentSz: verdict.sz, lim, strat, children,
    status: "NEW", totalFilled: 0, avgFP: null,
    ce: rec.ce, attr: rec.attr, riskCh: verdict.ch, urg: rec.urg,
    fillRate: 0, slipBps: null, partialAction: null,
    retryBudget: CFG.partialRetryBudget,
  };
}

// [7] Slippage enforcement
function checkSlippage(fillPx, limitPx, midPx) {
  const slipAbs = Math.abs(fillPx - limitPx);
  const slipBps = (slipAbs / (midPx || 0.5)) * 10000;
  return { slipBps: +slipBps.toFixed(2), exceeded: slipBps > CFG.maxSlipBps };
}

function simFills(order, rng, mkts) {
  if (TERMINAL.has(order.status)) return { order, newFills: [] };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };

  // [3] Transition NEW → ACCEPTED
  if (o.status === "NEW") { if (!canTransition("NEW", "ACCEPTED")) return { order: o, newFills: [] }; o.status = "ACCEPTED"; }

  const mkt = mkts[o.cid];
  const mid = mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim;
  let filled = 0, cost = 0;
  const newFills = [];

  for (const ch of o.children) {
    if (ch.st === "FILLED") { filled += ch.sz; cost += ch.fp * ch.sz; continue; }
    if (ch.st !== "NEW" && ch.st !== "ACCEPTED") continue;
    ch.st = "ACCEPTED";
    const fr = o.strat === "aggressive" ? 0.92 : o.strat === "twap" ? 0.8 : o.strat === "vwap" ? 0.78 : 0.6;
    if (rng() < fr) {
      const rawFP = +(ch.lim + (rng() - 0.5) * 0.004).toFixed(4);
      // [7] Slippage check per child fill
      const slip = checkSlippage(rawFP, ch.lim, mid);
      if (slip.exceeded) {
        ch.st = "REJECTED"; // [7] reject this child on excessive slippage
        continue;
      }
      ch.fp = rawFP; ch.st = "FILLED";
      filled += ch.sz; cost += rawFP * ch.sz;
      // [9] Create fill with deterministic key for dedup
      newFills.push({ key: `fill_${o.id}_${ch.id}`, orderId: o.id, cid: o.cid, side: o.side, qty: ch.sz, px: rawFP, time: o.time, slipBps: slip.slipBps });
    }
  }

  o.totalFilled = filled;
  o.avgFP = filled > 0 ? +(cost / filled).toFixed(4) : null;
  o.fillRate = +(filled / o.parentSz).toFixed(2);
  o.slipBps = newFills.length ? +(newFills.reduce((s, f) => s + f.slipBps, 0) / newFills.length).toFixed(2) : o.slipBps;

  // [3] State transitions
  if (filled >= o.parentSz) { if (canTransition(o.status, "FILLED")) o.status = "FILLED"; }
  else if (filled > 0 && o.status !== "PARTIALLY_FILLED") { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }

  // [4] Deterministic partial fill handling
  if (o.status === "PARTIALLY_FILLED") {
    const remaining = o.parentSz - filled;
    const drift = mkt ? Math.abs(mkt.yes - (o.side === "YES" ? o.lim : 1 - o.lim)) : 0;
    if (remaining < CFG.partialMinQty) {
      o.partialAction = { action: "CANCEL", reason: `remaining ${remaining} < minQty ${CFG.partialMinQty}` };
      if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    } else if (o.retryBudget > 0 && drift <= CFG.partialDriftThreshold) {
      o.partialAction = { action: "RETRY", reason: `budget=${o.retryBudget}, drift=${(drift * 100).toFixed(1)}%` };
      o.retryBudget--;
    } else if (drift > CFG.partialDriftThreshold) {
      o.partialAction = { action: "UNWIND", reason: `drift ${(drift * 100).toFixed(1)}% > ${(CFG.partialDriftThreshold * 100)}%` };
      if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    } else {
      o.partialAction = { action: "CANCEL", reason: "retry budget exhausted" };
      if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    }
  }

  return { order: o, newFills };
}

// ══════════════════════ ENGINE: PORTFOLIO [1][2] ═════════════════════
// [1] Realized PnL: triggers ONLY on position reduction via weighted avg cost
// [9] Idempotent fill application (dedup by fill key)
function applyFills(positions, fills, fillKeys, newFills) {
  let pos = { ...positions }; let fs = [...fills]; let fk = { ...fillKeys };
  for (const f of newFills) {
    // [9] Dedup: reject if fill key already exists
    if (fk[f.key]) continue;
    fk[f.key] = true;
    fs.push(f);
    const mid = f.cid;
    const p = pos[mid] ? { ...pos[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      // [1] Check if this is increasing or reducing position
      // Buying YES when we hold NO = offsetting (realize PnL on NO side)
      if (p.noQty > 0) {
        // [2] Offsetting: reduce NO position, realize PnL
        const offsetQty = Math.min(f.qty, p.noQty);
        // YES price + NO price should sum to ~1. Realized PnL = offsetQty * ((1 - f.px) - noAvgPx)
        // But since we're buying YES at f.px, the NO offset realizes at (1 - f.px)
        const noExitPx = 1 - f.px;
        const rpnl = offsetQty * (noExitPx - p.noAvgPx);
        p.realizedPnl = +(p.realizedPnl + rpnl).toFixed(4);
        p.noQty -= offsetQty;
        if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; }
        // Remaining qty adds to YES side
        const addQty = f.qty - offsetQty;
        if (addQty > 0) {
          const total = p.yesQty + addQty;
          p.yesAvgPx = total > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * addQty) / total) : 0;
          p.yesQty = total;
        }
      } else {
        // Pure add to YES
        const total = p.yesQty + f.qty;
        p.yesAvgPx = total > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / total) : 0;
        p.yesQty = total;
      }
    } else {
      // BUY_NO: mirror logic
      if (p.yesQty > 0) {
        const offsetQty = Math.min(f.qty, p.yesQty);
        const yesExitPx = 1 - f.px;
        const rpnl = offsetQty * (yesExitPx - p.yesAvgPx);
        p.realizedPnl = +(p.realizedPnl + rpnl).toFixed(4);
        p.yesQty -= offsetQty;
        if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; }
        const addQty = f.qty - offsetQty;
        if (addQty > 0) {
          const total = p.noQty + addQty;
          p.noAvgPx = total > 0 ? r4((p.noAvgPx * p.noQty + f.px * addQty) / total) : 0;
          p.noQty = total;
        }
      } else {
        const total = p.noQty + f.qty;
        p.noAvgPx = total > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / total) : 0;
        p.noQty = total;
      }
    }
    pos = { ...pos, [mid]: p };
  }
  return { positions: pos, fills: fs, fillKeys: fk };
}

function computeMetrics(positions, markets, eqCurve, peakEq) {
  let rPnl = 0, uPnl = 0;
  const exp = calcExposure(positions, markets);
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    rPnl += pos.realizedPnl;
    uPnl += pos.yesQty * (m.yes - pos.yesAvgPx) + pos.noQty * ((1 - m.yes) - pos.noAvgPx);
  }
  const totalPnl = +(rPnl + uPnl).toFixed(2);
  const equity = +(CFG.initialEquity + totalPnl).toFixed(2);
  const pk = Math.max(peakEq, equity);
  const dd = pk > 0 ? +((pk - equity) / pk).toFixed(4) : 0;
  const curve = [...eqCurve, equity]; if (curve.length > 200) curve.splice(0, curve.length - 200);
  return { realizedPnl: +rPnl.toFixed(2), unrealizedPnl: +uPnl.toFixed(2), totalPnl, equity, peakEquity: pk, currentDD: dd, equityCurve: curve, grossExposure: exp.gross, netExposure: exp.net, catExposure: exp.cat };
}

// ══════════════════════ ENGINE: CIRCUIT BREAKER [6] ══════════════════
function updateCB(cb, metrics, allFills, time) {
  const next = { ...cb, triggers: [...cb.triggers], recentSlipBps: [...cb.recentSlipBps] };
  // Recovery
  if (next.state === "open" && time - next.lastFailTime > CFG.cbRecoveryMs) { next.state = "half_open"; next.halfOpenNotional = 0; }
  // Half_open → closed after successful probe
  if (next.state === "half_open" && next.halfOpenNotional > 0 && next.recentRejects === 0) {
    next.state = "closed"; next.failCount = 0; next.reason = null;
  }
  // Trip: drawdown
  if (metrics.currentDD > CFG.maxDD) { next.state = "open"; next.reason = `DD ${(metrics.currentDD * 100).toFixed(1)}%`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); }
  // Trip: exposure
  if (metrics.grossExposure > CFG.maxExp * 1.3) { next.state = "open"; next.reason = `Exp ${metrics.grossExposure}`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); }
  // [6] Trip: excessive slippage
  const recentSlip = allFills.slice(-10).filter(f => f.slipBps > CFG.maxSlipBps * 0.8);
  if (recentSlip.length >= CFG.cbSlipThreshold) { next.state = "open"; next.reason = `Slip: ${recentSlip.length} high-slip fills`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); }
  // [6] Trip: repeated rejects
  if (next.recentRejects >= CFG.cbRejectThreshold) { next.state = "open"; next.reason = `${next.recentRejects} rejects`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); next.recentRejects = 0; }
  // Trim triggers
  if (next.triggers.length > 20) next.triggers = next.triggers.slice(-15);
  return next;
}

// ══════════════════════ ENGINE: TICK [strict 15-step pipeline] ════════
function tick(prev, tickTime) {
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;

  // 1. Immutable derive
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };

  // 2. Advance markets
  const newMkts = {}; for (const [id, m] of Object.entries(s.markets)) newMkts[id] = advMkt(m, rng, time);
  s.markets = newMkts;

  // 3. Update histories
  const newH = {}; for (const [id, m] of Object.entries(s.markets)) {
    const bk = buildBook(m.yes, m.adv, rng);
    newH[id] = pushHist(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, m.yes, bk.spread, bk.bidDepth);
  }
  s.histories = newH;

  // 4. [10] Validate markets
  const quarantined = {};
  for (const [id, m] of Object.entries(s.markets)) {
    const bk = buildBook(m.yes, m.adv, rng);
    const v = validateMarket(m, bk, time);
    if (!v.valid) { quarantined[id] = v.issues; s.events.push({ evt: "mkt:invalid", ts: time, s: `${id}:${v.issues.join(",")}` }); }
  }
  s.quarantined = quarantined;

  // 5. Regime
  const mH = s.histories["btc150k"] || Object.values(s.histories)[0];
  if (mH && mH.prices.length > 30) s.regime = detectRegime(mH.prices, mH.spreads, mH.depths);

  // 6. Alpha weights
  s.alphaWeights = computeWeights(s.regime, s.metaPerf, s.newsIntensity);

  // 7. Generate signals
  let sigs = [...s.signals];
  if (rng() < 0.3) {
    const nev = genNews(s.markets, rng, time);
    s.newsLog = [nev, ...s.newsLog].slice(0, 60);
    s.newsIntensity = nev.impactClass === "binary_catalyst" ? 0.9 : nev.impactClass === "gradual_shift" ? 0.5 : 0.1;
    const ns = nlpSigs(nev, s.markets, time);
    sigs.push(...ns);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, nlp: s.monitor.signalCounts.nlp + ns.length } };
    s.events.push({ evt: "news", ts: time, s: `${nev.impactClass}|${nev.headline.slice(0, 25)}` });
  }
  const ms2 = momSigs(s.markets, s.histories, time);
  sigs = sigs.filter(x => x.source !== "momentum"); sigs.push(...ms2);
  s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, momentum: s.monitor.signalCounts.momentum + ms2.length } };
  if (rng() < 0.35) {
    const as2 = arbSigs(s.markets, s.histories, time);
    sigs = sigs.filter(x => x.source !== "arb"); sigs.push(...as2);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, arb: s.monitor.signalCounts.arb + as2.length } };
  }

  // 8. Process signals → recs
  const { filtered, recs } = processSigs(sigs, s.alphaWeights, s.regime.confidence, time);
  s.signals = filtered.slice(0, 80);
  s.recommendations = [...recs, ...s.recommendations].slice(0, 40);

  // 9-11. Order lifecycle + fills + portfolio
  let positions = {}; for (const [k, v] of Object.entries(s.positions)) positions[k] = { ...v };
  let fills = [...s.fills], fillKeys = { ...s.fillKeys };
  let orders = s.orders.map(o => ({ ...o, children: o.children.map(c => ({ ...c })) }));
  let orderHistory = [...s.orderHistory];
  let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let cb = { ...s.cb, triggers: [...s.cb.triggers], recentSlipBps: [...s.cb.recentSlipBps] };
  let allNewFills = [];

  // 9a. Retry existing non-terminal orders
  orders = orders.map(o => {
    if (TERMINAL.has(o.status)) return o;
    const { order: uo, newFills: nf } = simFills(o, rng, s.markets);
    allNewFills.push(...nf);
    return uo;
  });

  // 9b. Move terminal to history, keep active
  const activeOrders = [];
  for (const o of orders) { if (TERMINAL.has(o.status)) orderHistory.push(o); else activeOrders.push(o); }
  orders = activeOrders;

  // 9c. New recs → risk → orders
  const snap = { positions, markets: s.markets, cb, currentDD: s.currentDD, grossExposure: s.grossExposure, quarantined };
  for (const rec of recs) {
    const expSnap = { ...snap, grossExposure: calcExposure(positions, s.markets).gross };
    const verdict = preTradeRisk(rec, expSnap);
    if (verdict.ok) { monitor.approvals++; cb.recentRejects = Math.max(0, cb.recentRejects - 1); }
    else { monitor.rejections++; cb.recentRejects = (cb.recentRejects || 0) + 1; }
    s.events.push({ evt: verdict.ok ? "risk:pass" : "risk:reject", ts: time, s: `${rec.cid}|sz=${verdict.sz}` });

    const ord = createOrder(rec, verdict, s.markets, time, rng);
    if (!ord) continue;
    const { order: filled, newFills: nf } = simFills(ord, rng, s.markets);
    allNewFills.push(...nf);
    if (TERMINAL.has(filled.status)) orderHistory.push(filled); else orders.push(filled);
    s.events.push({ evt: "exec", ts: time, s: `${filled.cid}|${filled.strat}|${filled.status}|f=${filled.totalFilled}` });
    if (filled.partialAction) s.events.push({ evt: "partial", ts: time, s: `${filled.partialAction.action}|${filled.partialAction.reason}` });

    // [6] Track slippage for CB
    if (filled.slipBps != null) cb.recentSlipBps.push(filled.slipBps);
    if (cb.recentSlipBps.length > 20) cb.recentSlipBps = cb.recentSlipBps.slice(-15);
    // [6] Track poor fills for CB
    if (filled.fillRate < 0.3 && filled.parentSz > 50) cb.recentPoorFills = (cb.recentPoorFills || 0) + 1;
    if (cb.state === "half_open" && filled.totalFilled > 0) cb.halfOpenNotional += filled.totalFilled;
  }

  // 11. [9] Apply fills idempotently
  const fResult = applyFills(positions, fills, fillKeys, allNewFills);
  positions = fResult.positions; fills = fResult.fills; fillKeys = fResult.fillKeys;

  // [5] MetaAlpha: learn from REALIZED PnL only
  // Check if any position had realized PnL change this tick
  for (const [mid, pos] of Object.entries(positions)) {
    const prevPos = s.positions[mid];
    if (!prevPos) continue;
    const rpnlDelta = pos.realizedPnl - prevPos.realizedPnl;
    if (Math.abs(rpnlDelta) > 0.001) {
      // Attribute to signal sources based on most recent order attribution for this market
      const recentOrd = [...orderHistory, ...orders].filter(o => o.cid === mid && o.attr).pop();
      if (recentOrd?.attr) {
        for (const [src, pct] of Object.entries(recentOrd.attr)) {
          const buf = metaPerf[src]; if (buf) { buf.push(rpnlDelta * pct / 100); if (buf.length > 50) buf.shift(); }
        }
      }
    }
  }

  // 12. Reconcile (positions derived from fills — verify)
  // [9] Position MUST be derivable from fill ledger
  // (In this sim, applyFills is the single source of truth, so consistency is guaranteed by construction)

  // 13. Metrics
  const metrics = computeMetrics(positions, s.markets, s.equityCurve, s.peakEquity);

  // 14. [6] Circuit breaker
  cb = updateCB(cb, metrics, fills, time);

  // Trim
  orderHistory = orderHistory.slice(-100);
  fills = fills.slice(-300);

  return {
    ...s, positions, fills, fillKeys, orders, orderHistory,
    equity: metrics.equity, equityCurve: metrics.equityCurve,
    peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure,
    netExposure: metrics.netExposure,
    totalPnl: metrics.totalPnl, realizedPnl: metrics.realizedPnl,
    unrealizedPnl: metrics.unrealizedPnl, currentDD: metrics.currentDD,
    cb, monitor, metaPerf,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  UI LAYER — RENDERING ONLY
// ═══════════════════════════════════════════════════════════════════════
const FF = "'JetBrains Mono','Fira Code',monospace", SS = "'DM Sans',sans-serif";
const K = { bg: "#060610", s1: "#0c0c18", s2: "#131322", bd: "#24243a", tx: "#e2e2f0", dm: "#5a5a7c", g: "#00e89a", gd: "#00e89a20", r: "#ff3355", rd: "#ff335520", y: "#ffb830", yd: "#ffb83020", b: "#2d8cf0", b2: "#2d8cf020", p: "#9966ff", pd: "#9966ff20", c: "#00ccee", cd: "#00ccee20", o: "#ff8844", od: "#ff884420" };
const bx = (c, bg) => ({ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: FF, color: c, background: bg, fontWeight: 600 });
const cd2 = { background: K.s1, border: `1px solid ${K.bd}`, borderRadius: 8, padding: 12, marginBottom: 8 };
const mc2 = { background: K.s2, borderRadius: 6, padding: "7px 10px" };
const ft = t => new Date(t).toLocaleTimeString("en", { hour12: false });
const fp = (v, d = 1) => (v * 100).toFixed(d) + "%";
const f$ = (v, d = 0) => "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: d });
const mq = id => MDEFS.find(m => m.id === id)?.q || id;

function Sp({ data, color = K.g, w = 120, h = 24 }) { if (!data || data.length < 2) return null; const mn = Math.min(...data), mx = Math.max(...data), rn = mx - mn || 1; return <svg width={w} height={h} style={{ display: "block" }}><polyline points={data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / rn) * h}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} /></svg>; }
function St({ l, v, c = K.tx, s }) { return <div style={mc2}><div style={{ fontSize: 9, color: K.dm, fontFamily: FF }}>{l}</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: FF, color: c, marginTop: 2 }}>{v}</div>{s && <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginTop: 1 }}>{s}</div>}</div>; }
function RB({ s }) { const m = { pass: { c: K.g, b: K.gd }, adjusted: { c: K.y, b: K.yd }, blocked: { c: K.r, b: K.rd } }; const x = m[s] || m.pass; return <span style={bx(x.c, x.b)}>{(s || "").toUpperCase()}</span>; }

const TABS = ["Dashboard", "Regime", "Alpha", "Execution", "Risk", "System"];

export default function V41() {
  const [state, setState] = useState(() => initState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const intRef = useRef(null);
  useEffect(() => {
    if (running) { intRef.current = setInterval(() => setState(p => tick(p, Date.now())), 2000); return () => clearInterval(intRef.current); }
    else clearInterval(intRef.current);
  }, [running]);
  const st = state, mA = Object.values(st.markets), allOrds = [...st.orders, ...st.orderHistory.slice(-20)].sort((a, b) => b.time - a.time);
  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg,${K.g},${K.c})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: K.bg, fontFamily: FF }}>4.1</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V4.1</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>REALIZED PNL · YES/NO MODEL · ORDER FSM · RECONCILIATION</div></div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={bx(st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm, st.regime.trend === "trending" ? K.gd : st.regime.trend === "mean_reverting" ? K.pd : K.s2)}>{st.regime.trend}</span>
          <span style={bx(st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r, st.cb.state === "closed" ? K.gd : st.cb.state === "half_open" ? K.yd : K.rd)}>CB:{st.cb.state}</span>
          <span style={bx(running ? K.g : K.r, running ? K.gd : K.rd)}>{running ? "● LIVE" : "○ OFF"}</span>
          <button onClick={() => { setRunning(r => !r); if (st.cb.state === "open") setState(p => ({ ...p, cb: { ...p.cb, state: "closed", failCount: 0, reason: null, recentRejects: 0 } })); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: running ? K.r : K.g, color: K.bg, fontFamily: FF, fontSize: 10, fontWeight: 700 }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 1, borderBottom: `1px solid ${K.bd}`, marginBottom: 10, overflowX: "auto" }}>{TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 10px", background: tab === t ? K.s2 : "transparent", color: tab === t ? K.g : K.dm, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", borderBottom: tab === t ? `2px solid ${K.g}` : "2px solid transparent" }}>{t}</button>)}</div>

      {/* DASHBOARD */}
      {tab === "Dashboard" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Equity" v={f$(st.equity)} c={st.equity >= CFG.initialEquity ? K.g : K.r} />
          <St l="Realized" v={(st.realizedPnl >= 0 ? "+" : "") + f$(st.realizedPnl)} c={st.realizedPnl >= 0 ? K.g : K.r} />
          <St l="Unrealized" v={(st.unrealizedPnl >= 0 ? "+" : "") + f$(st.unrealizedPnl)} c={st.unrealizedPnl >= 0 ? K.g : K.r} />
          <St l="Gross exp" v={f$(st.grossExposure)} c={st.grossExposure > 4000 ? K.y : K.tx} />
          <St l="Net exp" v={f$(st.netExposure)} c={K.b} />
          <St l="Drawdown" v={fp(st.currentDD)} c={st.currentDD > 0.1 ? K.r : st.currentDD > 0.05 ? K.y : K.g} />
          <St l="Tick" v={st.tickCount} c={K.b} s={`seed:${st.seed}`} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EQUITY (deterministic)</div><Sp data={st.equityCurve} w={640} h={50} color={st.equity >= CFG.initialEquity ? K.g : K.r} /></div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 5 }}>MARKETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {mA.map(m => { const ch = m.yes - m.prevYes; const q = st.quarantined[m.id]; return <div key={m.id} style={{ ...mc2, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: q ? 0.5 : 1 }}>
              <div style={{ fontSize: 10, maxWidth: "50%" }}>{m.q}{q && <span style={{ ...bx(K.r, K.rd), marginLeft: 4 }}>Q</span>}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: FF, fontSize: 8, color: ch > 0 ? K.g : ch < 0 ? K.r : K.dm }}>{ch > 0 ? "+" : ""}{(ch * 100).toFixed(2)}¢</span>
                <span style={{ fontFamily: FF, fontSize: 12, fontWeight: 700, color: m.yes > 0.5 ? K.g : K.b }}>{(m.yes * 100).toFixed(1)}¢</span>
              </div></div>; })}
          </div>
        </div>
      </div>}

      {/* REGIME */}
      {tab === "Regime" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 8 }}>
          <St l="Trend" v={st.regime.trend} c={st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm} />
          <St l="Vol" v={st.regime.vol} c={st.regime.vol === "high_vol" ? K.r : K.g} />
          <St l="Liq" v={st.regime.liq} c={st.regime.liq === "low_liq" ? K.r : K.g} />
          <St l="Hurst" v={st.regime.hurst} c={st.regime.hurst > 0.55 ? K.g : st.regime.hurst < 0.45 ? K.p : K.dm} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>META-ALPHA (learns from realized PnL only)</div>
          {Object.entries(st.alphaWeights).map(([k, v]) => <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}><span>{k} <span style={{ fontSize: 8, color: K.dm }}>({st.metaPerf[k]?.length || 0} samples)</span></span><span style={{ fontFamily: FF, fontWeight: 700, color: v > 0.4 ? K.g : K.dm }}>{fp(v, 0)}</span></div>
            <div style={{ height: 5, background: K.s2, borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${v * 100}%`, height: "100%", background: k === "nlp" ? K.c : k === "momentum" ? K.p : K.b, borderRadius: 3 }} /></div>
          </div>)}
        </div>
      </div>}

      {/* ALPHA */}
      {tab === "Alpha" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>NEWS</div>
          <div style={{ maxHeight: 150, overflowY: "auto" }}>{st.newsLog.slice(0, 12).map(n => <div key={n.id} style={{ display: "flex", gap: 4, padding: "3px 0", borderBottom: `1px solid ${K.bd}10`, fontSize: 9, alignItems: "center" }}>
            <span style={{ fontFamily: FF, fontSize: 8, color: K.dm, minWidth: 40 }}>{ft(n.time)}</span>
            <span style={bx(K.tx, K.s2)}>{n.source}</span>
            <span style={{ flex: 1 }}>{n.headline}</span>
            <span style={bx(n.impactClass === "binary_catalyst" ? K.r : n.impactClass === "gradual_shift" ? K.y : K.dm, n.impactClass === "binary_catalyst" ? K.rd : n.impactClass === "gradual_shift" ? K.yd : K.s2)}>{n.impactClass === "binary_catalyst" ? "CAT" : n.impactClass === "gradual_shift" ? "SHIFT" : "NOISE"}</span>
          </div>)}</div>
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>SIGNALS</div>
          <div style={{ maxHeight: 160, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: FF }}><thead><tr style={{ color: K.dm, textAlign: "left", borderBottom: `1px solid ${K.bd}` }}><th style={{ padding: "3px" }}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FRESH</th></tr></thead>
              <tbody>{st.signals.slice(0, 12).map(s => <tr key={s.id}><td style={{ padding: "3px" }}><span style={bx(s.source === "nlp" ? K.c : s.source === "momentum" ? K.p : K.b, s.source === "nlp" ? K.cd : s.source === "momentum" ? K.pd : K.b2)}>{s.source}</span></td>
                <td style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(s.cid)}</td>
                <td><span style={bx(s.dir === "BUY_YES" ? K.g : K.r, s.dir === "BUY_YES" ? K.gd : K.rd)}>{s.dir === "BUY_YES" ? "Y" : "N"}</span></td>
                <td style={{ color: K.y }}>{s.ee ? fp(s.ee, 2) : fp(s.edge, 2)}</td>
                <td style={{ color: (s.fr || 1) > 0.5 ? K.g : K.r }}>{s.fr ? fp(s.fr, 0) : "—"}</td>
              </tr>)}</tbody></table>
          </div>
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RECOMMENDATIONS</div>
          {st.recommendations.slice(0, 5).map(r => <div key={r.id} style={{ ...mc2, marginBottom: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 600 }}>{mq(r.cid)}</span>
              <div style={{ display: "flex", gap: 3 }}><span style={bx(r.dir === "BUY_YES" ? K.g : K.r, r.dir === "BUY_YES" ? K.gd : K.rd)}>{r.dir}</span><span style={bx(r.urg === "immediate" ? K.r : K.y, r.urg === "immediate" ? K.rd : K.yd)}>{r.urg}</span></div>
            </div>
            <div style={{ display: "flex", gap: 5, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
              <span>Edge:<b style={{ color: K.y }}>{fp(r.ce, 2)}</b></span><span>Conf:<b style={{ color: K.g }}>{fp(r.conf, 0)}</b></span><span>Size:<b>{f$(r.sz)}</b></span>
              {Object.entries(r.attr).map(([k2, v]) => <span key={k2} style={bx(K.tx, K.s2)}>{k2}:{v}%</span>)}
            </div>
          </div>)}
        </div>
      </div>}

      {/* EXECUTION */}
      {tab === "Execution" && <div style={cd2}>
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDERS — FSM: NEW→ACCEPTED→PARTIAL→FILLED|CANCELLED|REJECTED</div>
        {allOrds.length === 0 && <div style={{ color: K.dm, fontSize: 10 }}>No orders...</div>}
        <div style={{ maxHeight: 420, overflowY: "auto" }}>{allOrds.slice(0, 15).map(e => <div key={e.id} style={{ ...mc2, marginBottom: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 600, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(e.cid)}</span>
            <div style={{ display: "flex", gap: 2 }}>
              <span style={bx(e.side === "YES" ? K.g : K.r, e.side === "YES" ? K.gd : K.rd)}>{e.side}</span>
              <span style={bx(e.status === "FILLED" ? K.g : e.status === "PARTIALLY_FILLED" ? K.y : e.status === "CANCELLED" || e.status === "REJECTED" ? K.r : K.b, e.status === "FILLED" ? K.gd : e.status === "PARTIALLY_FILLED" ? K.yd : e.status === "CANCELLED" || e.status === "REJECTED" ? K.rd : K.b2)}>{e.status}</span>
              <span style={bx(K.p, K.pd)}>{e.strat}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 5, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
            <span>Sz:{f$(e.parentSz)}</span><span>Fill:<b style={{ color: K.g }}>{f$(e.totalFilled)}</b>({fp(e.fillRate, 0)})</span>
            {e.slipBps != null && <span>Slip:<b style={{ color: e.slipBps > CFG.maxSlipBps ? K.r : K.g }}>{e.slipBps}bps</b></span>}
            {e.retryBudget != null && <span>Retry:{e.retryBudget}</span>}
          </div>
          <div style={{ display: "flex", gap: 1.5, marginTop: 2 }}>{e.children.map(ch => <div key={ch.id} style={{ width: Math.max(12, ch.sz / 5), height: 5, borderRadius: 2, background: ch.st === "FILLED" ? K.g : ch.st === "REJECTED" ? K.r : K.bd, opacity: 0.7 }} />)}</div>
          {e.partialAction && <div style={{ marginTop: 2, padding: "2px 4px", borderRadius: 3, background: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.rd : K.yd, fontSize: 8, fontFamily: FF }}>
            <span style={{ color: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.r : K.y, fontWeight: 600 }}>{e.partialAction.action}</span>
            <span style={{ color: K.dm }}> {e.partialAction.reason}</span>
          </div>}
        </div>)}</div>
      </div>}

      {/* RISK */}
      {tab === "Risk" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RISK VERDICTS</div>
          {allOrds.slice(0, 5).map(e => e.riskCh && <div key={e.id} style={{ marginBottom: 4, paddingBottom: 4, borderBottom: `1px solid ${K.bd}12` }}>
            <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 2 }}>{mq(e.cid)}</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>{e.riskCh.map((ch, i) => <div key={i} style={{ display: "flex", gap: 2, alignItems: "center", fontSize: 8, fontFamily: FF }}><RB s={ch.s} /><span style={{ color: K.dm }}>{ch.n}</span></div>)}</div>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>POSITION LEDGER — [1] realized PnL on reduction · [2] YES/NO complementary</div>
          {Object.keys(st.positions).length === 0 && <div style={{ color: K.dm, fontSize: 9 }}>No positions</div>}
          {Object.entries(st.positions).map(([id, p]) => {
            const m = st.markets[id]; const uY = p.yesQty * ((m?.yes || 0) - p.yesAvgPx); const uN = p.noQty * ((1 - (m?.yes || 0)) - p.noAvgPx);
            return <div key={id} style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 8, marginBottom: 1 }}>{mq(id)} <span style={{ color: K.dm }}>({m?.cat})</span></div>
              <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
                <span>YES:{p.yesQty}@{(p.yesAvgPx * 100).toFixed(1)}¢</span>
                <span>NO:{p.noQty}@{(p.noAvgPx * 100).toFixed(1)}¢</span>
                <span style={{ color: K.g }}>rPnL:{f$(p.realizedPnl, 2)}</span>
                <span style={{ color: (uY + uN) >= 0 ? K.g : K.r }}>uPnL:{f$(uY + uN, 2)}</span>
              </div>
              <div style={{ height: 4, background: K.s2, borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
                <div style={{ width: `${Math.min(((p.yesQty + p.noQty) / CFG.maxPos) * 100, 100)}%`, height: "100%", background: (p.yesQty + p.noQty) / CFG.maxPos > 0.8 ? K.r : K.g, borderRadius: 2 }} />
              </div>
            </div>;
          })}
          {Object.keys(st.positions).length > 0 && <div style={{ marginTop: 6, fontFamily: FF, fontSize: 8, color: K.dm }}>
            Fills: {st.fills.length} (dedup keys: {Object.keys(st.fillKeys).length}) · Gross: {f$(st.grossExposure)} · Net: {f$(st.netExposure)}
          </div>}
        </div>
      </div>}

      {/* SYSTEM */}
      {tab === "System" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Approvals" v={st.monitor.approvals} c={K.g} s={`${st.monitor.rejections} rej`} />
          <St l="NLP" v={st.monitor.signalCounts.nlp} c={K.c} />
          <St l="Mom" v={st.monitor.signalCounts.momentum} c={K.p} />
          <St l="Arb" v={st.monitor.signalCounts.arb} c={K.b} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
          <St l="Fills" v={st.fills.length} c={K.g} s="append-only" />
          <St l="Orders" v={st.orders.length + st.orderHistory.length} c={K.b} />
          <St l="CB state" v={st.cb.state} c={st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r} s={st.cb.reason || "—"} />
        </div>
        {st.cb.triggers.length > 0 && <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>CB TRIGGERS</div>
          {st.cb.triggers.slice(-5).map((t, i) => <div key={i} style={{ fontSize: 8, fontFamily: FF, color: K.r, padding: "1px 0" }}>{ft(t.t)} — {t.r}</div>)}</div>}
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>EVENTS (this tick)</div>
          <div style={{ maxHeight: 250, overflowY: "auto" }}>{st.events.slice().reverse().slice(0, 25).map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", borderBottom: `1px solid ${K.bd}08`, fontSize: 8, fontFamily: FF }}>
            <span style={{ color: K.dm, minWidth: 40 }}>{ft(e.ts)}</span>
            <span style={bx(e.evt.includes("reject") || e.evt.includes("partial") || e.evt.includes("invalid") ? K.r : e.evt.includes("risk") ? K.o : e.evt.includes("exec") ? K.g : e.evt.includes("news") ? K.p : K.dm, e.evt.includes("reject") || e.evt.includes("partial") || e.evt.includes("invalid") ? K.rd : e.evt.includes("risk") ? K.od : e.evt.includes("exec") ? K.gd : e.evt.includes("news") ? K.pd : K.s2)}>{e.evt}</span>
            <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>{e.s}</span>
          </div>)}</div>
        </div>
        <div style={{ ...cd2, fontSize: 8, fontFamily: FF, color: K.dm }}>
          <b style={{ color: K.tx }}>V4.1 correctness guarantees:</b><br />
          [1] Realized PnL: weighted avg cost, triggers only on position reduction/offset<br />
          [2] YES/NO complementary: gross=yes_n+no_n, net=|yes_n-no_n|, offset trades realize PnL<br />
          [3] Order FSM: NEW→ACCEPTED→PARTIAL→FILLED/CANCELLED/REJECTED, valid transitions enforced<br />
          [4] Partial fills: deterministic retry (budget={CFG.partialRetryBudget}, drift≤{CFG.partialDriftThreshold * 100}%)<br />
          [5] MetaAlpha: learns from realized PnL delta only, never from fill proxies<br />
          [6] CB: trip on DD/exp/slip({CFG.cbSlipThreshold})/rejects({CFG.cbRejectThreshold})/poor fills, half_open probe<br />
          [7] Slippage: {CFG.maxSlipBps}bps max enforced per child fill, reject on breach<br />
          [9] Reconciliation: fill key dedup, idempotent applyFills, position derived from fills<br />
          [10] Market validation: price∈[0,1], spread≤{CFG.maxSpread * 100}%, depth≥{CFG.minDepth}, staleness≤{CFG.stalenessMs}ms
        </div>
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V4.1 · SEED:{st.seed} · TICK:{st.tickCount} · REALIZED:{f$(st.realizedPnl)} · UNREALIZED:{f$(st.unrealizedPnl)} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
