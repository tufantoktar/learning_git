import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
//  POLYMARKET V4.2 — CIRCUIT BREAKER + RISK + EXPOSURE CONSISTENCY PATCH
//
//  Patch from V4.1:
//   P1. Circuit breaker: full 3-state FSM (closed/half_open/open)
//       - All 6 trip triggers implemented and config-driven
//       - poor fills NOW actually trip CB (was tracked but never checked)
//       - invalid market data NOW feeds CB (was quarantine-only)
//       - half_open: limited probe notional, deterministic recovery
//       - all state transitions auditable via cb.triggers[]
//   P2. Exposure consistency: notional vs quantity separated
//       - preTradeRisk exposure check uses notional (was mixing qty+notional)
//       - category caps explicitly quantity-based (labeled, not mixed)
//       - gross/net exposure: notional-only, no double-count
//   P3. Risk path consistency:
//       - slippage CB uses windowed recentSlipEvents (was allFills.slice)
//       - poor fills windowed (was unbounded accumulation)
//       - invalid data count windowed and feeds CB
//   P4. Determinism: no hidden state, no mutation leaks
//
//  Preserved from V4.1:
//   [1] Realized PnL: weighted avg cost
//   [2] YES/NO complementary: net/gross exposure
//   [3] Order FSM: 7 states
//   [4] Partial fills: RETRY/REPLACE/UNWIND/CANCEL
//   [5] MetaAlpha: realized PnL only
//   [7] Slippage: maxSlipBps enforcement
//   [8] Clock: injected time
//   [9] Reconciliation: idempotent fill dedup
//   [10] Market validation: price/spread/depth/staleness
//
//  Architecture: ENGINE (pure) | UI (render-only)
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
  // Position & exposure (QUANTITY-based)
  maxPos: 1500,            // max qty per market (YES+NO combined)
  maxCatQty: 3000,         // max qty per category (explicitly quantity-based)
  // Exposure (NOTIONAL-based)
  maxExpNotional: 6000,    // max gross notional exposure
  // Drawdown
  maxDD: 0.20, softDD: 0.12,
  // Slippage & quality
  maxSlipBps: 40, minLiqRatio: 3, minSigQuality: 0.2,
  // Market validation
  maxSpread: 0.06, minDepth: 30, stalenessMs: 10000,
  // Circuit breaker — all thresholds config-driven
  cbRecoveryMs: 60000,
  cbHalfOpenMaxNotional: 200,
  cbHalfOpenProbeMinFills: 1,
  cbSlipThreshold: 5,
  cbRejectThreshold: 8,
  cbPoorFillThreshold: 6,
  cbInvalidDataThreshold: 4,
  cbExpBreachMultiplier: 1.3,
  cbSlipWindow: 20,
  cbPoorFillWindow: 20,
  cbInvalidDataWindow: 15,
  // Partial fill
  partialRetryBudget: 2, partialDriftThreshold: 0.02, partialMinQty: 20,
  // Spawn processing
  maxSpawnDepth: 3, maxSpawnsPerTick: 6,
  // Order history
  historyRetentionCap: 300, historyMinRetainTerminal: 50,
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
    orders: [], orderHistory: [],
    fills: [], fillKeys: {},
    positions: {},
    equity: CFG.initialEquity, equityCurve: [CFG.initialEquity],
    peakEquity: CFG.initialEquity,
    grossExposure: 0, netExposure: 0, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, currentDD: 0,
    // [P1] Circuit breaker: full 3-state FSM with all 6 windowed triggers
    cb: {
      state: "closed",
      failCount: 0,
      lastFailTime: 0,
      reason: null,
      triggers: [],
      recentSlipEvents: [],
      recentRejects: 0,
      recentPoorFills: [],
      recentInvalidData: [],
      halfOpenNotional: 0,
      halfOpenFills: 0,
    },
    quarantined: {},
    monitor: { approvals: 0, rejections: 0, signalCounts: { nlp: 0, momentum: 0, arb: 0 } },
    events: [],
    lastRecon: { ok: true, issues: 0, drifts: 0, orphans: 0, fills: 0, orders: 0 },
    spawnStats: { existing: 0, new: 0, deferred: 0 },
    deferredSpawns: [],
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

function validateMarket(mkt, book, time) {
  const issues = [];
  if (mkt.yes < 0 || mkt.yes > 1) issues.push("price_invalid");
  if (book.spread > CFG.maxSpread) issues.push("spread_" + (book.spread * 100).toFixed(1) + "%");
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
  return { id: "n" + time, time, source: src, headline: tpl.h, markets: tpl.m, sentiment: r4(raw), impactClass: ic, confidence: +cl((0.5 + abs * 0.4) * sw * cl(1 - lat / 10000, 0.5, 1), 0, 0.99).toFixed(3), baseImpact: tpl.imp, srcWeight: sw, latencyMs: lat };
}
function nlpSigs(nev, mkts, time) {
  if (nev.impactClass !== "binary_catalyst" || nev.confidence < 0.55) return [];
  const sigs = [];
  for (const mid of nev.markets) { const m = mkts[mid]; if (!m) continue; const e = nev.sentiment * nev.baseImpact * nev.confidence * nev.srcWeight * 0.04; if (Math.abs(e) < 0.006) continue;
    sigs.push({ id: "nlp_" + mid + "_" + time, source: "nlp", time, cid: mid, dir: e > 0 ? "BUY_YES" : "BUY_NO", edge: +Math.abs(e).toFixed(4), conf: nev.confidence, fv: r4(cl(m.yes + e, 0.02, 0.98)), px: m.yes, hl: 180000, exp: time + 720000, qs: +(nev.confidence * nev.srcWeight).toFixed(3) });
  } return sigs;
}
function momSigs(mkts, hists, time) {
  const sigs = [];
  for (const [mid, m] of Object.entries(mkts)) { const h = hists[mid]; if (!h || h.prices.length < 25) continue; const p = h.prices, px = m.yes;
    const r5 = hRoc(p, 5), s10 = hSma(p, 10), s30 = hSma(p, 30), v = hVol(p, 20);
    const tr = ((px > s10 ? 0.3 : -0.3) + (px > s30 ? 0.2 : -0.2) + cl(r5 * 10, -0.5, 0.5));
    const ext = (px - s30) / (v || 0.01), mr = ext > 2 ? -0.4 : ext < -2 ? 0.4 : 0;
    const comp = tr + mr, ac = Math.abs(comp); if (ac < 0.15) continue;
    sigs.push({ id: "mom_" + mid + "_" + time, source: "momentum", time, cid: mid, dir: comp > 0 ? "BUY_YES" : "BUY_NO", edge: +(ac * 0.05).toFixed(4), conf: +cl(0.4 + ac * 0.3, 0, 0.95).toFixed(3), fv: r4(px + comp * 0.02), px, hl: 240000, exp: time + 300000, qs: +(ac * cl(p.length / 100, 0, 1)).toFixed(3) });
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
    sigs.push({ id: "arb_" + pair.a + "_" + pair.b + "_" + time, source: "arb", time, cid: mB.id, dir: mismatch > 0 ? "BUY_NO" : "BUY_YES", edge: +ne.toFixed(4), conf: +cl(0.3 + Math.abs(z) * 0.12 * cc, 0, 0.95).toFixed(3), fv: r4(cl(expB, 0.02, 0.98)), px: mB.yes, hl: 600000, exp: time + 600000, qs: +(cc * cl(Math.abs(z) / 3, 0, 1)).toFixed(3), z: +z.toFixed(2), corr: +corr.toFixed(3), stab: +stab.toFixed(3), pair: pair.a + "\u2194" + pair.b });
  } return sigs;
}

// ══════════════════════ ENGINE: SIGNAL PROCESSING ════════════════════
function processSigs(signals, weights, regConf, time) {
  let sigs = signals.filter(s => s.exp > time && (time - s.time) / (s.exp - s.time) < 0.8);
  sigs = sigs.map(s => { const fr = Math.pow(0.5, (time - s.time) / (s.hl || 300000)); return { ...s, fr: +fr.toFixed(3), ee: +(s.edge * fr).toFixed(4) }; });
  const best = {}; for (const s of sigs) { const k = s.source + ":" + s.cid; if (!best[k] || s.ee > best[k].ee) best[k] = s; }
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
    recs.push({ id: "rec_" + mid + "_" + time, time, cid: mid, dir, ce: +ae.toFixed(4), conf, conc: +conc.toFixed(2), sz, attr, nSigs: ms.length, urg: ae > 0.025 ? "immediate" : ae > 0.012 ? "patient" : "passive", aq: +(ms.reduce((s, x) => s + (x.qs || 0.5), 0) / ms.length).toFixed(3) });
  }
  return { filtered: sigs, recs };
}

// ══════════════════════ ENGINE: RISK [P2][P3] ═══════════════════════
// [P2] Exposure model: notional-only, no double-count
function calcExposure(positions, markets) {
  let gross = 0, net = 0;
  const catNotional = {};
  const catQty = {};
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    const yN = pos.yesQty * m.yes;
    const nN = pos.noQty * (1 - m.yes);
    gross += yN + nN;
    net += Math.abs(yN - nN);
    const cat = m.cat;
    catNotional[cat] = (catNotional[cat] || 0) + yN + nN;
    catQty[cat] = (catQty[cat] || 0) + pos.yesQty + pos.noQty;
  }
  return { gross: +gross.toFixed(2), net: +net.toFixed(2), catNotional, catQty };
}

// [P2] Pre-trade risk: notional vs quantity separated
function preTradeRisk(rec, snap) {
  const { positions, markets, cb, currentDD, grossExposure } = snap;
  const ch = []; let ok = true, sz = rec.sz;

  // CB check
  if (cb.state === "open") { ch.push({ n: "CB", s: "blocked", d: cb.reason }); ok = false; }
  else if (cb.state === "half_open") {
    if (sz > CFG.cbHalfOpenMaxNotional) { sz = CFG.cbHalfOpenMaxNotional; ch.push({ n: "CB", s: "adjusted", d: "half_open probe cap " + CFG.cbHalfOpenMaxNotional }); }
    else ch.push({ n: "CB", s: "adjusted", d: "half_open probe" });
  } else ch.push({ n: "CB", s: "pass", d: "closed" });

  // [P2] Position limit: QUANTITY-based
  const pos = positions[rec.cid] || { yesQty: 0, noQty: 0 };
  const existQty = pos.yesQty + pos.noQty;
  if (existQty + sz > CFG.maxPos) { sz = Math.max(0, CFG.maxPos - existQty); ch.push({ n: "PosQty", s: sz > 0 ? "adjusted" : "blocked", d: "qty:" + existQty + "+" + sz + "/" + CFG.maxPos }); if (!sz) ok = false; }
  else ch.push({ n: "PosQty", s: "pass", d: "qty:" + (existQty + sz) + "/" + CFG.maxPos });

  // [P2] Exposure limit: NOTIONAL-based (qty * est price)
  const mkt = markets[rec.cid];
  const estPx = mkt ? (rec.dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;
  const addNotional = +(sz * estPx).toFixed(2);
  if (grossExposure + addNotional > CFG.maxExpNotional) {
    const maxAddNotional = Math.max(0, CFG.maxExpNotional - grossExposure);
    const maxQty = estPx > 0 ? Math.floor(maxAddNotional / estPx) : 0;
    sz = Math.min(sz, maxQty);
    ch.push({ n: "ExpN", s: sz > 0 ? "adjusted" : "blocked", d: "notional:" + grossExposure + "+" + (+(sz * estPx).toFixed(0)) + "/" + CFG.maxExpNotional });
    if (!sz) ok = false;
  } else ch.push({ n: "ExpN", s: "pass", d: "notional:" + grossExposure + "+" + addNotional + "/" + CFG.maxExpNotional });

  // DD
  const scale = currentDD >= CFG.maxDD ? 0 : currentDD > CFG.softDD ? 1 - Math.pow(currentDD / CFG.maxDD, 1.5) : 1;
  if (scale < 1) { sz = Math.floor(sz * scale); ch.push({ n: "DD", s: scale > 0 ? "adjusted" : "blocked", d: "s=" + scale.toFixed(2) }); if (!sz) ok = false; }
  else ch.push({ n: "DD", s: "pass", d: (currentDD * 100).toFixed(1) + "%" });

  // [P2] Category cap: explicitly QUANTITY-based
  const catQ = Object.entries(positions).reduce((s, [id, p]) => { const m2 = markets[id]; return m2 && m2.cat === mkt?.cat ? s + p.yesQty + p.noQty : s; }, 0);
  if (catQ + sz > CFG.maxCatQty) { sz = Math.max(0, CFG.maxCatQty - catQ); ch.push({ n: "CatQty", s: sz > 0 ? "adjusted" : "blocked", d: (mkt?.cat) + ":qty=" + catQ + "+" + sz + "/" + CFG.maxCatQty }); if (!sz) ok = false; }
  else ch.push({ n: "CatQty", s: "pass", d: (mkt?.cat) + ":qty=" + (catQ + sz) + "/" + CFG.maxCatQty });

  // Liq
  const lr = mkt ? mkt.adv / (sz + 0.001) : 999;
  if (lr < CFG.minLiqRatio) { ch.push({ n: "Liq", s: "blocked", d: lr.toFixed(1) }); ok = false; } else ch.push({ n: "Liq", s: "pass", d: lr.toFixed(1) });
  // Quality
  if ((rec.aq || 0) < CFG.minSigQuality) { ch.push({ n: "Qual", s: "blocked", d: "" + rec.aq }); ok = false; } else ch.push({ n: "Qual", s: "pass", d: "" + rec.aq });
  // Quarantine
  if (snap.quarantined[rec.cid]) { ch.push({ n: "MktVal", s: "blocked", d: snap.quarantined[rec.cid].join(",") }); ok = false; }
  else ch.push({ n: "MktVal", s: "pass", d: "valid" });

  return { ok: ok && sz >= 15, sz, ch };
}

// ══════════════════════ ENGINE: EXECUTION ════════════════════════════
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "REPLACED"]);
const TRANSITIONS = { NEW: new Set(["ACCEPTED", "REJECTED"]), ACCEPTED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"]), PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REPLACED"]) };
function canTransition(from, to) { return TRANSITIONS[from]?.has(to) || false; }
function makeChildId(orderId, seq, gen) { return orderId + "_c" + seq + "_g" + gen; }

function buildChildren(orderId, totalSz, limitPx, strategy, gen) {
  const maxCh = strategy === "twap" ? 100 : strategy === "aggressive" ? totalSz : 200;
  const n = Math.ceil(totalSz / maxCh);
  const children = []; let rem = totalSz;
  for (let i = 0; i < n; i++) { const sz = Math.min(rem, maxCh); children.push({ id: makeChildId(orderId, i, gen), sz, lim: limitPx, fp: null, st: "NEW" }); rem -= sz; }
  return children;
}

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
  const id = "ord_" + rec.cid + "_" + time;
  return { id, time, cid: rec.cid, side, dir: rec.dir, parentSz: verdict.sz, lim, strat, children: buildChildren(id, verdict.sz, lim, strat, 0), status: "NEW", totalFilled: 0, avgFP: null, ce: rec.ce, attr: rec.attr, riskCh: verdict.ch, urg: rec.urg, fillRate: 0, slipBps: null, partialAction: null, retryBudget: CFG.partialRetryBudget, retryGen: 0, replacedBy: null, parentOrderId: null };
}

function checkSlippage(fillPx, limitPx, midPx) {
  const slipAbs = Math.abs(fillPx - limitPx);
  const slipBps = (slipAbs / (midPx || 0.5)) * 10000;
  return { slipBps: +slipBps.toFixed(2), exceeded: slipBps > CFG.maxSlipBps };
}

function advanceOrderFills(order, rng, mkts, tickTime) {
  if (TERMINAL.has(order.status)) return { order, newFills: [], childSlipRejects: 0 };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  if (o.status === "NEW") { if (!canTransition("NEW", "ACCEPTED")) return { order: o, newFills: [], childSlipRejects: 0 }; o.status = "ACCEPTED"; }
  const mkt = mkts[o.cid];
  const mid = mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim;
  let filled = 0, cost = 0, childSlipRejects = 0;
  const newFills = [];
  for (const ch of o.children) {
    if (ch.st === "FILLED") { filled += ch.sz; cost += ch.fp * ch.sz; continue; }
    if (ch.st === "CANCELLED" || ch.st === "REJECTED") continue;
    if (ch.st === "NEW") ch.st = "ACCEPTED";
    const fr = o.strat === "aggressive" ? 0.92 : o.strat === "twap" ? 0.8 : o.strat === "vwap" ? 0.78 : 0.6;
    if (rng() < fr) {
      const rawFP = r4(ch.lim + (rng() - 0.5) * 0.004);
      const slip = checkSlippage(rawFP, ch.lim, mid);
      if (slip.exceeded) { ch.st = "REJECTED"; childSlipRejects++; continue; }
      ch.fp = rawFP; ch.st = "FILLED";
      filled += ch.sz; cost += rawFP * ch.sz;
      newFills.push({ key: "fill_" + o.id + "_" + ch.id, orderId: o.id, cid: o.cid, side: o.side, qty: ch.sz, px: rawFP, time: tickTime, slipBps: slip.slipBps });
    }
  }
  o.totalFilled = filled;
  o.avgFP = filled > 0 ? +(cost / filled).toFixed(4) : null;
  o.fillRate = +(filled / o.parentSz).toFixed(2);
  if (newFills.length) o.slipBps = +(newFills.reduce((s, f) => s + f.slipBps, 0) / newFills.length).toFixed(2);
  if (filled >= o.parentSz) { if (canTransition(o.status, "FILLED")) o.status = "FILLED"; }
  else if (filled > 0 && o.status === "ACCEPTED") { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
  if (o.status !== "FILLED" && o.status !== "CANCELLED" && o.status !== "REPLACED") {
    const pending = o.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pending.length === 0 && filled < o.parentSz && filled > 0) { if (o.status === "ACCEPTED" && canTransition("ACCEPTED", "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
    if (pending.length === 0 && filled === 0) { if (canTransition(o.status, "REJECTED")) o.status = "REJECTED"; }
  }
  return { order: o, newFills, childSlipRejects };
}

function resolvePartialFill(order, mkts, time, rng) {
  if (order.status !== "PARTIALLY_FILLED") return { order, spawned: [] };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  const mkt = mkts[o.cid]; const remaining = o.parentSz - o.totalFilled;
  const currentMid = mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim;
  const drift = Math.abs(currentMid - o.lim); const spawned = [];
  if (remaining < CFG.partialMinQty) { o.partialAction = { action: "CANCEL", reason: "remaining " + remaining + " < minQty " + CFG.partialMinQty }; for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; } if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED"; return { order: o, spawned }; }
  if (drift <= CFG.partialDriftThreshold && o.retryBudget > 0) { o.retryBudget--; o.retryGen = (o.retryGen || 0) + 1; o.partialAction = { action: "RETRY", reason: "gen=" + o.retryGen + ", budget=" + o.retryBudget + ", drift=" + (drift * 100).toFixed(1) + "%" }; for (const ch of o.children) { if (ch.st === "ACCEPTED" || ch.st === "REJECTED") ch.st = "CANCELLED"; } o.children = [...o.children, ...buildChildren(o.id, remaining, o.lim, o.strat, o.retryGen)]; return { order: o, spawned }; }
  if (drift > CFG.partialDriftThreshold && drift <= CFG.partialDriftThreshold * 3 && o.retryBudget > 0) {
    o.partialAction = { action: "REPLACE", reason: "drift=" + (drift * 100).toFixed(1) + "%, new limit at current mid" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "REPLACED")) { o.status = "REPLACED"; const newLim = r4(cl(currentMid, 0.01, 0.99)); const replId = "ord_repl_" + o.id + "_" + time;
      spawned.push({ id: replId, time, cid: o.cid, side: o.side, dir: o.dir, parentSz: remaining, lim: newLim, strat: o.strat, children: buildChildren(replId, remaining, newLim, o.strat, 0), status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr, riskCh: o.riskCh, urg: o.urg, fillRate: 0, slipBps: null, partialAction: null, retryBudget: Math.max(0, o.retryBudget - 1), retryGen: 0, replacedBy: null, parentOrderId: o.id }); o.replacedBy = replId; }
    return { order: o, spawned };
  }
  if (drift > CFG.partialDriftThreshold || o.retryBudget <= 0) {
    o.partialAction = { action: "UNWIND", reason: "drift=" + (drift * 100).toFixed(1) + "%, closing filled qty " + o.totalFilled };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    if (o.totalFilled > 0) { const uwDir = o.dir === "BUY_YES" ? "BUY_NO" : "BUY_YES"; const uwSide = uwDir === "BUY_YES" ? "YES" : "NO"; const uwLim = r4(cl(currentMid, 0.01, 0.99)); const uwId = "ord_unwind_" + o.id + "_" + time;
      spawned.push({ id: uwId, time, cid: o.cid, side: uwSide, dir: uwDir, parentSz: o.totalFilled, lim: uwLim, strat: "aggressive", children: buildChildren(uwId, o.totalFilled, uwLim, "aggressive", 0), status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr, riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null, retryBudget: 0, retryGen: 0, replacedBy: null, parentOrderId: o.id }); }
    return { order: o, spawned };
  }
  o.partialAction = { action: "CANCEL", reason: "fallback" }; for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; } if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED"; return { order: o, spawned };
}

// ══════════════════════ ENGINE: PORTFOLIO [1][2] ═════════════════════
function applyFills(positions, fills, fillKeys, newFills) {
  let pos = { ...positions }; let fs = [...fills]; let fk = { ...fillKeys };
  for (const f of newFills) {
    if (fk[f.key]) continue; fk[f.key] = true; fs.push(f);
    const mid = f.cid;
    const p = pos[mid] ? { ...pos[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      if (p.noQty > 0) { const oq = Math.min(f.qty, p.noQty); const ep = 1 - f.px; p.realizedPnl = +(p.realizedPnl + oq * (ep - p.noAvgPx)).toFixed(4); p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; } }
      else { const t = p.yesQty + f.qty; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0; p.yesQty = t; }
    } else {
      if (p.yesQty > 0) { const oq = Math.min(f.qty, p.yesQty); const ep = 1 - f.px; p.realizedPnl = +(p.realizedPnl + oq * (ep - p.yesAvgPx)).toFixed(4); p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; } }
      else { const t = p.noQty + f.qty; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / t) : 0; p.noQty = t; }
    }
    pos = { ...pos, [mid]: p };
  }
  return { positions: pos, fills: fs, fillKeys: fk };
}

function computeMetrics(positions, markets, eqCurve, peakEq) {
  let rPnl = 0, uPnl = 0;
  const exp = calcExposure(positions, markets);
  for (const [mid, pos] of Object.entries(positions)) { const m = markets[mid]; if (!m) continue; rPnl += pos.realizedPnl; uPnl += pos.yesQty * (m.yes - pos.yesAvgPx) + pos.noQty * ((1 - m.yes) - pos.noAvgPx); }
  const totalPnl = +(rPnl + uPnl).toFixed(2);
  const equity = +(CFG.initialEquity + totalPnl).toFixed(2);
  const pk = Math.max(peakEq, equity);
  const dd = pk > 0 ? +((pk - equity) / pk).toFixed(4) : 0;
  const curve = [...eqCurve, equity]; if (curve.length > 200) curve.splice(0, curve.length - 200);
  return { realizedPnl: +rPnl.toFixed(2), unrealizedPnl: +uPnl.toFixed(2), totalPnl, equity, peakEquity: pk, currentDD: dd, equityCurve: curve, grossExposure: exp.gross, netExposure: exp.net, catExposure: exp.catNotional };
}

// ══════════════════════ ENGINE: RECONCILIATION ══════════════════════
function rebuildPositionsFromFills(fills) {
  const pos = {};
  for (const f of fills) {
    const mid = f.cid; const p = pos[mid] || { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      if (p.noQty > 0) { const oq = Math.min(f.qty, p.noQty); p.realizedPnl = +(p.realizedPnl + oq * ((1 - f.px) - p.noAvgPx)).toFixed(4); p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; } }
      else { const t = p.yesQty + f.qty; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0; p.yesQty = t; }
    } else {
      if (p.yesQty > 0) { const oq = Math.min(f.qty, p.yesQty); p.realizedPnl = +(p.realizedPnl + oq * ((1 - f.px) - p.yesAvgPx)).toFixed(4); p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; } }
      else { const t = p.noQty + f.qty; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / t) : 0; p.noQty = t; }
    }
    pos[mid] = p;
  }
  return pos;
}

function reconcile(livePositions, fills, fillKeys, orders, orderHistory) {
  const issues = []; const rebuilt = rebuildPositionsFromFills(fills);
  const allMids = new Set([...Object.keys(livePositions), ...Object.keys(rebuilt)]);
  let positionsDrifted = false;
  for (const mid of allMids) { const live = livePositions[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 }; const rb = rebuilt[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 }; if (Math.abs(live.yesQty - rb.yesQty) > 0.01 || Math.abs(live.noQty - rb.noQty) > 0.01 || Math.abs(live.realizedPnl - rb.realizedPnl) > 0.01) { issues.push({ type: "position_drift", market: mid }); positionsDrifted = true; } }
  const seenKeys = {}; for (const f of fills) { if (seenKeys[f.key]) issues.push({ type: "duplicate_fill_in_ledger", key: f.key }); seenKeys[f.key] = true; }
  const allOrders = [...orders, ...orderHistory]; const fillsByOrder = {}; for (const f of fills) { (fillsByOrder[f.orderId] || (fillsByOrder[f.orderId] = [])).push(f); }
  for (const ord of allOrders) { const of2 = fillsByOrder[ord.id] || []; const fqs = of2.reduce((s, f) => s + f.qty, 0); if (ord.status === "FILLED" && Math.abs(fqs - ord.parentSz) > 0.01) issues.push({ type: "filled_qty_mismatch", orderId: ord.id }); if (ord.status === "PARTIALLY_FILLED" && (fqs <= 0 || fqs >= ord.parentSz)) issues.push({ type: "partial_qty_inconsistent", orderId: ord.id }); if (Math.abs((ord.totalFilled || 0) - fqs) > 0.01) issues.push({ type: "order_fill_total_mismatch", orderId: ord.id }); for (const f of of2) { if (f.cid !== ord.cid) issues.push({ type: "fill_cid_mismatch", fillKey: f.key }); } }
  const orderIds = new Set(allOrders.map(o => o.id)); for (const f of fills) { if (!orderIds.has(f.orderId)) issues.push({ type: "orphan_fill", fillKey: f.key, orderId: f.orderId }); }
  for (const o of orders) { if (TERMINAL.has(o.status)) issues.push({ type: "terminal_in_active", orderId: o.id }); }
  for (const o of allOrders) { if (o.status === "REPLACED" && o.replacedBy) { const rpl = allOrders.find(r => r.id === o.replacedBy); if (!rpl) issues.push({ type: "replacement_missing", orderId: o.id }); else if (rpl.parentOrderId !== o.id) issues.push({ type: "replacement_lineage_mismatch", orderId: o.id }); } if (o.parentOrderId && o.id.includes("unwind")) { if (!allOrders.find(p => p.id === o.parentOrderId)) issues.push({ type: "unwind_parent_missing", orderId: o.id }); } }
  const ledgerKeys = new Set(fills.map(f => f.key)); for (const k of Object.keys(fillKeys)) { if (!ledgerKeys.has(k)) issues.push({ type: "stale_fill_key", key: k }); } for (const k of ledgerKeys) { if (!fillKeys[k]) issues.push({ type: "missing_fill_key", key: k }); }
  const correctedPositions = positionsDrifted ? rebuilt : livePositions;
  const correctedFillKeys = {}; for (const f of fills) correctedFillKeys[f.key] = true;
  return { ok: issues.length === 0, issues, correctedPositions, correctedFillKeys, rebuiltPositions: rebuilt, fillCount: fills.length, orderCount: allOrders.length, orphanFills: issues.filter(i => i.type === "orphan_fill").length, driftCount: issues.filter(i => i.type === "position_drift").length };
}

// ══════════════════════ ENGINE: CIRCUIT BREAKER [P1] ═════════════════
// Full 3-state FSM: closed -> open -> half_open -> closed
// TRIP TRIGGERS (all config-driven):
//   1. drawdown_breach  2. exposure_breach  3. excessive_slippage
//   4. repeated_rejects  5. poor_fills  6. invalid_market_data
function tripCB(cb, reason, time) {
  const from = cb.state;
  cb.state = "open"; cb.reason = reason; cb.lastFailTime = time;
  cb.failCount = (cb.failCount || 0) + 1;
  cb.triggers.push({ t: time, r: reason, from, to: "open" });
  cb.halfOpenNotional = 0; cb.halfOpenFills = 0;
}

function updateCB(cb, metrics, time) {
  const next = { ...cb, triggers: [...cb.triggers], recentSlipEvents: [...(cb.recentSlipEvents||[])], recentPoorFills: [...(cb.recentPoorFills||[])], recentInvalidData: [...(cb.recentInvalidData||[])] };
  // Recovery: open -> half_open
  if (next.state === "open" && time - next.lastFailTime > CFG.cbRecoveryMs) { next.triggers.push({ t: time, r: "recovery_timer", from: "open", to: "half_open" }); next.state = "half_open"; next.halfOpenNotional = 0; next.halfOpenFills = 0; }
  // Recovery: half_open -> closed (deterministic probe success)
  if (next.state === "half_open" && next.halfOpenFills >= CFG.cbHalfOpenProbeMinFills && next.recentRejects === 0) { next.triggers.push({ t: time, r: "probe_success: fills=" + next.halfOpenFills + " rejects=0", from: "half_open", to: "closed" }); next.state = "closed"; next.failCount = 0; next.reason = null; next.halfOpenNotional = 0; next.halfOpenFills = 0; }
  // Trip 1: drawdown
  if (next.state !== "open" && metrics.currentDD > CFG.maxDD) tripCB(next, "drawdown_breach: " + (metrics.currentDD * 100).toFixed(1) + "%", time);
  // Trip 2: exposure (notional)
  if (next.state !== "open" && metrics.grossExposure > CFG.maxExpNotional * CFG.cbExpBreachMultiplier) tripCB(next, "exposure_breach: " + metrics.grossExposure.toFixed(0), time);
  // Trip 3: excessive slippage (windowed)
  const highSlip = next.recentSlipEvents.filter(e => e.slipBps > CFG.maxSlipBps * 0.8).length;
  if (next.state !== "open" && highSlip >= CFG.cbSlipThreshold) { tripCB(next, "excessive_slippage: " + highSlip + " events", time); next.recentSlipEvents = []; }
  // Trip 4: repeated rejects
  if (next.state !== "open" && next.recentRejects >= CFG.cbRejectThreshold) { tripCB(next, "repeated_rejects: " + next.recentRejects, time); next.recentRejects = 0; }
  // Trip 5: poor fills (windowed) — FIX: was tracked but never tripped
  if (next.state !== "open" && next.recentPoorFills.length >= CFG.cbPoorFillThreshold) { tripCB(next, "poor_fills: " + next.recentPoorFills.length, time); next.recentPoorFills = []; }
  // Trip 6: invalid market data (windowed) — FIX: was quarantine-only
  if (next.state !== "open" && next.recentInvalidData.length >= CFG.cbInvalidDataThreshold) { tripCB(next, "invalid_market_data: " + next.recentInvalidData.length, time); next.recentInvalidData = []; }
  if (next.triggers.length > 30) next.triggers = next.triggers.slice(-25);
  return next;
}

// ══════════════════════ ENGINE: PRUNING ══════════════════════════════
function collectProtectedIds(activeOrders, historyOrders) {
  const p = new Set(); const all = [...activeOrders, ...historyOrders];
  for (const o of all) { if (o.parentOrderId) p.add(o.parentOrderId); if (o.replacedBy) { p.add(o.id); p.add(o.replacedBy); } if (!TERMINAL.has(o.status)) p.add(o.id); }
  let changed = true; while (changed) { changed = false; for (const o of all) { if (p.has(o.id) && o.parentOrderId && !p.has(o.parentOrderId)) { p.add(o.parentOrderId); changed = true; } } }
  return p;
}
function pruneOrderHistory(orderHistory, activeOrders) {
  if (orderHistory.length <= CFG.historyRetentionCap) return orderHistory;
  const p = collectProtectedIds(activeOrders, orderHistory);
  const keep = [], pruneable = [];
  for (const o of orderHistory) { if (p.has(o.id)) keep.push(o); else pruneable.push(o); }
  return [...keep, ...pruneable.slice(-Math.max(0, CFG.historyRetentionCap - keep.length))];
}

// ══════════════════════ ENGINE: CB EVENT TRACKING ════════════════════
function recordReject(cb, type, orderId, events, time) { cb.recentRejects = (cb.recentRejects || 0) + 1; events.push({ evt: "cb:" + type, ts: time, s: orderId || "" }); }
function recordApproval(cb) { cb.recentRejects = Math.max(0, (cb.recentRejects || 0) - 1); }
function recordSlipEvent(cb, slipBps, time) { cb.recentSlipEvents.push({ time, slipBps }); if (cb.recentSlipEvents.length > CFG.cbSlipWindow) cb.recentSlipEvents = cb.recentSlipEvents.slice(-CFG.cbSlipWindow); }
function recordPoorFill(cb, time) { cb.recentPoorFills.push({ time }); if (cb.recentPoorFills.length > CFG.cbPoorFillWindow) cb.recentPoorFills = cb.recentPoorFills.slice(-CFG.cbPoorFillWindow); }
function recordInvalidData(cb, marketId, time) { cb.recentInvalidData.push({ time, marketId }); if (cb.recentInvalidData.length > CFG.cbInvalidDataWindow) cb.recentInvalidData = cb.recentInvalidData.slice(-CFG.cbInvalidDataWindow); }

// ══════════════════════ ENGINE: TICK ═════════════════════════════════
function tick(prev, tickTime) {
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };
  // 2. Markets
  const newMkts = {}; for (const [id, m] of Object.entries(s.markets)) newMkts[id] = advMkt(m, rng, time); s.markets = newMkts;
  // 3. Histories
  const newH = {}; for (const [id, m] of Object.entries(s.markets)) { const bk = buildBook(m.yes, m.adv, rng); newH[id] = pushHist(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, m.yes, bk.spread, bk.bidDepth); } s.histories = newH;
  // 4. Validate markets + feed invalid data to CB
  const quarantined = {};
  let cb = { ...s.cb, triggers: [...s.cb.triggers], recentSlipEvents: [...(s.cb.recentSlipEvents||[])], recentPoorFills: [...(s.cb.recentPoorFills||[])], recentInvalidData: [...(s.cb.recentInvalidData||[])] };
  for (const [id, m] of Object.entries(s.markets)) { const bk = buildBook(m.yes, m.adv, rng); const v = validateMarket(m, bk, time); if (!v.valid) { quarantined[id] = v.issues; s.events.push({ evt: "mkt:invalid", ts: time, s: id + ":" + v.issues.join(",") }); recordInvalidData(cb, id, time); } }
  s.quarantined = quarantined;
  // 5. Regime
  const mH = s.histories["btc150k"] || Object.values(s.histories)[0]; if (mH && mH.prices.length > 30) s.regime = detectRegime(mH.prices, mH.spreads, mH.depths);
  // 6. Alpha weights
  s.alphaWeights = computeWeights(s.regime, s.metaPerf, s.newsIntensity);
  // 7. Signals
  let sigs = [...s.signals];
  if (rng() < 0.3) { const nev = genNews(s.markets, rng, time); s.newsLog = [nev, ...s.newsLog].slice(0, 60); s.newsIntensity = nev.impactClass === "binary_catalyst" ? 0.9 : nev.impactClass === "gradual_shift" ? 0.5 : 0.1; const ns = nlpSigs(nev, s.markets, time); sigs.push(...ns); s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, nlp: s.monitor.signalCounts.nlp + ns.length } }; s.events.push({ evt: "news", ts: time, s: nev.impactClass + "|" + nev.headline.slice(0, 25) }); }
  const ms2 = momSigs(s.markets, s.histories, time); sigs = sigs.filter(x => x.source !== "momentum"); sigs.push(...ms2); s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, momentum: s.monitor.signalCounts.momentum + ms2.length } };
  if (rng() < 0.35) { const as2 = arbSigs(s.markets, s.histories, time); sigs = sigs.filter(x => x.source !== "arb"); sigs.push(...as2); s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, arb: s.monitor.signalCounts.arb + as2.length } }; }
  // 8. Process
  const { filtered, recs } = processSigs(sigs, s.alphaWeights, s.regime.confidence, time); s.signals = filtered.slice(0, 80); s.recommendations = [...recs, ...s.recommendations].slice(0, 40);
  // 9-11. Orders
  let positions = {}; for (const [k, v] of Object.entries(s.positions)) positions[k] = { ...v };
  let fills = [...s.fills], fillKeys = { ...s.fillKeys };
  let orders = s.orders.map(o => ({ ...o, children: o.children.map(c => ({ ...c })) }));
  let orderHistory = [...s.orderHistory]; let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let allNewFills = [];

  function processOrder(ord) {
    const { order: advanced, newFills: nf, childSlipRejects } = advanceOrderFills(ord, rng, s.markets, time);
    allNewFills.push(...nf);
    if (childSlipRejects > 0) { for (let i = 0; i < childSlipRejects; i++) recordSlipEvent(cb, CFG.maxSlipBps + 1, time); }
    if (advanced.slipBps != null) recordSlipEvent(cb, advanced.slipBps, time);
    if (advanced.status === "REJECTED") recordReject(cb, "order_reject", advanced.id, s.events, time);
    if (advanced.fillRate < 0.3 && advanced.parentSz > 50) recordPoorFill(cb, time);
    if (cb.state === "half_open" && advanced.totalFilled > 0) { cb.halfOpenNotional += advanced.totalFilled; cb.halfOpenFills = (cb.halfOpenFills || 0) + 1; }
    const { order: resolved, spawned } = resolvePartialFill(advanced, s.markets, time, rng);
    if (resolved.partialAction) s.events.push({ evt: "partial:" + resolved.partialAction.action.toLowerCase(), ts: time, s: resolved.cid + "|" + resolved.partialAction.reason });
    return { resolved, spawned };
  }

  function drainSpawnQueue(initialOrders) {
    const active = [], terminal = [], spawnQueue = []; let totalSpawns = 0; const deferred = [];
    for (const o of initialOrders) { if (TERMINAL.has(o.status)) { terminal.push(o); continue; } const { resolved, spawned } = processOrder(o); if (TERMINAL.has(resolved.status)) terminal.push(resolved); else active.push(resolved); for (const sp of spawned) spawnQueue.push({ order: sp, depth: 1 }); if (resolved.totalFilled > 0) s.events.push({ evt: "exec:advance", ts: time, s: resolved.cid + "|" + resolved.status + "|f=" + resolved.totalFilled }); }
    while (spawnQueue.length > 0) { const { order: spOrd, depth } = spawnQueue.shift(); if (depth > CFG.maxSpawnDepth || totalSpawns >= CFG.maxSpawnsPerTick) { deferred.push(spOrd); s.events.push({ evt: "spawn:deferred", ts: time, s: spOrd.id + "|d=" + depth }); continue; } totalSpawns++; const { resolved: spRes, spawned: spSp } = processOrder(spOrd); if (TERMINAL.has(spRes.status)) terminal.push(spRes); else active.push(spRes); s.events.push({ evt: "exec:spawned", ts: time, s: spRes.id + "|" + spRes.status }); for (const ss of spSp) spawnQueue.push({ order: ss, depth: depth + 1 }); }
    return { active, terminal, deferred, totalSpawns };
  }

  const prevDeferred = s.deferredSpawns || []; let deferredSpawns = [];
  if (prevDeferred.length > 0) { s.events.push({ evt: "spawn:deferred_resume", ts: time, s: "count=" + prevDeferred.length }); const defResult = drainSpawnQueue(prevDeferred); orders.push(...defResult.active); orderHistory.push(...defResult.terminal); deferredSpawns.push(...defResult.deferred); }
  const existingResult = drainSpawnQueue(orders); orders = existingResult.active; orderHistory.push(...existingResult.terminal); deferredSpawns.push(...existingResult.deferred);
  // New recs
  const snap = { positions, markets: s.markets, cb, currentDD: s.currentDD, grossExposure: calcExposure(positions, s.markets).gross, quarantined };
  const newOrdersFromRecs = [];
  for (const rec of recs) { const liveExp = calcExposure(positions, s.markets); const expSnap = { ...snap, grossExposure: liveExp.gross }; const verdict = preTradeRisk(rec, expSnap); if (verdict.ok) { monitor.approvals++; recordApproval(cb); } else { monitor.rejections++; recordReject(cb, "risk_reject", rec.cid, s.events, time); } s.events.push({ evt: verdict.ok ? "risk:pass" : "risk:reject", ts: time, s: rec.cid + "|sz=" + verdict.sz }); const ord = createOrder(rec, verdict, s.markets, time, rng); if (ord) newOrdersFromRecs.push(ord); }
  const newResult = drainSpawnQueue(newOrdersFromRecs); orders.push(...newResult.active); orderHistory.push(...newResult.terminal); deferredSpawns.push(...newResult.deferred);
  for (const o of newResult.active.concat(newResult.terminal)) s.events.push({ evt: "exec:new", ts: time, s: o.cid + "|" + o.strat + "|" + o.status });
  const seenDef = new Set(); deferredSpawns = deferredSpawns.filter(d => { if (seenDef.has(d.id)) return false; seenDef.add(d.id); return true; });
  // 11. Fills
  const fResult = applyFills(positions, fills, fillKeys, allNewFills); positions = fResult.positions; fills = fResult.fills; fillKeys = fResult.fillKeys;
  // MetaAlpha
  for (const [mid, pos] of Object.entries(positions)) { const prevPos = s.positions[mid]; if (!prevPos) continue; const rpnlDelta = pos.realizedPnl - prevPos.realizedPnl; if (Math.abs(rpnlDelta) > 0.001) { const recentOrd = [...orderHistory, ...orders].filter(o => o.cid === mid && o.attr).pop(); if (recentOrd?.attr) { for (const [src, pct] of Object.entries(recentOrd.attr)) { const buf = metaPerf[src]; if (buf) { buf.push(rpnlDelta * pct / 100); if (buf.length > 50) buf.shift(); } } } } }
  // 12. Recon
  const reconResult = reconcile(positions, fills, fillKeys, orders, orderHistory);
  if (!reconResult.ok) { positions = reconResult.correctedPositions; fillKeys = reconResult.correctedFillKeys; for (const issue of reconResult.issues) s.events.push({ evt: "recon:issue", ts: time, s: issue.type + "|" + (issue.orderId || issue.key || issue.market || "") }); const fixedOrders = []; for (const o of orders) { if (TERMINAL.has(o.status)) { orderHistory.push(o); s.events.push({ evt: "recon:fix", ts: time, s: "terminal_moved|" + o.id }); } else fixedOrders.push(o); } orders = fixedOrders; }
  s.events.push({ evt: "recon:done", ts: time, s: "ok=" + reconResult.ok + "|issues=" + reconResult.issues.length });
  // 13. Metrics
  const metrics = computeMetrics(positions, s.markets, s.equityCurve, s.peakEquity);
  // 14. CB
  cb = updateCB(cb, metrics, time);
  orderHistory = pruneOrderHistory(orderHistory, orders);
  return { ...s, positions, fills, fillKeys, orders, orderHistory, deferredSpawns, equity: metrics.equity, equityCurve: metrics.equityCurve, peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure, netExposure: metrics.netExposure, totalPnl: metrics.totalPnl, realizedPnl: metrics.realizedPnl, unrealizedPnl: metrics.unrealizedPnl, currentDD: metrics.currentDD, cb, monitor, metaPerf, lastRecon: { ok: reconResult.ok, issues: reconResult.issues.length, drifts: reconResult.driftCount, orphans: reconResult.orphanFills, fills: reconResult.fillCount, orders: reconResult.orderCount }, spawnStats: { existing: existingResult.totalSpawns, new: newResult.totalSpawns, deferred: deferredSpawns.length } };
}

// ═══════════════════════════════════════════════════════════════════════
//  UI LAYER — RENDERING ONLY
// ═══════════════════════════════════════════════════════════════════════
const FF = "'JetBrains Mono','Fira Code',monospace", SS = "'DM Sans',sans-serif";
const K = { bg: "#060610", s1: "#0c0c18", s2: "#131322", bd: "#24243a", tx: "#e2e2f0", dm: "#5a5a7c", g: "#00e89a", gd: "#00e89a20", r: "#ff3355", rd: "#ff335520", y: "#ffb830", yd: "#ffb83020", b: "#2d8cf0", b2: "#2d8cf020", p: "#9966ff", pd: "#9966ff20", c: "#00ccee", cd: "#00ccee20", o: "#ff8844", od: "#ff884420" };
const bx = (c, bg) => ({ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: FF, color: c, background: bg, fontWeight: 600 });
const cd2 = { background: K.s1, border: "1px solid " + K.bd, borderRadius: 8, padding: 12, marginBottom: 8 };
const mc2 = { background: K.s2, borderRadius: 6, padding: "7px 10px" };
const ft = t => new Date(t).toLocaleTimeString("en", { hour12: false });
const fp = (v, d = 1) => (v * 100).toFixed(d) + "%";
const f$ = (v, d = 0) => "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: d });
const mq = id => MDEFS.find(m => m.id === id)?.q || id;
function Sp({ data, color = K.g, w = 120, h = 24 }) { if (!data || data.length < 2) return null; const mn = Math.min(...data), mx = Math.max(...data), rn = mx - mn || 1; return <svg width={w} height={h} style={{ display: "block" }}><polyline points={data.map((v, i) => ((i / (data.length - 1)) * w) + "," + (h - ((v - mn) / rn) * h)).join(" ")} fill="none" stroke={color} strokeWidth={1.5} /></svg>; }
function St({ l, v, c = K.tx, s }) { return <div style={mc2}><div style={{ fontSize: 9, color: K.dm, fontFamily: FF }}>{l}</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: FF, color: c, marginTop: 2 }}>{v}</div>{s && <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginTop: 1 }}>{s}</div>}</div>; }
function RB({ s }) { const m = { pass: { c: K.g, b: K.gd }, adjusted: { c: K.y, b: K.yd }, blocked: { c: K.r, b: K.rd } }; const x = m[s] || m.pass; return <span style={bx(x.c, x.b)}>{(s || "").toUpperCase()}</span>; }
const TABS = ["Dashboard", "Regime", "Alpha", "Execution", "Risk", "System"];

export default function V42() {
  const [state, setState] = useState(() => initState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const intRef = useRef(null);
  useEffect(() => { if (running) { intRef.current = setInterval(() => setState(p => tick(p, Date.now())), 2000); return () => clearInterval(intRef.current); } else clearInterval(intRef.current); }, [running]);
  const st = state, mA = Object.values(st.markets), allOrds = [...st.orders, ...st.orderHistory.slice(-20)].sort((a, b) => b.time - a.time);
  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg," + K.g + "," + K.c + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: K.bg, fontFamily: FF }}>4.2</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V4.2</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>CB FSM(3) · NOTIONAL EXPOSURE · POOR FILL+INVALID DATA TRIGGERS · WINDOWED EVENTS</div></div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={bx(st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm, st.regime.trend === "trending" ? K.gd : st.regime.trend === "mean_reverting" ? K.pd : K.s2)}>{st.regime.trend}</span>
          <span style={bx(st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r, st.cb.state === "closed" ? K.gd : st.cb.state === "half_open" ? K.yd : K.rd)}>CB:{st.cb.state}</span>
          <span style={bx(running ? K.g : K.r, running ? K.gd : K.rd)}>{running ? "\u25cf LIVE" : "\u25cb OFF"}</span>
          <button onClick={() => { setRunning(r => !r); if (st.cb.state === "open") setState(p => ({ ...p, cb: { ...p.cb, state: "closed", failCount: 0, reason: null, recentRejects: 0, recentSlipEvents: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 } })); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: running ? K.r : K.g, color: K.bg, fontFamily: FF, fontSize: 10, fontWeight: 700 }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 1, borderBottom: "1px solid " + K.bd, marginBottom: 10, overflowX: "auto" }}>{TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 10px", background: tab === t ? K.s2 : "transparent", color: tab === t ? K.g : K.dm, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", borderBottom: tab === t ? "2px solid " + K.g : "2px solid transparent" }}>{t}</button>)}</div>

      {/* DASHBOARD */}
      {tab === "Dashboard" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Equity" v={f$(st.equity)} c={st.equity >= CFG.initialEquity ? K.g : K.r} />
          <St l="Realized" v={(st.realizedPnl >= 0 ? "+" : "") + f$(st.realizedPnl)} c={st.realizedPnl >= 0 ? K.g : K.r} />
          <St l="Unrealized" v={(st.unrealizedPnl >= 0 ? "+" : "") + f$(st.unrealizedPnl)} c={st.unrealizedPnl >= 0 ? K.g : K.r} />
          <St l="Gross exp" v={f$(st.grossExposure)} c={st.grossExposure > 4000 ? K.y : K.tx} s="notional" />
          <St l="Net exp" v={f$(st.netExposure)} c={K.b} s="notional" />
          <St l="Drawdown" v={fp(st.currentDD)} c={st.currentDD > 0.1 ? K.r : st.currentDD > 0.05 ? K.y : K.g} />
          <St l="Tick" v={st.tickCount} c={K.b} s={"seed:" + st.seed} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EQUITY (deterministic)</div><Sp data={st.equityCurve} w={640} h={50} color={st.equity >= CFG.initialEquity ? K.g : K.r} /></div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 5 }}>MARKETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {mA.map(m => { const ch = m.yes - m.prevYes; const q = st.quarantined[m.id]; return <div key={m.id} style={{ ...mc2, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: q ? 0.5 : 1 }}>
              <div style={{ fontSize: 10, maxWidth: "50%" }}>{m.q}{q && <span style={{ ...bx(K.r, K.rd), marginLeft: 4 }}>Q</span>}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: FF, fontSize: 8, color: ch > 0 ? K.g : ch < 0 ? K.r : K.dm }}>{ch > 0 ? "+" : ""}{(ch * 100).toFixed(2)}{"\u00A2"}</span>
                <span style={{ fontFamily: FF, fontSize: 12, fontWeight: 700, color: m.yes > 0.5 ? K.g : K.b }}>{(m.yes * 100).toFixed(1)}{"\u00A2"}</span>
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
            <div style={{ height: 5, background: K.s2, borderRadius: 3, overflow: "hidden" }}><div style={{ width: v * 100 + "%", height: "100%", background: k === "nlp" ? K.c : k === "momentum" ? K.p : K.b, borderRadius: 3 }} /></div>
          </div>)}
        </div>
      </div>}

      {/* ALPHA */}
      {tab === "Alpha" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>NEWS</div>
          <div style={{ maxHeight: 150, overflowY: "auto" }}>{st.newsLog.slice(0, 12).map(n => <div key={n.id} style={{ display: "flex", gap: 4, padding: "3px 0", borderBottom: "1px solid " + K.bd + "10", fontSize: 9, alignItems: "center" }}>
            <span style={{ fontFamily: FF, fontSize: 8, color: K.dm, minWidth: 40 }}>{ft(n.time)}</span>
            <span style={bx(K.tx, K.s2)}>{n.source}</span>
            <span style={{ flex: 1 }}>{n.headline}</span>
            <span style={bx(n.impactClass === "binary_catalyst" ? K.r : n.impactClass === "gradual_shift" ? K.y : K.dm, n.impactClass === "binary_catalyst" ? K.rd : n.impactClass === "gradual_shift" ? K.yd : K.s2)}>{n.impactClass === "binary_catalyst" ? "CAT" : n.impactClass === "gradual_shift" ? "SHIFT" : "NOISE"}</span>
          </div>)}</div>
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>SIGNALS</div>
          <div style={{ maxHeight: 160, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: FF }}><thead><tr style={{ color: K.dm, textAlign: "left", borderBottom: "1px solid " + K.bd }}><th style={{ padding: "3px" }}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FRESH</th></tr></thead>
              <tbody>{st.signals.slice(0, 12).map(s2 => <tr key={s2.id}><td style={{ padding: "3px" }}><span style={bx(s2.source === "nlp" ? K.c : s2.source === "momentum" ? K.p : K.b, s2.source === "nlp" ? K.cd : s2.source === "momentum" ? K.pd : K.b2)}>{s2.source}</span></td>
                <td style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(s2.cid)}</td>
                <td><span style={bx(s2.dir === "BUY_YES" ? K.g : K.r, s2.dir === "BUY_YES" ? K.gd : K.rd)}>{s2.dir === "BUY_YES" ? "Y" : "N"}</span></td>
                <td style={{ color: K.y }}>{s2.ee ? fp(s2.ee, 2) : fp(s2.edge, 2)}</td>
                <td style={{ color: (s2.fr || 1) > 0.5 ? K.g : K.r }}>{s2.fr ? fp(s2.fr, 0) : "\u2014"}</td>
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
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDERS — FSM: NEW{"\u2192"}ACCEPTED{"\u2192"}PARTIAL{"\u2192"}FILLED|CANCELLED|REJECTED</div>
        {allOrds.length === 0 && <div style={{ color: K.dm, fontSize: 10 }}>No orders...</div>}
        <div style={{ maxHeight: 420, overflowY: "auto" }}>{allOrds.slice(0, 15).map(e => <div key={e.id} style={{ ...mc2, marginBottom: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 600, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(e.cid)}</span>
            <div style={{ display: "flex", gap: 2 }}>
              <span style={bx(e.side === "YES" ? K.g : K.r, e.side === "YES" ? K.gd : K.rd)}>{e.side}</span>
              <span style={bx(e.status === "FILLED" ? K.g : e.status === "PARTIALLY_FILLED" ? K.y : e.status === "CANCELLED" || e.status === "REJECTED" ? K.r : e.status === "REPLACED" ? K.o : K.b, e.status === "FILLED" ? K.gd : e.status === "PARTIALLY_FILLED" ? K.yd : e.status === "CANCELLED" || e.status === "REJECTED" ? K.rd : e.status === "REPLACED" ? K.od : K.b2)}>{e.status}</span>
              <span style={bx(K.p, K.pd)}>{e.strat}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 5, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
            <span>Sz:{f$(e.parentSz)}</span><span>Fill:<b style={{ color: K.g }}>{f$(e.totalFilled)}</b>({fp(e.fillRate, 0)})</span>
            {e.slipBps != null && <span>Slip:<b style={{ color: e.slipBps > CFG.maxSlipBps ? K.r : K.g }}>{e.slipBps}bps</b></span>}
            {e.retryBudget != null && <span>Retry:{e.retryBudget}</span>}
          </div>
          <div style={{ display: "flex", gap: 1.5, marginTop: 2 }}>{e.children.map(ch => <div key={ch.id} style={{ width: Math.max(12, ch.sz / 5), height: 5, borderRadius: 2, background: ch.st === "FILLED" ? K.g : ch.st === "REJECTED" ? K.r : ch.st === "CANCELLED" ? K.o : K.bd, opacity: 0.7 }} />)}</div>
          {e.parentOrderId && <div style={{ fontSize: 7, fontFamily: FF, color: K.dm, marginTop: 1 }}>parent: {e.parentOrderId}</div>}
          {e.replacedBy && <div style={{ fontSize: 7, fontFamily: FF, color: K.o, marginTop: 1 }}>replaced by: {e.replacedBy}</div>}
          {e.partialAction && <div style={{ marginTop: 2, padding: "2px 4px", borderRadius: 3, background: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.rd : K.yd, fontSize: 8, fontFamily: FF }}>
            <span style={{ color: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.r : K.y, fontWeight: 600 }}>{e.partialAction.action}</span>
            <span style={{ color: K.dm }}> {e.partialAction.reason}</span>
          </div>}
        </div>)}</div>
      </div>}

      {/* RISK */}
      {tab === "Risk" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RISK VERDICTS</div>
          {allOrds.slice(0, 5).map(e => e.riskCh && <div key={e.id} style={{ marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid " + K.bd + "12" }}>
            <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 2 }}>{mq(e.cid)}</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>{e.riskCh.map((ch, i) => <div key={i} style={{ display: "flex", gap: 2, alignItems: "center", fontSize: 8, fontFamily: FF }}><RB s={ch.s} /><span style={{ color: K.dm }}>{ch.n}</span></div>)}</div>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>POSITION LEDGER — qty limits (maxPos) · notional exposure (maxExpN) · YES/NO complementary</div>
          {Object.keys(st.positions).length === 0 && <div style={{ color: K.dm, fontSize: 9 }}>No positions</div>}
          {Object.entries(st.positions).map(([id, p]) => { const m = st.markets[id]; const uY = p.yesQty * ((m?.yes || 0) - p.yesAvgPx); const uN = p.noQty * ((1 - (m?.yes || 0)) - p.noAvgPx);
            return <div key={id} style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 8, marginBottom: 1 }}>{mq(id)} <span style={{ color: K.dm }}>({m?.cat})</span></div>
              <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
                <span>YES:{p.yesQty}@{(p.yesAvgPx * 100).toFixed(1)}{"\u00A2"}</span>
                <span>NO:{p.noQty}@{(p.noAvgPx * 100).toFixed(1)}{"\u00A2"}</span>
                <span style={{ color: K.g }}>rPnL:{f$(p.realizedPnl, 2)}</span>
                <span style={{ color: (uY + uN) >= 0 ? K.g : K.r }}>uPnL:{f$(uY + uN, 2)}</span>
              </div>
              <div style={{ height: 4, background: K.s2, borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
                <div style={{ width: Math.min(((p.yesQty + p.noQty) / CFG.maxPos) * 100, 100) + "%", height: "100%", background: (p.yesQty + p.noQty) / CFG.maxPos > 0.8 ? K.r : K.g, borderRadius: 2 }} />
              </div>
            </div>; })}
          {Object.keys(st.positions).length > 0 && <div style={{ marginTop: 6, fontFamily: FF, fontSize: 8, color: K.dm }}>
            Fills: {st.fills.length} (dedup keys: {Object.keys(st.fillKeys).length}) · Gross: {f$(st.grossExposure)} (notional) · Net: {f$(st.netExposure)} (notional)
          </div>}
        </div>
      </div>}

      {/* SYSTEM */}
      {tab === "System" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Approvals" v={st.monitor.approvals} c={K.g} s={st.monitor.rejections + " rej"} />
          <St l="NLP" v={st.monitor.signalCounts.nlp} c={K.c} />
          <St l="Mom" v={st.monitor.signalCounts.momentum} c={K.p} />
          <St l="Arb" v={st.monitor.signalCounts.arb} c={K.b} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Fills" v={st.fills.length} c={K.g} s="append-only" />
          <St l="Orders" v={st.orders.length + st.orderHistory.length} c={K.b} s={"hist:" + st.orderHistory.length} />
          <St l="CB state" v={st.cb.state} c={st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r} s={"rej:" + (st.cb.recentRejects||0) + " slip:" + (st.cb.recentSlipEvents||[]).length + " pf:" + (st.cb.recentPoorFills||[]).length + " inv:" + (st.cb.recentInvalidData||[]).length} />
          <St l="Spawns" v={(st.spawnStats?.existing||0) + (st.spawnStats?.new||0)} c={K.p} s={"def:" + (st.spawnStats?.deferred||0)} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RECONCILIATION (every tick)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 5 }}>
            <St l="Status" v={st.lastRecon.ok ? "OK" : "DRIFT"} c={st.lastRecon.ok ? K.g : K.r} />
            <St l="Issues" v={st.lastRecon.issues} c={st.lastRecon.issues > 0 ? K.r : K.g} />
            <St l="Pos drifts" v={st.lastRecon.drifts} c={st.lastRecon.drifts > 0 ? K.r : K.g} />
            <St l="Orphan fills" v={st.lastRecon.orphans} c={st.lastRecon.orphans > 0 ? K.r : K.g} />
            <St l="Fill keys" v={Object.keys(st.fillKeys).length} c={K.b} s={st.fills.length + " fills"} />
          </div>
          <div style={{ fontSize: 7, fontFamily: FF, color: K.dm, marginTop: 4 }}>Fills are source of truth. Positions rebuilt and verified each tick.{st.lastRecon.drifts > 0 && <span style={{ color: K.r }}> Position corrected.</span>}</div>
        </div>
        {st.cb.triggers.length > 0 && <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>CB TRIGGERS (auditable)</div>
          {st.cb.triggers.slice(-8).map((t2, i) => <div key={i} style={{ fontSize: 8, fontFamily: FF, color: K.r, padding: "1px 0" }}>{ft(t2.t)} {"\u2014"} {t2.from}{"\u2192"}{t2.to} {"\u2014"} {t2.r}</div>)}</div>}
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>EVENTS (this tick)</div>
          <div style={{ maxHeight: 250, overflowY: "auto" }}>{st.events.slice().reverse().slice(0, 25).map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", borderBottom: "1px solid " + K.bd + "08", fontSize: 8, fontFamily: FF }}>
            <span style={{ color: K.dm, minWidth: 40 }}>{ft(e.ts)}</span>
            <span style={bx(e.evt.includes("reject") || e.evt.includes("partial") || e.evt.includes("invalid") || e.evt.includes("recon:issue") ? K.r : e.evt.includes("recon") ? K.c : e.evt.includes("risk") ? K.o : e.evt.includes("exec") ? K.g : e.evt.includes("news") ? K.p : K.dm, e.evt.includes("reject") || e.evt.includes("partial") || e.evt.includes("invalid") || e.evt.includes("recon:issue") ? K.rd : e.evt.includes("recon") ? K.cd : e.evt.includes("risk") ? K.od : e.evt.includes("exec") ? K.gd : e.evt.includes("news") ? K.pd : K.s2)}>{e.evt}</span>
            <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>{e.s}</span>
          </div>)}</div>
        </div>
        <div style={{ ...cd2, fontSize: 8, fontFamily: FF, color: K.dm }}>
          <b style={{ color: K.tx }}>V4.2 correctness guarantees:</b><br />
          [P1] CB FSM: closed{"\u2192"}open{"\u2192"}half_open{"\u2192"}closed. 6 triggers (DD/exp/slip/reject/poorFill/invalidData), all config-driven<br />
          [P2] Exposure: qty limits (maxPos={CFG.maxPos}, maxCatQty={CFG.maxCatQty}) vs notional limits (maxExpN={CFG.maxExpNotional}), never mixed<br />
          [P3] Slippage/poorFills/invalidData: windowed arrays ({CFG.cbSlipWindow}/{CFG.cbPoorFillWindow}/{CFG.cbInvalidDataWindow}), feed CB deterministically<br />
          [P1] half_open: probe needs {"\u2265"}{CFG.cbHalfOpenProbeMinFills} fills + 0 rejects, max {CFG.cbHalfOpenMaxNotional} notional<br />
          [P4] Determinism: same input {"\u2192"} same output, no hidden state, all windows bounded
        </div>
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V4.2 · SEED:{st.seed} · TICK:{st.tickCount} · REALIZED:{f$(st.realizedPnl)} · UNREALIZED:{f$(st.unrealizedPnl)} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
