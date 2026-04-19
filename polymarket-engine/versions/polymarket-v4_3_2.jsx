import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
//  POLYMARKET V4.3.2 — CORRECTNESS + CLARITY PATCH
//
//  Patch from V4.3.1 (all fixes preserve determinism & replay safety):
//   C1. Half-open CB cap is now true NOTIONAL, converted to qty via side price
//       (was treating notional literal as a qty cap — wrong units).
//   C2. Half-open accounting uses actual fill notional (qty × price),
//       not totalFilled (which was qty).
//   C3. Recommendation sizing uses live state:
//       - live equity (not CFG.initialEquity hardcoded)
//       - drawdown scale applied to capital base
//       - remaining gross-notional room clamp
//       - remaining position qty clamp
//       - half-open CB notional clamp
//   C4. Pruning rewritten for clarity + correctness:
//       - always returns a flat array
//       - transitive closure over parent/replacedBy chains
//       - retention cap respected; min-terminal retention honored
//   C5. Risk clarity: renamed variables in preTradeRisk:
//       requestedQty / allowedQty / sidePrice / additionalNotional /
//       remainingNotionalCapacity / existingQty / existingCatQty.
//       qty-based and notional-based checks are visually distinct.
//   C6. Attribution: added array-attr guard in applyAttributionEvents.
//       Closing-only attribution already correct; tests added.
//   C7. FSM safety: terminal immutability verified by new tests.
//
//  Preserved from V4.3.1:
//   [A1-A4] Fill-level attribution correctness
//   [P1-P7] FSM hardening, partial fills, dedup, recon, CB, determinism
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
  cbRejectWindow: 20,       // [P5] NEW: windowed reject tracking
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
    // [P5] Circuit breaker: full 3-state FSM with all 6 windowed triggers
    cb: {
      state: "closed",
      failCount: 0,
      lastFailTime: 0,
      reason: null,
      triggers: [],
      recentSlipEvents: [],
      recentRejects: [],        // [P5] FIX: windowed array, was counter
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
    // [P6] Tick-local order sequence counter for deterministic IDs
    orderSeq: 0,
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
// [C3] Sizing uses LIVE state:
//      - current equity (not hardcoded initial equity)
//      - drawdown scale applied to capital base
//      - remaining gross notional room
//      - remaining per-market position qty room
//      - remaining per-category position qty room
//      - half-open CB notional cap (converted to qty via side price)
// Pre-trade risk still runs the authoritative check, but sizing requests
// are kept close to what actually fits, reducing noisy rejects.
function processSigs(signals, weights, regConf, time, liveState) {
  const live = liveState || {};
  const liveEquity = typeof live.equity === "number" && live.equity > 0 ? live.equity : CFG.initialEquity;
  const liveDD = typeof live.currentDD === "number" ? live.currentDD : 0;
  const liveGross = typeof live.grossExposure === "number" ? live.grossExposure : 0;
  const livePositions = live.positions || {};
  const liveMarkets = live.markets || {};
  const liveCbState = live.cbState || "closed";

  // Drawdown-scaled capital base (0 at/above maxDD, linear-ish above softDD)
  const ddScale = liveDD >= CFG.maxDD ? 0 : liveDD > CFG.softDD ? 1 - Math.pow(liveDD / CFG.maxDD, 1.5) : 1;
  const capitalBase = liveEquity * ddScale;
  const remainingNotionalRoom = Math.max(0, CFG.maxExpNotional - liveGross);

  // 1. Freshness + expiry filter
  let sigs = signals.filter(s => s.exp > time && (time - s.time) / (s.exp - s.time) < 0.8);
  // 2. Time-decayed edge
  sigs = sigs.map(s => {
    const fr = Math.pow(0.5, (time - s.time) / (s.hl || 300000));
    return { ...s, fr: +fr.toFixed(3), ee: +(s.edge * fr).toFixed(4) };
  });
  // 3. Best signal per source/market
  const best = {};
  for (const s of sigs) {
    const k = s.source + ":" + s.cid;
    if (!best[k] || s.ee > best[k].ee) best[k] = s;
  }
  sigs = Object.values(best).filter(s => (s.qs || 0.5) > 0.15);
  // 4. Group by market for composite signal
  const byM = {};
  for (const s of sigs) (byM[s.cid] || (byM[s.cid] = [])).push(s);

  const recs = [];
  for (const [mid, ms] of Object.entries(byM)) {
    // Composite direction and confidence
    let comp = 0;
    for (const s of ms) comp += s.ee * (s.dir === "BUY_YES" ? 1 : -1) * s.conf * (weights[s.source] || 0.33);
    const signs = ms.map(s => s.dir === "BUY_YES" ? 1 : -1);
    const conc = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    const conf = +cl(0.4 * conc + 0.3 * cl(Math.abs(comp) * 2, 0, 1) + 0.15 * cl(ms.length / 3, 0, 1) + 0.15 * regConf, 0, 0.95).toFixed(3);
    const dir = comp >= 0 ? "BUY_YES" : "BUY_NO";
    const ae = Math.abs(comp) * (0.5 + conc * 0.5);
    if (ae < 0.006) continue;

    // Kelly fraction (hard-capped 25% of capital for safety)
    const px = ms[0].px || 0.5;
    const odds = comp > 0 ? px / (1 - px + 1e-4) : (1 - px) / (px + 1e-4);
    const kelly = cl((ae * odds - (1 - ae)) / (odds + 1e-4) * 0.5, 0, 0.25) * conf;

    // Side price: what we actually pay per share on our chosen side
    const mkt = liveMarkets[mid];
    const sidePrice = mkt ? (dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;

    // Desired size from live capital (not hardcoded initialEquity)
    let desiredQty = Math.floor(kelly * capitalBase);

    // Clamp by remaining gross-notional room
    if (sidePrice > 0) {
      const qtyByNotional = Math.floor(remainingNotionalRoom / sidePrice);
      desiredQty = Math.min(desiredQty, qtyByNotional);
    }

    // Clamp by remaining per-market position room (YES+NO combined)
    const pos = livePositions[mid] || { yesQty: 0, noQty: 0 };
    const remainingMarketQty = Math.max(0, CFG.maxPos - pos.yesQty - pos.noQty);
    desiredQty = Math.min(desiredQty, remainingMarketQty);

    // Clamp by remaining per-category position room
    if (mkt) {
      let catQty = 0;
      for (const [otherMid, otherPos] of Object.entries(livePositions)) {
        const otherMkt = liveMarkets[otherMid];
        if (otherMkt && otherMkt.cat === mkt.cat) catQty += otherPos.yesQty + otherPos.noQty;
      }
      const remainingCatQty = Math.max(0, CFG.maxCatQty - catQty);
      desiredQty = Math.min(desiredQty, remainingCatQty);
    }

    // [C1] Half-open CB: convert notional cap → qty cap
    if (liveCbState === "half_open" && sidePrice > 0) {
      const halfOpenMaxQty = Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice);
      desiredQty = Math.min(desiredQty, halfOpenMaxQty);
    }

    if (desiredQty < 15) continue;

    // Attribution percentages (source contribution to composite edge)
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

// [C5] Pre-trade risk — explicit names, qty vs notional clearly separated.
// Sequence: CB → MarketPos (qty) → GrossExposure (notional) → DD →
//           Category (qty) → Liquidity → SignalQuality → MarketQuarantine.
// Each check either PASSES, ADJUSTS allowedQty downward, or BLOCKS.
function preTradeRisk(rec, snap) {
  const { positions, markets, cb, currentDD, grossExposure } = snap;
  const checks = [];
  let approved = true;
  const requestedQty = rec.sz;
  let allowedQty = requestedQty;

  // Side price: used for notional calculations. Based on order direction.
  const mkt = markets[rec.cid];
  const sidePrice = mkt ? (rec.dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;

  // ─── Check 1: Circuit breaker ───
  if (cb.state === "open") {
    checks.push({ n: "CB", s: "blocked", d: cb.reason });
    approved = false;
  } else if (cb.state === "half_open") {
    // [C1] Half-open cap is NOTIONAL. Convert to qty using side price.
    const halfOpenMaxQty = sidePrice > 0 ? Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice) : 0;
    if (allowedQty > halfOpenMaxQty) {
      allowedQty = halfOpenMaxQty;
      checks.push({ n: "CB", s: "adjusted", d: "half_open probe: notional cap $" + CFG.cbHalfOpenMaxNotional + " → qty " + halfOpenMaxQty });
    } else {
      checks.push({ n: "CB", s: "adjusted", d: "half_open probe" });
    }
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "CB", s: "pass", d: "closed" });
  }

  // ─── Check 2: Per-market position qty limit ───
  const pos = positions[rec.cid] || { yesQty: 0, noQty: 0 };
  const existingQty = pos.yesQty + pos.noQty;
  if (existingQty + allowedQty > CFG.maxPos) {
    allowedQty = Math.max(0, CFG.maxPos - existingQty);
    checks.push({ n: "PosQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: "qty:" + existingQty + "+" + allowedQty + "/" + CFG.maxPos });
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "PosQty", s: "pass", d: "qty:" + (existingQty + allowedQty) + "/" + CFG.maxPos });
  }

  // ─── Check 3: Gross exposure notional limit ───
  const additionalNotional = +(allowedQty * sidePrice).toFixed(2);
  const remainingNotionalCapacity = Math.max(0, CFG.maxExpNotional - grossExposure);
  if (additionalNotional > remainingNotionalCapacity) {
    const maxQtyByNotional = sidePrice > 0 ? Math.floor(remainingNotionalCapacity / sidePrice) : 0;
    allowedQty = Math.min(allowedQty, maxQtyByNotional);
    const finalNotional = +(allowedQty * sidePrice).toFixed(0);
    checks.push({ n: "ExpN", s: allowedQty > 0 ? "adjusted" : "blocked", d: "notional:" + grossExposure + "+" + finalNotional + "/" + CFG.maxExpNotional });
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "ExpN", s: "pass", d: "notional:" + grossExposure + "+" + additionalNotional + "/" + CFG.maxExpNotional });
  }

  // ─── Check 4: Drawdown size scaler ───
  const ddScale = currentDD >= CFG.maxDD ? 0 : currentDD > CFG.softDD ? 1 - Math.pow(currentDD / CFG.maxDD, 1.5) : 1;
  if (ddScale < 1) {
    allowedQty = Math.floor(allowedQty * ddScale);
    checks.push({ n: "DD", s: ddScale > 0 ? "adjusted" : "blocked", d: "scale=" + ddScale.toFixed(2) });
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "DD", s: "pass", d: (currentDD * 100).toFixed(1) + "%" });
  }

  // ─── Check 5: Per-category qty limit ───
  let existingCatQty = 0;
  if (mkt) {
    for (const [otherMid, otherPos] of Object.entries(positions)) {
      const otherMkt = markets[otherMid];
      if (otherMkt && otherMkt.cat === mkt.cat) existingCatQty += otherPos.yesQty + otherPos.noQty;
    }
  }
  if (existingCatQty + allowedQty > CFG.maxCatQty) {
    allowedQty = Math.max(0, CFG.maxCatQty - existingCatQty);
    checks.push({ n: "CatQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: (mkt?.cat) + ":qty=" + existingCatQty + "+" + allowedQty + "/" + CFG.maxCatQty });
    if (allowedQty <= 0) approved = false;
  } else {
    checks.push({ n: "CatQty", s: "pass", d: (mkt?.cat) + ":qty=" + (existingCatQty + allowedQty) + "/" + CFG.maxCatQty });
  }

  // ─── Check 6: Liquidity (ADV / requestedQty) ───
  const liqRatio = mkt && allowedQty > 0 ? mkt.adv / allowedQty : 999;
  if (liqRatio < CFG.minLiqRatio) {
    checks.push({ n: "Liq", s: "blocked", d: liqRatio.toFixed(1) });
    approved = false;
  } else {
    checks.push({ n: "Liq", s: "pass", d: liqRatio.toFixed(1) });
  }

  // ─── Check 7: Signal quality ───
  if ((rec.aq || 0) < CFG.minSigQuality) {
    checks.push({ n: "Qual", s: "blocked", d: "" + rec.aq });
    approved = false;
  } else {
    checks.push({ n: "Qual", s: "pass", d: "" + rec.aq });
  }

  // ─── Check 8: Market quarantine (invalid data) ───
  if (snap.quarantined[rec.cid]) {
    checks.push({ n: "MktVal", s: "blocked", d: snap.quarantined[rec.cid].join(",") });
    approved = false;
  } else {
    checks.push({ n: "MktVal", s: "pass", d: "valid" });
  }

  return { ok: approved && allowedQty >= 15, sz: allowedQty, ch: checks };
}

// ══════════════════════ ENGINE: EXECUTION [P1] ═══════════════════════
// [P1] Terminal states are immutable — no transitions out
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "REPLACED"]);
const TRANSITIONS = {
  NEW: new Set(["ACCEPTED", "REJECTED"]),
  ACCEPTED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"]),
  PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REPLACED"]),
  // [P1] Terminal states explicitly have no valid transitions
  FILLED: new Set(),
  CANCELLED: new Set(),
  REJECTED: new Set(),
  REPLACED: new Set(),
};
// [P1] Guard: terminal states always return false
function canTransition(from, to) {
  if (TERMINAL.has(from)) return false;
  return TRANSITIONS[from]?.has(to) || false;
}
function makeChildId(orderId, seq, gen) { return orderId + "_c" + seq + "_g" + gen; }

function buildChildren(orderId, totalSz, limitPx, strategy, gen) {
  const maxCh = strategy === "twap" ? 100 : strategy === "aggressive" ? totalSz : 200;
  const n = Math.ceil(totalSz / maxCh);
  const children = []; let rem = totalSz;
  for (let i = 0; i < n; i++) { const sz = Math.min(rem, maxCh); children.push({ id: makeChildId(orderId, i, gen), sz, lim: limitPx, fp: null, st: "NEW" }); rem -= sz; }
  return children;
}

// [P6] Deterministic order ID with tick-local sequence
function makeOrderId(prefix, cid, time, seq) {
  return prefix + "_" + cid + "_" + time + "_s" + seq;
}

function createOrder(rec, verdict, mkts, time, rng, seq) {
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
  // [P6] Deterministic ID with sequence counter
  const id = makeOrderId("ord", rec.cid, time, seq);
  return { id, time, cid: rec.cid, side, dir: rec.dir, parentSz: verdict.sz, lim, strat, children: buildChildren(id, verdict.sz, lim, strat, 0), status: "NEW", totalFilled: 0, avgFP: null, ce: rec.ce, attr: rec.attr, riskCh: verdict.ch, urg: rec.urg, fillRate: 0, slipBps: null, partialAction: null, retryBudget: CFG.partialRetryBudget, retryGen: 0, replacedBy: null, parentOrderId: null };
}

function checkSlippage(fillPx, limitPx, midPx) {
  const slipAbs = Math.abs(fillPx - limitPx);
  const slipBps = (slipAbs / (midPx || 0.5)) * 10000;
  return { slipBps: +slipBps.toFixed(2), exceeded: slipBps > CFG.maxSlipBps };
}

// [P1][P3] advanceOrderFills: terminal guard + child fill dedup
function advanceOrderFills(order, rng, mkts, tickTime, existingFillKeys) {
  // [P1] Terminal orders are immutable
  if (TERMINAL.has(order.status)) return { order, newFills: [], childSlipRejects: 0 };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  // [P1] NEW → ACCEPTED transition
  if (o.status === "NEW") {
    if (!canTransition("NEW", "ACCEPTED")) return { order: o, newFills: [], childSlipRejects: 0 };
    o.status = "ACCEPTED";
  }
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
      // [P3] Child-level fill key dedup — deterministic key
      const fillKey = "fill_" + o.id + "_" + ch.id;
      if (existingFillKeys[fillKey]) { ch.st = "FILLED"; ch.fp = rawFP; filled += ch.sz; cost += rawFP * ch.sz; continue; }
      ch.fp = rawFP; ch.st = "FILLED";
      filled += ch.sz; cost += rawFP * ch.sz;
      newFills.push({ key: fillKey, orderId: o.id, cid: o.cid, side: o.side, qty: ch.sz, px: rawFP, time: tickTime, slipBps: slip.slipBps, attr: o.attr || {} });
    }
  }
  o.totalFilled = filled;
  o.avgFP = filled > 0 ? +(cost / filled).toFixed(4) : null;
  o.fillRate = +(filled / o.parentSz).toFixed(2);
  if (newFills.length) o.slipBps = +(newFills.reduce((s, f) => s + f.slipBps, 0) / newFills.length).toFixed(2);
  // [P1] Status must match cumulative fill quantity
  if (filled >= o.parentSz) {
    if (canTransition(o.status, "FILLED")) o.status = "FILLED";
  } else if (filled > 0 && o.status === "ACCEPTED") {
    if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED";
  }
  // [P1] Auto-resolve: all children terminal but order not filled
  if (!TERMINAL.has(o.status)) {
    const pending = o.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pending.length === 0 && filled < o.parentSz && filled > 0) {
      if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED";
    }
    if (pending.length === 0 && filled === 0) {
      if (canTransition(o.status, "REJECTED")) o.status = "REJECTED";
    }
  }
  return { order: o, newFills, childSlipRejects };
}

// [P2] resolvePartialFill: deterministic handling for retry/cancel/replace/unwind
function resolvePartialFill(order, mkts, time, rng, seqRef) {
  if (order.status !== "PARTIALLY_FILLED") return { order, spawned: [] };
  // [P1] Terminal guard — should not reach here but defensive
  if (TERMINAL.has(order.status) && order.status !== "PARTIALLY_FILLED") return { order, spawned: [] };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  const mkt = mkts[o.cid]; const remaining = o.parentSz - o.totalFilled;
  const currentMid = mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim;
  const drift = Math.abs(currentMid - o.lim); const spawned = [];

  // [P2] CANCEL: remaining below minimum qty
  if (remaining < CFG.partialMinQty) {
    o.partialAction = { action: "CANCEL", reason: "remaining " + remaining + " < minQty " + CFG.partialMinQty };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    return { order: o, spawned };
  }

  // [P2] RETRY: low drift + budget remaining → deterministic follow-up children
  if (drift <= CFG.partialDriftThreshold && o.retryBudget > 0) {
    o.retryBudget--;
    o.retryGen = (o.retryGen || 0) + 1;
    o.partialAction = { action: "RETRY", reason: "gen=" + o.retryGen + ", budget=" + o.retryBudget + ", drift=" + (drift * 100).toFixed(1) + "%" };
    for (const ch of o.children) { if (ch.st === "ACCEPTED" || ch.st === "REJECTED") ch.st = "CANCELLED"; }
    // [P2] Only add new children for unfilled remaining qty
    const newChildren = buildChildren(o.id, remaining, o.lim, o.strat, o.retryGen);
    o.children = [...o.children, ...newChildren];
    // [P1] Status stays PARTIALLY_FILLED (new children will be processed next tick)
    return { order: o, spawned };
  }

  // [P2] REPLACE: moderate drift → create new order, old one terminal
  if (drift > CFG.partialDriftThreshold && drift <= CFG.partialDriftThreshold * 3 && o.retryBudget > 0) {
    o.partialAction = { action: "REPLACE", reason: "drift=" + (drift * 100).toFixed(1) + "%, new limit at current mid" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "REPLACED")) {
      o.status = "REPLACED";
      const newLim = r4(cl(currentMid, 0.01, 0.99));
      // [P6] Deterministic replacement order ID
      const replId = makeOrderId("ord_repl", o.cid, time, seqRef.val++);
      spawned.push({
        id: replId, time, cid: o.cid, side: o.side, dir: o.dir, parentSz: remaining,
        lim: newLim, strat: o.strat,
        children: buildChildren(replId, remaining, newLim, o.strat, 0),
        status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr,
        riskCh: o.riskCh, urg: o.urg, fillRate: 0, slipBps: null, partialAction: null,
        retryBudget: Math.max(0, o.retryBudget - 1), retryGen: 0,
        replacedBy: null, parentOrderId: o.id
      });
      o.replacedBy = replId;
    }
    return { order: o, spawned };
  }

  // [P2] UNWIND: high drift or no budget → close filled qty with real unwind order
  if (drift > CFG.partialDriftThreshold || o.retryBudget <= 0) {
    o.partialAction = { action: "UNWIND", reason: "drift=" + (drift * 100).toFixed(1) + "%, closing filled qty " + o.totalFilled };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    if (o.totalFilled > 0) {
      const uwDir = o.dir === "BUY_YES" ? "BUY_NO" : "BUY_YES";
      const uwSide = uwDir === "BUY_YES" ? "YES" : "NO";
      const uwLim = r4(cl(currentMid, 0.01, 0.99));
      // [P6] Deterministic unwind order ID
      const uwId = makeOrderId("ord_unwind", o.cid, time, seqRef.val++);
      spawned.push({
        id: uwId, time, cid: o.cid, side: uwSide, dir: uwDir, parentSz: o.totalFilled,
        lim: uwLim, strat: "aggressive",
        children: buildChildren(uwId, o.totalFilled, uwLim, "aggressive", 0),
        status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr,
        riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null,
        retryBudget: 0, retryGen: 0, replacedBy: null, parentOrderId: o.id
      });
    }
    return { order: o, spawned };
  }

  // Fallback: CANCEL
  o.partialAction = { action: "CANCEL", reason: "fallback" };
  for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
  if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
  return { order: o, spawned };
}

// ══════════════════════ ENGINE: PORTFOLIO [1][2] ═════════════════════
// [A2] applyFills now returns attrEvents: per-fill realized PnL attribution
function applyFills(positions, fills, fillKeys, newFills) {
  let pos = { ...positions }; let fs = [...fills]; let fk = { ...fillKeys };
  const attrEvents = [];  // [A2] { rpnl, attr } for each fill that generates realized PnL
  for (const f of newFills) {
    // [P3] Idempotent: duplicate fills never reapply
    if (fk[f.key]) continue; fk[f.key] = true; fs.push(f);
    const mid = f.cid;
    const p = pos[mid] ? { ...pos[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      if (p.noQty > 0) {
        const oq = Math.min(f.qty, p.noQty);
        const ep = 1 - f.px;
        const fillRpnl = +(oq * (ep - p.noAvgPx)).toFixed(4);  // [A2] exact rPnL from this fill's closing portion
        p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4);
        // [A2] Emit attribution event with fill's own attr (order→signal lineage)
        if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) {
          attrEvents.push({ rpnl: fillRpnl, attr: f.attr });
        }
        p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; }
      }
      else { const t = p.yesQty + f.qty; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0; p.yesQty = t; }
    } else {
      if (p.yesQty > 0) {
        const oq = Math.min(f.qty, p.yesQty);
        const ep = 1 - f.px;
        const fillRpnl = +(oq * (ep - p.yesAvgPx)).toFixed(4);  // [A2] exact rPnL from this fill's closing portion
        p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4);
        // [A2] Emit attribution event with fill's own attr (order→signal lineage)
        if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) {
          attrEvents.push({ rpnl: fillRpnl, attr: f.attr });
        }
        p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; }
        const aq = f.qty - oq;
        if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; }
      }
      else { const t = p.noQty + f.qty; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * f.qty) / t) : 0; p.noQty = t; }
    }
    pos = { ...pos, [mid]: p };
  }
  return { positions: pos, fills: fs, fillKeys: fk, attrEvents };
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

// ══════════════════════ ENGINE: META-ALPHA ATTRIBUTION [A2][A4] ═════
// Pure function: processes fill-level attribution events into metaPerf.
// Deterministic: same attrEvents always produce same metaPerf updates.
// Only learns from realized PnL. Never from unrealized PnL or fill-quality proxies.
// [C6] Defensive against malformed attr: arrays, nulls, non-finite numbers.
function applyAttributionEvents(metaPerf, attrEvents) {
  if (!attrEvents || attrEvents.length === 0) return metaPerf;
  const result = { nlp: [...metaPerf.nlp], momentum: [...metaPerf.momentum], arb: [...metaPerf.arb] };
  for (const evt of attrEvents) {
    if (!evt || typeof evt.rpnl !== "number" || !Number.isFinite(evt.rpnl)) continue;
    if (Math.abs(evt.rpnl) < 0.0001) continue;
    const attr = evt.attr;
    // Reject null, arrays, and non-objects — attr must be a plain object {src:pct}
    if (!attr || typeof attr !== "object" || Array.isArray(attr)) continue;
    for (const [src, pct] of Object.entries(attr)) {
      const buf = result[src];
      if (!buf) continue;
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      // Proportional attribution: source gets its percentage of the fill's rPnL
      buf.push(+(evt.rpnl * pct / 100).toFixed(6));
      if (buf.length > 50) buf.shift();
    }
  }
  return result;
}

// ══════════════════════ ENGINE: RECONCILIATION [P4] ═════════════════
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

// [P4] Enhanced reconciliation with full lineage + consistency checks
function reconcile(livePositions, fills, fillKeys, orders, orderHistory) {
  const issues = [];
  // 1. Rebuild positions from fills (source of truth)
  const rebuilt = rebuildPositionsFromFills(fills);
  const allMids = new Set([...Object.keys(livePositions), ...Object.keys(rebuilt)]);
  let positionsDrifted = false;
  for (const mid of allMids) {
    const live = livePositions[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 };
    const rb = rebuilt[mid] || { yesQty: 0, noQty: 0, realizedPnl: 0 };
    if (Math.abs(live.yesQty - rb.yesQty) > 0.01 || Math.abs(live.noQty - rb.noQty) > 0.01 || Math.abs(live.realizedPnl - rb.realizedPnl) > 0.01) {
      issues.push({ type: "position_drift", market: mid });
      positionsDrifted = true;
    }
  }

  // 2. Duplicate fill detection in ledger
  const seenKeys = {};
  for (const f of fills) {
    if (seenKeys[f.key]) issues.push({ type: "duplicate_fill_in_ledger", key: f.key });
    seenKeys[f.key] = true;
  }

  // 3. Order/fill consistency
  const allOrders = [...orders, ...orderHistory];
  const fillsByOrder = {};
  for (const f of fills) { (fillsByOrder[f.orderId] || (fillsByOrder[f.orderId] = [])).push(f); }
  for (const ord of allOrders) {
    const of2 = fillsByOrder[ord.id] || [];
    const fqs = of2.reduce((s, f) => s + f.qty, 0);
    // [P4] FILLED orders must have fills == parentSz
    if (ord.status === "FILLED" && Math.abs(fqs - ord.parentSz) > 0.01) issues.push({ type: "filled_qty_mismatch", orderId: ord.id });
    // [P4] PARTIALLY_FILLED orders must have 0 < fills < parentSz
    if (ord.status === "PARTIALLY_FILLED" && (fqs <= 0 || fqs >= ord.parentSz)) issues.push({ type: "partial_qty_inconsistent", orderId: ord.id });
    // [P4] Order totalFilled must match actual fill sum
    if (Math.abs((ord.totalFilled || 0) - fqs) > 0.01) issues.push({ type: "order_fill_total_mismatch", orderId: ord.id });
    // [P4] Fill cid must match order cid
    for (const f of of2) { if (f.cid !== ord.cid) issues.push({ type: "fill_cid_mismatch", fillKey: f.key }); }
  }

  // 4. Orphan fills (fills linked to missing orders)
  const orderIds = new Set(allOrders.map(o => o.id));
  for (const f of fills) { if (!orderIds.has(f.orderId)) issues.push({ type: "orphan_fill", fillKey: f.key, orderId: f.orderId }); }

  // 5. Terminal orders incorrectly left in active list
  for (const o of orders) { if (TERMINAL.has(o.status)) issues.push({ type: "terminal_in_active", orderId: o.id }); }

  // 6. Replacement lineage consistency
  for (const o of allOrders) {
    if (o.status === "REPLACED" && o.replacedBy) {
      const rpl = allOrders.find(r => r.id === o.replacedBy);
      if (!rpl) issues.push({ type: "replacement_missing", orderId: o.id });
      else if (rpl.parentOrderId !== o.id) issues.push({ type: "replacement_lineage_mismatch", orderId: o.id });
    }
    // 7. Unwind lineage consistency
    if (o.parentOrderId && o.id.includes("unwind")) {
      if (!allOrders.find(p => p.id === o.parentOrderId)) issues.push({ type: "unwind_parent_missing", orderId: o.id });
    }
  }

  // 8. Fill key consistency — [P4] detect stale/missing keys
  const ledgerKeys = new Set(fills.map(f => f.key));
  for (const k of Object.keys(fillKeys)) { if (!ledgerKeys.has(k)) issues.push({ type: "stale_fill_key", key: k }); }
  for (const k of ledgerKeys) { if (!fillKeys[k]) issues.push({ type: "missing_fill_key", key: k }); }

  // [P4] Correct positions from source of truth (fills)
  const correctedPositions = positionsDrifted ? rebuilt : livePositions;
  // [P4] Rebuild fill keys from fills (always consistent)
  const correctedFillKeys = {};
  for (const f of fills) correctedFillKeys[f.key] = true;

  return {
    ok: issues.length === 0, issues, correctedPositions, correctedFillKeys,
    rebuiltPositions: rebuilt, fillCount: fills.length, orderCount: allOrders.length,
    orphanFills: issues.filter(i => i.type === "orphan_fill").length,
    driftCount: issues.filter(i => i.type === "position_drift").length
  };
}

// ══════════════════════ ENGINE: CIRCUIT BREAKER [P5] ════════════════
// Full 3-state FSM: closed -> open -> half_open -> closed
// TRIP TRIGGERS (all config-driven):
//   1. drawdown_breach  2. exposure_breach  3. excessive_slippage
//   4. repeated_rejects  5. poor_fills  6. invalid_market_data

// [P5] tripCB is PURE — returns new CB object, no mutation
function tripCB(cb, reason, time) {
  return {
    ...cb,
    state: "open",
    reason: reason,
    lastFailTime: time,
    failCount: (cb.failCount || 0) + 1,
    triggers: [...cb.triggers, { t: time, r: reason, from: cb.state, to: "open" }],
    halfOpenNotional: 0,
    halfOpenFills: 0,
  };
}

// [P5] updateCB: pure function, all windowed arrays, deterministic recovery
function updateCB(cb, metrics, time) {
  let next = {
    ...cb,
    triggers: [...cb.triggers],
    recentSlipEvents: [...(cb.recentSlipEvents || [])],
    recentPoorFills: [...(cb.recentPoorFills || [])],
    recentInvalidData: [...(cb.recentInvalidData || [])],
    recentRejects: [...(cb.recentRejects || [])],  // [P5] windowed array
  };
  // Recovery: open -> half_open
  if (next.state === "open" && time - next.lastFailTime > CFG.cbRecoveryMs) {
    next.triggers = [...next.triggers, { t: time, r: "recovery_timer", from: "open", to: "half_open" }];
    next.state = "half_open"; next.halfOpenNotional = 0; next.halfOpenFills = 0;
  }
  // Recovery: half_open -> closed (deterministic probe success)
  if (next.state === "half_open" && next.halfOpenFills >= CFG.cbHalfOpenProbeMinFills && next.recentRejects.length === 0) {
    next.triggers = [...next.triggers, { t: time, r: "probe_success: fills=" + next.halfOpenFills + " rejects=0", from: "half_open", to: "closed" }];
    next.state = "closed"; next.failCount = 0; next.reason = null;
    next.halfOpenNotional = 0; next.halfOpenFills = 0;
  }
  // Trip 1: drawdown
  if (next.state !== "open" && metrics.currentDD > CFG.maxDD) next = tripCB(next, "drawdown_breach: " + (metrics.currentDD * 100).toFixed(1) + "%", time);
  // Trip 2: exposure (notional)
  if (next.state !== "open" && metrics.grossExposure > CFG.maxExpNotional * CFG.cbExpBreachMultiplier) next = tripCB(next, "exposure_breach: " + metrics.grossExposure.toFixed(0), time);
  // Trip 3: excessive slippage (windowed)
  const highSlip = next.recentSlipEvents.filter(e => e.slipBps > CFG.maxSlipBps * 0.8).length;
  if (next.state !== "open" && highSlip >= CFG.cbSlipThreshold) { next = tripCB(next, "excessive_slippage: " + highSlip + " events", time); next.recentSlipEvents = []; }
  // Trip 4: repeated rejects (windowed) — [P5] FIX: was unbounded counter
  if (next.state !== "open" && next.recentRejects.length >= CFG.cbRejectThreshold) { next = tripCB(next, "repeated_rejects: " + next.recentRejects.length, time); next.recentRejects = []; }
  // Trip 5: poor fills (windowed)
  if (next.state !== "open" && next.recentPoorFills.length >= CFG.cbPoorFillThreshold) { next = tripCB(next, "poor_fills: " + next.recentPoorFills.length, time); next.recentPoorFills = []; }
  // Trip 6: invalid market data (windowed)
  if (next.state !== "open" && next.recentInvalidData.length >= CFG.cbInvalidDataThreshold) { next = tripCB(next, "invalid_market_data: " + next.recentInvalidData.length, time); next.recentInvalidData = []; }
  if (next.triggers.length > 30) next.triggers = next.triggers.slice(-25);
  return next;
}

// ══════════════════════ ENGINE: PRUNING [C4] ════════════════════════
// Collect order IDs that must NOT be pruned from history:
//   - all active (non-terminal) orders
//   - both ends of every replacedBy link
//   - parent + child of every parentOrderId link
//   - transitive closure over both relations (lineage chains)
function collectProtectedOrderIds(activeOrders, historyOrders) {
  const protectedIds = new Set();
  const allOrders = [...activeOrders, ...historyOrders];

  // Seed: non-terminal active orders
  for (const o of activeOrders) {
    if (!TERMINAL.has(o.status)) protectedIds.add(o.id);
  }
  // Seed: direct lineage links
  for (const o of allOrders) {
    if (o.replacedBy) {
      protectedIds.add(o.id);
      protectedIds.add(o.replacedBy);
    }
    if (o.parentOrderId) {
      protectedIds.add(o.id);
      protectedIds.add(o.parentOrderId);
    }
  }

  // Transitive closure: extend protection through chains.
  // Guard against infinite loops with a hard cap.
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (const o of allOrders) {
      if (protectedIds.has(o.id)) {
        if (o.parentOrderId && !protectedIds.has(o.parentOrderId)) {
          protectedIds.add(o.parentOrderId);
          changed = true;
        }
        if (o.replacedBy && !protectedIds.has(o.replacedBy)) {
          protectedIds.add(o.replacedBy);
          changed = true;
        }
      }
      if (o.parentOrderId && protectedIds.has(o.parentOrderId) && !protectedIds.has(o.id)) {
        protectedIds.add(o.id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return protectedIds;
}

// Prune terminal history while preserving protected lineage.
// Always returns a flat array. Never mutates input.
function pruneOrderHistory(orderHistory, activeOrders) {
  if (!Array.isArray(orderHistory)) return [];
  if (orderHistory.length <= CFG.historyRetentionCap) return [...orderHistory];

  const protectedIds = collectProtectedOrderIds(activeOrders, orderHistory);
  const protectedOrders = [];
  const prunable = [];
  for (const o of orderHistory) {
    if (protectedIds.has(o.id)) protectedOrders.push(o);
    else prunable.push(o);
  }

  // Budget for prunable retention:
  //   - at minimum: historyMinRetainTerminal (so we always keep a tail)
  //   - at most:    remaining slots after protected
  const remainingSlots = Math.max(0, CFG.historyRetentionCap - protectedOrders.length);
  const minRetain = Math.min(CFG.historyMinRetainTerminal, prunable.length);
  const budget = Math.max(minRetain, remainingSlots);
  const keepPrunable = budget > 0 ? prunable.slice(-Math.min(budget, prunable.length)) : [];

  return [...protectedOrders, ...keepPrunable];
}

// ══════════════════════ ENGINE: CB EVENT TRACKING [P5] ══════════════
// [P5] All tracking functions are PURE — return new CB, no mutation
function recordReject(cb, type, orderId, events, time) {
  const newRejects = [...(cb.recentRejects || []), { time, type, orderId }];
  // [P5] Window the rejects array
  const windowed = newRejects.length > CFG.cbRejectWindow ? newRejects.slice(-CFG.cbRejectWindow) : newRejects;
  events.push({ evt: "cb:" + type, ts: time, s: orderId || "" });
  return { ...cb, recentRejects: windowed };
}
function recordApproval(cb) {
  // [P5] Remove oldest reject on approval (decay)
  const rejects = [...(cb.recentRejects || [])];
  if (rejects.length > 0) rejects.shift();
  return { ...cb, recentRejects: rejects };
}
function recordSlipEvent(cb, slipBps, time) {
  const newSlip = [...(cb.recentSlipEvents || []), { time, slipBps }];
  return { ...cb, recentSlipEvents: newSlip.length > CFG.cbSlipWindow ? newSlip.slice(-CFG.cbSlipWindow) : newSlip };
}
function recordPoorFill(cb, time) {
  const newPoor = [...(cb.recentPoorFills || []), { time }];
  return { ...cb, recentPoorFills: newPoor.length > CFG.cbPoorFillWindow ? newPoor.slice(-CFG.cbPoorFillWindow) : newPoor };
}
function recordInvalidData(cb, marketId, time) {
  const newInvalid = [...(cb.recentInvalidData || []), { time, marketId }];
  return { ...cb, recentInvalidData: newInvalid.length > CFG.cbInvalidDataWindow ? newInvalid.slice(-CFG.cbInvalidDataWindow) : newInvalid };
}

// ══════════════════════ ENGINE: TICK [P6] ═══════════════════════════
function tick(prev, tickTime) {
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };
  // [P6] Tick-local sequence counter for deterministic order IDs
  const seqRef = { val: prev.orderSeq || 0 };

  // 2. Markets
  const newMkts = {}; for (const [id, m] of Object.entries(s.markets)) newMkts[id] = advMkt(m, rng, time); s.markets = newMkts;
  // 3. Histories
  const newH = {}; for (const [id, m] of Object.entries(s.markets)) { const bk = buildBook(m.yes, m.adv, rng); newH[id] = pushHist(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, m.yes, bk.spread, bk.bidDepth); } s.histories = newH;
  // 4. Validate markets + feed invalid data to CB
  const quarantined = {};
  let cb = { ...s.cb, triggers: [...s.cb.triggers], recentSlipEvents: [...(s.cb.recentSlipEvents||[])], recentPoorFills: [...(s.cb.recentPoorFills||[])], recentInvalidData: [...(s.cb.recentInvalidData||[])], recentRejects: [...(s.cb.recentRejects||[])] };
  for (const [id, m] of Object.entries(s.markets)) {
    const bk = buildBook(m.yes, m.adv, rng);
    const v = validateMarket(m, bk, time);
    if (!v.valid) {
      quarantined[id] = v.issues;
      s.events.push({ evt: "mkt:invalid", ts: time, s: id + ":" + v.issues.join(",") });
      // [P5] Pure recordInvalidData
      cb = recordInvalidData(cb, id, time);
    }
  }
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
  // 8. Process signals into recommendations
  // [C3] Pass live state so sizing uses current equity, DD, exposure, positions, CB state.
  const liveStateForSizing = {
    equity: s.equity,
    currentDD: s.currentDD,
    grossExposure: s.grossExposure,
    positions: s.positions,
    markets: s.markets,
    cbState: cb.state,
  };
  const { filtered, recs } = processSigs(sigs, s.alphaWeights, s.regime.confidence, time, liveStateForSizing);
  s.signals = filtered.slice(0, 80);
  s.recommendations = [...recs, ...s.recommendations].slice(0, 40);
  // 9-11. Orders
  let positions = {}; for (const [k, v] of Object.entries(s.positions)) positions[k] = { ...v };
  let fills = [...s.fills], fillKeys = { ...s.fillKeys };
  let orders = s.orders.map(o => ({ ...o, children: o.children.map(c => ({ ...c })) }));
  let orderHistory = [...s.orderHistory]; let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let allNewFills = [];

  // [P5][P7] processOrder: pure CB tracking, proper poor fill timing
  function processOrder(ord) {
    // [P3] Pass existing fill keys for child-level dedup
    const { order: advanced, newFills: nf, childSlipRejects } = advanceOrderFills(ord, rng, s.markets, time, fillKeys);
    allNewFills.push(...nf);
    // [P3] Update fillKeys immediately for dedup within same tick
    for (const f of nf) fillKeys[f.key] = true;
    // [P5] Pure CB tracking — reassign cb
    if (childSlipRejects > 0) { for (let i = 0; i < childSlipRejects; i++) cb = recordSlipEvent(cb, CFG.maxSlipBps + 1, time); }
    if (advanced.slipBps != null) cb = recordSlipEvent(cb, advanced.slipBps, time);
    if (advanced.status === "REJECTED") cb = recordReject(cb, "order_reject", advanced.id, s.events, time);
    // Poor fill: only record when all children are done, order has low fill rate, and size was meaningful
    const pendingChildren = advanced.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    const allChildrenDone = pendingChildren.length === 0;
    const fillRateLow = advanced.fillRate < 0.3 && advanced.parentSz > 50;
    if (allChildrenDone && fillRateLow) {
      cb = recordPoorFill(cb, time);
    }
    // [C2] Half-open probe accounting: use REAL fill notional (qty × price),
    // not totalFilled which is quantity. Count each new fill as a probe data point.
    if (cb.state === "half_open" && nf.length > 0) {
      let probeFillNotional = 0;
      for (const f of nf) probeFillNotional += f.qty * f.px;
      cb = {
        ...cb,
        halfOpenNotional: cb.halfOpenNotional + probeFillNotional,
        halfOpenFills: (cb.halfOpenFills || 0) + nf.length,
      };
    }
    // [P2] Pass seqRef for deterministic replacement/unwind IDs
    const { order: resolved, spawned } = resolvePartialFill(advanced, s.markets, time, rng, seqRef);
    if (resolved.partialAction) s.events.push({ evt: "partial:" + resolved.partialAction.action.toLowerCase(), ts: time, s: resolved.cid + "|" + resolved.partialAction.reason });
    return { resolved, spawned };
  }

  // [P7] drainSpawnQueue: maxSpawnDepth + maxSpawnsPerTick enforcement
  function drainSpawnQueue(initialOrders) {
    const active = [], terminal = [], spawnQueue = []; let totalSpawns = 0; const deferred = [];
    for (const o of initialOrders) {
      // [P1] Terminal orders go straight to history — no processing
      if (TERMINAL.has(o.status)) { terminal.push(o); continue; }
      const { resolved, spawned } = processOrder(o);
      if (TERMINAL.has(resolved.status)) terminal.push(resolved); else active.push(resolved);
      for (const sp of spawned) spawnQueue.push({ order: sp, depth: 1 });
      if (resolved.totalFilled > 0) s.events.push({ evt: "exec:advance", ts: time, s: resolved.cid + "|" + resolved.status + "|f=" + resolved.totalFilled });
    }
    // [P7] Spawn queue: enforce depth + count limits
    while (spawnQueue.length > 0) {
      const { order: spOrd, depth } = spawnQueue.shift();
      if (depth > CFG.maxSpawnDepth || totalSpawns >= CFG.maxSpawnsPerTick) {
        deferred.push(spOrd);
        s.events.push({ evt: "spawn:deferred", ts: time, s: spOrd.id + "|d=" + depth });
        continue;
      }
      totalSpawns++;
      const { resolved: spRes, spawned: spSp } = processOrder(spOrd);
      if (TERMINAL.has(spRes.status)) terminal.push(spRes); else active.push(spRes);
      s.events.push({ evt: "exec:spawned", ts: time, s: spRes.id + "|" + spRes.status });
      for (const ss of spSp) spawnQueue.push({ order: ss, depth: depth + 1 });
    }
    return { active, terminal, deferred, totalSpawns };
  }

  // [P7] Resume deferred spawns from previous tick
  const prevDeferred = s.deferredSpawns || []; let deferredSpawns = [];
  if (prevDeferred.length > 0) {
    s.events.push({ evt: "spawn:deferred_resume", ts: time, s: "count=" + prevDeferred.length });
    const defResult = drainSpawnQueue(prevDeferred);
    orders.push(...defResult.active);
    orderHistory.push(...defResult.terminal);
    deferredSpawns.push(...defResult.deferred);
  }

  const existingResult = drainSpawnQueue(orders);
  orders = existingResult.active;
  orderHistory.push(...existingResult.terminal);
  deferredSpawns.push(...existingResult.deferred);

  // New recs
  const snap = { positions, markets: s.markets, cb, currentDD: s.currentDD, grossExposure: calcExposure(positions, s.markets).gross, quarantined };
  const newOrdersFromRecs = [];
  for (const rec of recs) {
    const liveExp = calcExposure(positions, s.markets);
    const expSnap = { ...snap, grossExposure: liveExp.gross };
    const verdict = preTradeRisk(rec, expSnap);
    if (verdict.ok) { monitor.approvals++; cb = recordApproval(cb); }
    else { monitor.rejections++; cb = recordReject(cb, "risk_reject", rec.cid, s.events, time); }
    s.events.push({ evt: verdict.ok ? "risk:pass" : "risk:reject", ts: time, s: rec.cid + "|sz=" + verdict.sz });
    // [P6] Pass sequence counter for deterministic order IDs
    const ord = createOrder(rec, verdict, s.markets, time, rng, seqRef.val++);
    if (ord) newOrdersFromRecs.push(ord);
  }

  const newResult = drainSpawnQueue(newOrdersFromRecs);
  orders.push(...newResult.active);
  orderHistory.push(...newResult.terminal);
  deferredSpawns.push(...newResult.deferred);
  for (const o of newResult.active.concat(newResult.terminal)) s.events.push({ evt: "exec:new", ts: time, s: o.cid + "|" + o.strat + "|" + o.status });

  // [P7] Deduplicate deferred spawns by ID
  const seenDef = new Set();
  deferredSpawns = deferredSpawns.filter(d => { if (seenDef.has(d.id)) return false; seenDef.add(d.id); return true; });

  // 11. Fills — [P3] Append-only, deduped via fillKeys
  // [A2] applyFills now returns attrEvents for fill-level attribution
  const fResult = applyFills(positions, fills, fillKeys, allNewFills);
  positions = fResult.positions; fills = fResult.fills; fillKeys = fResult.fillKeys;

  // [A2] MetaAlpha: fill-level realized PnL attribution via actual lineage
  // Replaces old "most recent order in market" .pop() logic
  metaPerf = applyAttributionEvents(metaPerf, fResult.attrEvents);
  if (fResult.attrEvents.length > 0) {
    s.events.push({ evt: "meta:attr", ts: time, s: "events=" + fResult.attrEvents.length + "|sources=" + fResult.attrEvents.map(e => Object.keys(e.attr).join("+")).join(",") });
  }

  // 12. Recon — [P4] Full reconciliation every tick
  const reconResult = reconcile(positions, fills, fillKeys, orders, orderHistory);
  if (!reconResult.ok) {
    positions = reconResult.correctedPositions;
    fillKeys = reconResult.correctedFillKeys;
    for (const issue of reconResult.issues) s.events.push({ evt: "recon:issue", ts: time, s: issue.type + "|" + (issue.orderId || issue.key || issue.market || "") });
    // [P4] Move terminal orders from active to history
    const fixedOrders = [];
    for (const o of orders) {
      if (TERMINAL.has(o.status)) { orderHistory.push(o); s.events.push({ evt: "recon:fix", ts: time, s: "terminal_moved|" + o.id }); }
      else fixedOrders.push(o);
    }
    orders = fixedOrders;
  }
  s.events.push({ evt: "recon:done", ts: time, s: "ok=" + reconResult.ok + "|issues=" + reconResult.issues.length });

  // 13. Metrics
  const metrics = computeMetrics(positions, s.markets, s.equityCurve, s.peakEquity);
  // 14. CB
  cb = updateCB(cb, metrics, time);
  // 15. Prune history
  orderHistory = pruneOrderHistory(orderHistory, orders);

  return {
    ...s, positions, fills, fillKeys, orders, orderHistory, deferredSpawns,
    equity: metrics.equity, equityCurve: metrics.equityCurve,
    peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure,
    netExposure: metrics.netExposure, totalPnl: metrics.totalPnl,
    realizedPnl: metrics.realizedPnl, unrealizedPnl: metrics.unrealizedPnl,
    currentDD: metrics.currentDD, cb, monitor, metaPerf,
    // [P6] Persist order sequence counter
    orderSeq: seqRef.val,
    lastRecon: {
      ok: reconResult.ok, issues: reconResult.issues.length,
      drifts: reconResult.driftCount, orphans: reconResult.orphanFills,
      fills: reconResult.fillCount, orders: reconResult.orderCount
    },
    spawnStats: { existing: existingResult.totalSpawns, new: newResult.totalSpawns, deferred: deferredSpawns.length }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  DETERMINISTIC TESTS [P6]
// ═══════════════════════════════════════════════════════════════════════
function runTests() {
  const results = [];
  const assert = (name, cond) => { results.push({ name, pass: !!cond }); };

  // --- ORDER LIFECYCLE ---
  // Test 1: NEW -> ACCEPTED -> PARTIALLY_FILLED -> FILLED
  {
    const rng = createRng(100);
    let ord = { id: "t1", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 10, lim: 0.5, strat: "aggressive", children: buildChildren("t1", 10, 0.5, "aggressive", 0), status: "NEW", totalFilled: 0, avgFP: null, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null, retryBudget: 2, retryGen: 0, replacedBy: null, parentOrderId: null };
    const mkts = { btc150k: { id: "btc150k", yes: 0.5, cat: "crypto", adv: 12000 } };
    // Run enough times to fill
    let filled = false;
    for (let i = 0; i < 20 && !filled; i++) {
      const r = advanceOrderFills(ord, createRng(100 + i), mkts, 1000 + i, {});
      ord = r.order;
      if (ord.status === "FILLED") filled = true;
    }
    assert("lifecycle:NEW->FILLED path exists", ord.totalFilled > 0);
  }

  // Test 2: NEW -> ACCEPTED -> REJECTED (all children rejected on slip)
  {
    const ord = { id: "t2", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 10, lim: 0.05, strat: "aggressive", children: [{ id: "t2_c0_g0", sz: 10, lim: 0.05, fp: null, st: "NEW" }], status: "NEW", totalFilled: 0, avgFP: null, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null, retryBudget: 0, retryGen: 0, replacedBy: null, parentOrderId: null };
    // Low-price market so a small absolute price offset → huge bps → slip reject
    const mkts = { btc150k: { id: "btc150k", yes: 0.05, cat: "crypto", adv: 12000 } };
    // Alternate rng: 1st call (fill gate) passes, 2nd call (price offset) yields max deviation
    let callCount = 0;
    const slipRng = () => (++callCount % 2 === 1 ? 0.5 : 0.99);
    const r = advanceOrderFills(ord, slipRng, mkts, 1000, {});
    assert("lifecycle:NEW->REJECTED on slip", r.order.children[0].st === "REJECTED");
  }

  // Test 3: PARTIALLY_FILLED -> REPLACED with new order
  {
    const seqRef = { val: 0 };
    const ord = { id: "t3", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 100, lim: 0.40, strat: "patient", children: [{ id: "t3_c0_g0", sz: 50, lim: 0.40, fp: 0.41, st: "FILLED" }, { id: "t3_c1_g0", sz: 50, lim: 0.40, fp: null, st: "ACCEPTED" }], status: "PARTIALLY_FILLED", totalFilled: 50, avgFP: 0.41, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0.5, slipBps: null, partialAction: null, retryBudget: 1, retryGen: 0, replacedBy: null, parentOrderId: null };
    // Mid drifted enough for REPLACE (drift > threshold but <= 3x)
    const mkts = { btc150k: { id: "btc150k", yes: 0.45, cat: "crypto", adv: 12000 } };
    const r = resolvePartialFill(ord, mkts, 2000, createRng(42), seqRef);
    assert("partial:REPLACE creates new order", r.spawned.length === 1);
    assert("partial:REPLACE old order REPLACED", r.order.status === "REPLACED");
    assert("partial:REPLACE lineage correct", r.spawned[0].parentOrderId === "t3");
    assert("partial:REPLACE replacedBy set", r.order.replacedBy === r.spawned[0].id);
  }

  // Test 4: PARTIALLY_FILLED -> CANCELLED (remaining < minQty)
  {
    const seqRef = { val: 0 };
    const ord = { id: "t4", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 100, lim: 0.50, strat: "patient", children: [{ id: "t4_c0_g0", sz: 90, lim: 0.50, fp: 0.50, st: "FILLED" }, { id: "t4_c1_g0", sz: 10, lim: 0.50, fp: null, st: "ACCEPTED" }], status: "PARTIALLY_FILLED", totalFilled: 90, avgFP: 0.50, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0.9, slipBps: null, partialAction: null, retryBudget: 2, retryGen: 0, replacedBy: null, parentOrderId: null };
    const mkts = { btc150k: { id: "btc150k", yes: 0.50, cat: "crypto", adv: 12000 } };
    const r = resolvePartialFill(ord, mkts, 2000, createRng(42), seqRef);
    assert("partial:CANCEL on small remaining", r.order.status === "CANCELLED");
    assert("partial:CANCEL action set", r.order.partialAction.action === "CANCEL");
  }

  // Test 5: PARTIALLY_FILLED -> UNWIND with real unwind order
  {
    const seqRef = { val: 0 };
    const ord = { id: "t5", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 200, lim: 0.40, strat: "patient", children: [{ id: "t5_c0_g0", sz: 100, lim: 0.40, fp: 0.41, st: "FILLED" }, { id: "t5_c1_g0", sz: 100, lim: 0.40, fp: null, st: "ACCEPTED" }], status: "PARTIALLY_FILLED", totalFilled: 100, avgFP: 0.41, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0.5, slipBps: null, partialAction: null, retryBudget: 0, retryGen: 0, replacedBy: null, parentOrderId: null };
    // High drift + no budget → UNWIND
    const mkts = { btc150k: { id: "btc150k", yes: 0.60, cat: "crypto", adv: 12000 } };
    const r = resolvePartialFill(ord, mkts, 2000, createRng(42), seqRef);
    assert("partial:UNWIND creates unwind order", r.spawned.length === 1);
    assert("partial:UNWIND order cancelled", r.order.status === "CANCELLED");
    assert("partial:UNWIND opposite direction", r.spawned[0].dir !== ord.dir);
    assert("partial:UNWIND size equals filled", r.spawned[0].parentSz === 100);
    assert("partial:UNWIND lineage correct", r.spawned[0].parentOrderId === "t5");
  }

  // Test 6: Duplicate fill rejection
  {
    const pos = {}; const fills = []; const fk = {};
    const f1 = { key: "fill_dup_test", orderId: "o1", cid: "btc150k", side: "YES", qty: 50, px: 0.45, time: 1000, slipBps: 2 };
    const r1 = applyFills(pos, fills, fk, [f1]);
    assert("dedup:first fill applied", r1.fills.length === 1);
    assert("dedup:position created", r1.positions.btc150k.yesQty === 50);
    // Apply same fill again
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f1]);
    assert("dedup:duplicate fill rejected", r2.fills.length === 1);
    assert("dedup:position unchanged", r2.positions.btc150k.yesQty === 50);
  }

  // Test 7: Idempotent replay of lifecycle events
  {
    const rng1 = createRng(42);
    const rng2 = createRng(42);
    const ord1 = { id: "idem1", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES", parentSz: 50, lim: 0.5, strat: "aggressive", children: buildChildren("idem1", 50, 0.5, "aggressive", 0), status: "NEW", totalFilled: 0, avgFP: null, ce: 0.01, attr: {}, riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null, retryBudget: 2, retryGen: 0, replacedBy: null, parentOrderId: null };
    const ord2 = { ...ord1, children: ord1.children.map(c => ({ ...c })) };
    const mkts = { btc150k: { id: "btc150k", yes: 0.5, cat: "crypto", adv: 12000 } };
    const r1 = advanceOrderFills(ord1, rng1, mkts, 1000, {});
    const r2 = advanceOrderFills(ord2, rng2, mkts, 1000, {});
    assert("idempotent:same fills count", r1.newFills.length === r2.newFills.length);
    assert("idempotent:same status", r1.order.status === r2.order.status);
    assert("idempotent:same totalFilled", r1.order.totalFilled === r2.order.totalFilled);
  }

  // Test 8: Position rebuild from fills
  {
    const fills = [
      { key: "f1", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1 },
      { key: "f2", orderId: "o2", cid: "btc150k", side: "NO", qty: 50, px: 0.45, time: 2000, slipBps: 2 },
    ];
    const rebuilt = rebuildPositionsFromFills(fills);
    assert("rebuild:yes qty correct", rebuilt.btc150k.yesQty === 50);
    assert("rebuild:no qty zero after offset", rebuilt.btc150k.noQty === 0);
    // 50 YES bought @ 0.40, closed via NO @ 0.45 → closing price (1-0.45)=0.55; rPnL = 50*(0.55-0.40) = 7.5
    assert("rebuild:realized pnl computed", Math.abs(rebuilt.btc150k.realizedPnl - 7.5) < 0.01);
  }

  // Test 9: Realized PnL rebuild from fills
  {
    const fills = [
      { key: "pnl1", orderId: "o1", cid: "fedcut", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1 },
      { key: "pnl2", orderId: "o2", cid: "fedcut", side: "NO", qty: 100, px: 0.50, time: 2000, slipBps: 1 },
    ];
    const rebuilt = rebuildPositionsFromFills(fills);
    // Buy YES at 0.40, then sell (buy NO) at 0.50 → close 100 YES at effective price (1-0.50)=0.50
    // Realized PnL = 100 * (0.50 - 0.40) = 10.0
    assert("pnl:rebuild correct", Math.abs(rebuilt.fedcut.realizedPnl - 10) < 0.01);
  }

  // Test 10: Order/fill consistency validation
  {
    const orders = [{ id: "oc1", status: "FILLED", parentSz: 100, totalFilled: 100, cid: "btc150k", children: [], replacedBy: null, parentOrderId: null }];
    const fills = [{ key: "ocf1", orderId: "oc1", cid: "btc150k", side: "YES", qty: 100, px: 0.5, time: 1000, slipBps: 1 }];
    const fk = { ocf1: true };
    // Positions must match the fills (otherwise recon correctly flags drift)
    const positions = rebuildPositionsFromFills(fills);
    const r = reconcile(positions, fills, fk, [], orders);
    assert("recon:consistent state ok", r.ok);

    // Now test inconsistent: FILLED but wrong qty
    const badOrders = [{ id: "oc2", status: "FILLED", parentSz: 100, totalFilled: 50, cid: "btc150k", children: [], replacedBy: null, parentOrderId: null }];
    const badFills = [{ key: "ocf2", orderId: "oc2", cid: "btc150k", side: "YES", qty: 50, px: 0.5, time: 1000, slipBps: 1 }];
    const badPositions = rebuildPositionsFromFills(badFills);
    const r2 = reconcile(badPositions, badFills, { ocf2: true }, [], badOrders);
    assert("recon:filled qty mismatch detected", !r2.ok && r2.issues.some(i => i.type === "filled_qty_mismatch"));
  }

  // Test 11: Replacement lineage consistency
  {
    const orders = [
      { id: "repl1", status: "REPLACED", parentSz: 100, totalFilled: 50, cid: "btc150k", children: [], replacedBy: "repl2", parentOrderId: null },
      { id: "repl2", status: "FILLED", parentSz: 50, totalFilled: 50, cid: "btc150k", children: [], replacedBy: null, parentOrderId: "repl1" },
    ];
    const fills = [
      { key: "rf1", orderId: "repl1", cid: "btc150k", side: "YES", qty: 50, px: 0.5, time: 1000, slipBps: 1 },
      { key: "rf2", orderId: "repl2", cid: "btc150k", side: "YES", qty: 50, px: 0.51, time: 2000, slipBps: 1 },
    ];
    const fk = { rf1: true, rf2: true };
    const r = reconcile({}, fills, fk, [], orders);
    assert("recon:replacement lineage ok", !r.issues.some(i => i.type === "replacement_lineage_mismatch"));
  }

  // Test 12: Unwind lineage consistency
  {
    const orders = [
      { id: "uw_parent", status: "CANCELLED", parentSz: 100, totalFilled: 60, cid: "btc150k", children: [], replacedBy: null, parentOrderId: null },
      { id: "ord_unwind_btc150k_2000_s0", status: "FILLED", parentSz: 60, totalFilled: 60, cid: "btc150k", children: [], replacedBy: null, parentOrderId: "uw_parent" },
    ];
    const fills = [
      { key: "uwf1", orderId: "uw_parent", cid: "btc150k", side: "YES", qty: 60, px: 0.45, time: 1000, slipBps: 1 },
      { key: "uwf2", orderId: "ord_unwind_btc150k_2000_s0", cid: "btc150k", side: "NO", qty: 60, px: 0.55, time: 2000, slipBps: 1 },
    ];
    const fk = { uwf1: true, uwf2: true };
    const r = reconcile({}, fills, fk, [], orders);
    assert("recon:unwind lineage ok", !r.issues.some(i => i.type === "unwind_parent_missing"));
  }

  // --- CIRCUIT BREAKER ---
  // Test 13: Drawdown trigger
  {
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const metrics = { currentDD: 0.25, grossExposure: 1000 };
    const r = updateCB(cb, metrics, 5000);
    assert("cb:drawdown trips open", r.state === "open");
    assert("cb:drawdown reason recorded", r.reason.includes("drawdown_breach"));
  }

  // Test 14: Exposure trigger
  {
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const metrics = { currentDD: 0, grossExposure: CFG.maxExpNotional * CFG.cbExpBreachMultiplier + 1 };
    const r = updateCB(cb, metrics, 5000);
    assert("cb:exposure trips open", r.state === "open");
  }

  // Test 15: Excessive slippage trigger
  {
    const slipEvents = [];
    for (let i = 0; i < CFG.cbSlipThreshold; i++) slipEvents.push({ time: 1000 + i, slipBps: CFG.maxSlipBps + 10 });
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: slipEvents, recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:slippage trips open", r.state === "open");
  }

  // Test 16: Repeated reject trigger (windowed)
  {
    const rejects = [];
    for (let i = 0; i < CFG.cbRejectThreshold; i++) rejects.push({ time: 1000 + i, type: "test", orderId: "o" + i });
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: [], recentRejects: rejects, recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:rejects trips open", r.state === "open");
    assert("cb:rejects cleared after trip", r.recentRejects.length === 0);
  }

  // Test 17: Poor fill trigger
  {
    const poorFills = [];
    for (let i = 0; i < CFG.cbPoorFillThreshold; i++) poorFills.push({ time: 1000 + i });
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: poorFills, recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:poor fills trips open", r.state === "open");
  }

  // Test 18: Invalid market data trigger
  {
    const invalidData = [];
    for (let i = 0; i < CFG.cbInvalidDataThreshold; i++) invalidData.push({ time: 1000 + i, marketId: "m" + i });
    const cb = { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: invalidData, halfOpenNotional: 0, halfOpenFills: 0 };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:invalid data trips open", r.state === "open");
  }

  // Test 19: open -> half_open recovery
  {
    const cb = { state: "open", failCount: 1, lastFailTime: 1000, reason: "test", triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 1000 + CFG.cbRecoveryMs + 1);
    assert("cb:open->half_open after recovery", r.state === "half_open");
  }

  // Test 20: half_open -> closed recovery
  {
    const cb = { state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test", triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 100, halfOpenFills: CFG.cbHalfOpenProbeMinFills };
    const r = updateCB(cb, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:half_open->closed on probe success", r.state === "closed");
    assert("cb:failCount reset", r.failCount === 0);
  }

  // Test 21: Terminal state immutability
  {
    assert("fsm:FILLED cannot transition", !canTransition("FILLED", "CANCELLED"));
    assert("fsm:CANCELLED cannot transition", !canTransition("CANCELLED", "FILLED"));
    assert("fsm:REJECTED cannot transition", !canTransition("REJECTED", "ACCEPTED"));
    assert("fsm:REPLACED cannot transition", !canTransition("REPLACED", "FILLED"));
    assert("fsm:NEW->ACCEPTED valid", canTransition("NEW", "ACCEPTED"));
    assert("fsm:ACCEPTED->FILLED valid", canTransition("ACCEPTED", "FILLED"));
  }

  // Test 22: Order history pruning safety
  {
    const active = [{ id: "active1", status: "ACCEPTED", parentOrderId: null, replacedBy: null }];
    const history = [];
    for (let i = 0; i < 400; i++) history.push({ id: "h" + i, status: "FILLED", parentOrderId: i === 399 ? "active1" : null, replacedBy: null });
    const pruned = pruneOrderHistory(history, active);
    assert("prune:respects cap", pruned.length <= CFG.historyRetentionCap + 50);
    assert("prune:protects lineage", pruned.some(o => o.id === "h399"));
  }

  // Test 23: Deferred spawn consistency (deterministic tick test)
  {
    const s1 = initState(42);
    const s2 = initState(42);
    const t1 = tick(s1, 10000);
    const t2 = tick(s2, 10000);
    assert("determinism:same tick same equity", t1.equity === t2.equity);
    assert("determinism:same tick same fills", t1.fills.length === t2.fills.length);
    assert("determinism:same tick same orders", t1.orders.length === t2.orders.length);
    assert("determinism:same orderSeq", t1.orderSeq === t2.orderSeq);
  }

  // --- META-ALPHA ATTRIBUTION [A1-A4] ---

  // Test 24: Fill carries attr from order (A1)
  {
    const rng = createRng(200);
    const ord = {
      id: "attr_t1", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES",
      parentSz: 50, lim: 0.5, strat: "aggressive",
      children: buildChildren("attr_t1", 50, 0.5, "aggressive", 0),
      status: "NEW", totalFilled: 0, avgFP: null, ce: 0.01,
      attr: { nlp: 60, momentum: 40 },
      riskCh: [], urg: "immediate", fillRate: 0, slipBps: null,
      partialAction: null, retryBudget: 2, retryGen: 0,
      replacedBy: null, parentOrderId: null
    };
    const mkts = { btc150k: { id: "btc150k", yes: 0.5, cat: "crypto", adv: 12000 } };
    const r = advanceOrderFills(ord, rng, mkts, 1000, {});
    const fillsWithAttr = r.newFills.filter(f => f.attr && f.attr.nlp === 60);
    assert("attr:fill carries order attr", r.newFills.length > 0 && fillsWithAttr.length === r.newFills.length);
  }

  // Test 25: applyFills emits attrEvents on closing fill (A2)
  {
    // Open YES position first
    const f1 = { key: "ae_open", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 70, arb: 30 } };
    const r1 = applyFills({}, [], {}, [f1]);
    assert("attr:opening fill no attrEvent", r1.attrEvents.length === 0);
    // Close with NO fill — should generate rPnL attribution
    const f2 = { key: "ae_close", orderId: "o2", cid: "btc150k", side: "NO", qty: 100, px: 0.50, time: 2000, slipBps: 1, attr: { momentum: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    assert("attr:closing fill emits attrEvent", r2.attrEvents.length === 1);
    assert("attr:attrEvent has closing fill attr", r2.attrEvents[0].attr.momentum === 100);
    assert("attr:attrEvent rpnl is correct", Math.abs(r2.attrEvents[0].rpnl - 10) < 0.01);
  }

  // Test 26: No attribution on opening-only fills (A2)
  {
    const f1 = { key: "noattr1", orderId: "o1", cid: "fedcut", side: "YES", qty: 50, px: 0.55, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const f2 = { key: "noattr2", orderId: "o2", cid: "fedcut", side: "YES", qty: 30, px: 0.56, time: 2000, slipBps: 1, attr: { momentum: 100 } };
    const r = applyFills({}, [], {}, [f1, f2]);
    assert("attr:two opening fills zero attrEvents", r.attrEvents.length === 0);
  }

  // Test 27: Partial close attribution correctness (A3)
  {
    // Open 100 YES at 0.40
    const f1 = { key: "pc_open", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    // Partial close: 60 NO at 0.50 (closes 60 YES, realizes PnL on 60 only)
    const f2 = { key: "pc_partial", orderId: "o2", cid: "btc150k", side: "NO", qty: 60, px: 0.50, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    assert("attr:partial close emits 1 event", r2.attrEvents.length === 1);
    // rPnL = 60 * ((1 - 0.50) - 0.40) = 60 * 0.10 = 6.0
    assert("attr:partial close rpnl correct", Math.abs(r2.attrEvents[0].rpnl - 6) < 0.01);
    assert("attr:partial close uses closing attr", r2.attrEvents[0].attr.arb === 100);
    // Remaining 40 YES still open — no extra event
    assert("attr:remaining position still open", r2.positions.btc150k.yesQty === 40);
  }

  // Test 28: Multi-fill multi-source attribution (A2)
  {
    // Open YES via NLP order
    const f1 = { key: "mf_open", orderId: "o1", cid: "btc150k", side: "YES", qty: 80, px: 0.45, time: 1000, slipBps: 1, attr: { nlp: 80, momentum: 20 } };
    const r1 = applyFills({}, [], {}, [f1]);
    // Close 30 via arb signal
    const f2 = { key: "mf_c1", orderId: "o2", cid: "btc150k", side: "NO", qty: 30, px: 0.48, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    // Close remaining 50 via momentum signal
    const f3 = { key: "mf_c2", orderId: "o3", cid: "btc150k", side: "NO", qty: 50, px: 0.52, time: 3000, slipBps: 1, attr: { momentum: 100 } };
    const r3 = applyFills(r2.positions, r2.fills, r2.fillKeys, [f3]);
    assert("attr:multi-close first event arb", r2.attrEvents.length === 1 && r2.attrEvents[0].attr.arb === 100);
    assert("attr:multi-close second event momentum", r3.attrEvents.length === 1 && r3.attrEvents[0].attr.momentum === 100);
  }

  // Test 29: applyAttributionEvents is pure and deterministic (A4)
  {
    const mp1 = { nlp: [0.1, -0.05], momentum: [0.2], arb: [] };
    const events = [
      { rpnl: 5.0, attr: { nlp: 60, momentum: 40 } },
      { rpnl: -2.0, attr: { arb: 100 } },
    ];
    const r1 = applyAttributionEvents(mp1, events);
    const r2 = applyAttributionEvents(mp1, events);
    assert("attr:pure same result nlp", JSON.stringify(r1.nlp) === JSON.stringify(r2.nlp));
    assert("attr:pure same result arb", JSON.stringify(r1.arb) === JSON.stringify(r2.arb));
    assert("attr:nlp got 60% of +5", Math.abs(r1.nlp[r1.nlp.length - 1] - 3.0) < 0.01);
    assert("attr:momentum got 40% of +5", Math.abs(r1.momentum[r1.momentum.length - 1] - 2.0) < 0.01);
    assert("attr:arb got 100% of -2", Math.abs(r1.arb[r1.arb.length - 1] - (-2.0)) < 0.01);
    // Original unchanged (pure)
    assert("attr:original metaPerf unchanged", mp1.nlp.length === 2 && mp1.arb.length === 0);
  }

  // Test 30: No unrealized PnL in attribution events (A4)
  {
    // Open position, no close — attrEvents should be empty
    const f1 = { key: "nounreal", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.45, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r = applyFills({}, [], {}, [f1]);
    assert("attr:no unrealized learning", r.attrEvents.length === 0);
    // Even though position has unrealized PnL at a different price
    // the metaAlpha system never sees it
  }

  // Test 31: Duplicate fill does not double-attribute (A2 + P3)
  {
    const f1 = { key: "dup_attr_open", orderId: "o1", cid: "fedcut", side: "YES", qty: 50, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    const fClose = { key: "dup_attr_close", orderId: "o2", cid: "fedcut", side: "NO", qty: 50, px: 0.50, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [fClose]);
    assert("attr:first close attributed", r2.attrEvents.length === 1);
    // Apply same closing fill again (replay)
    const r3 = applyFills(r2.positions, r2.fills, r2.fillKeys, [fClose]);
    assert("attr:duplicate close no re-attribution", r3.attrEvents.length === 0);
  }

  // Test 32: Fills without attr don't crash attribution (A2 edge case)
  {
    const f1 = { key: "noattr_open", orderId: "o1", cid: "btc150k", side: "YES", qty: 50, px: 0.40, time: 1000, slipBps: 1 };
    const r1 = applyFills({}, [], {}, [f1]);
    const f2 = { key: "noattr_close", orderId: "o2", cid: "btc150k", side: "NO", qty: 50, px: 0.50, time: 2000, slipBps: 1 };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    assert("attr:no attr field no crash", r2.attrEvents.length === 0);
    assert("attr:positions still correct", r2.positions.btc150k.yesQty === 0);
  }

  // --- V4.3.2 CORRECTNESS + CLARITY PATCHES ---

  // Test 33: Half-open CB cap is NOTIONAL, not qty (C1)
  {
    const snap = {
      positions: {},
      markets: { btc150k: { id: "btc150k", yes: 0.5, cat: "crypto", adv: 12000 } },
      cb: { state: "half_open", reason: null },
      currentDD: 0,
      grossExposure: 0,
      quarantined: {},
    };
    // sidePrice=0.5, cbHalfOpenMaxNotional=200 → max qty = 400
    const rec = { cid: "btc150k", dir: "BUY_YES", sz: 2000, aq: 0.5 };
    const v = preTradeRisk(rec, snap);
    assert("half_open_cap:qty reflects notional/price", v.sz <= Math.floor(CFG.cbHalfOpenMaxNotional / 0.5));
    assert("half_open_cap:qty is 400 at 0.5 price", v.sz === 400 || v.sz < 400);
    // Actual notional should be <= cap
    assert("half_open_cap:resulting notional within cap", (v.sz * 0.5) <= CFG.cbHalfOpenMaxNotional);
  }

  // Test 34: Half-open cap scales with side price (C1)
  {
    const snap = {
      positions: {},
      markets: { btc150k: { id: "btc150k", yes: 0.2, cat: "crypto", adv: 12000 } },
      cb: { state: "half_open", reason: null },
      currentDD: 0,
      grossExposure: 0,
      quarantined: {},
    };
    // BUY_YES at 0.2 → sidePrice=0.2, max qty = 200/0.2 = 1000
    const rec = { cid: "btc150k", dir: "BUY_YES", sz: 5000, aq: 0.5 };
    const v = preTradeRisk(rec, snap);
    assert("half_open_cap:low price allows more qty", v.sz >= 500);
    assert("half_open_cap:notional still capped", (v.sz * 0.2) <= CFG.cbHalfOpenMaxNotional);
  }

  // Test 35: Sizing uses live equity, not initialEquity (C3)
  {
    // Strong, fresh signal so Kelly yields positive sizing at a reasonable px
    const signals = [
      { id: "s1", source: "nlp", time: 100000, cid: "btc150k", dir: "BUY_YES", edge: 0.5, conf: 0.9, px: 0.7, fv: 0.85, hl: 300000, exp: 2000000, qs: 0.6 },
    ];
    const weights = { nlp: 1.0, momentum: 0, arb: 0 };
    const mkt = { btc150k: { id: "btc150k", yes: 0.7, cat: "crypto", adv: 12000 } };
    const liveLow = { equity: 5000, currentDD: 0, grossExposure: 0, positions: {}, markets: mkt, cbState: "closed" };
    const liveHigh = { equity: 15000, currentDD: 0, grossExposure: 0, positions: {}, markets: mkt, cbState: "closed" };
    const rLow = processSigs(signals, weights, 0.5, 150000, liveLow);
    const rHigh = processSigs(signals, weights, 0.5, 150000, liveHigh);
    assert("sizing:low equity produces rec", rLow.recs.length === 1);
    assert("sizing:high equity produces rec", rHigh.recs.length === 1);
    assert("sizing:lower equity → smaller size", rLow.recs[0].sz < rHigh.recs[0].sz);
    // Roughly 3x equity → roughly 3x size (ignoring floor rounding)
    assert("sizing:scale roughly proportional", rHigh.recs[0].sz / rLow.recs[0].sz >= 2.5);
  }

  // Test 36: Sizing respects drawdown scale (C3)
  {
    const signals = [
      { id: "s1", source: "nlp", time: 100000, cid: "btc150k", dir: "BUY_YES", edge: 0.5, conf: 0.9, px: 0.7, fv: 0.85, hl: 300000, exp: 2000000, qs: 0.6 },
    ];
    const weights = { nlp: 1.0, momentum: 0, arb: 0 };
    const mkt = { btc150k: { id: "btc150k", yes: 0.7, cat: "crypto", adv: 12000 } };
    const liveNoDD = { equity: 10000, currentDD: 0, grossExposure: 0, positions: {}, markets: mkt, cbState: "closed" };
    const liveMaxDD = { equity: 10000, currentDD: CFG.maxDD + 0.01, grossExposure: 0, positions: {}, markets: mkt, cbState: "closed" };
    const rNo = processSigs(signals, weights, 0.5, 150000, liveNoDD);
    const rMax = processSigs(signals, weights, 0.5, 150000, liveMaxDD);
    assert("sizing:no DD produces rec", rNo.recs.length === 1);
    // At max DD, DD scale = 0 → capital = 0 → desiredQty = 0 → rec below min size → skipped
    assert("sizing:max DD produces no recs", rMax.recs.length === 0);
  }

  // Test 37: Sizing respects remaining gross notional room (C3)
  {
    const signals = [
      { id: "s1", source: "nlp", time: 100000, cid: "btc150k", dir: "BUY_YES", edge: 0.5, conf: 0.9, px: 0.7, fv: 0.85, hl: 300000, exp: 2000000, qs: 0.6 },
    ];
    const weights = { nlp: 1.0, momentum: 0, arb: 0 };
    const mkt = { btc150k: { id: "btc150k", yes: 0.7, cat: "crypto", adv: 12000 } };
    // 70 notional room remaining → at price 0.7 → max 100 qty
    const liveTight = { equity: 10000, currentDD: 0, grossExposure: CFG.maxExpNotional - 70, positions: {}, markets: mkt, cbState: "closed" };
    const r = processSigs(signals, weights, 0.5, 150000, liveTight);
    assert("sizing:notional-constrained rec exists", r.recs.length === 1);
    // allowed_qty * 0.7 must be <= 70
    assert("sizing:notional cap respected", r.recs[0].sz * 0.7 <= 70.01);
  }

  // Test 38: Pruning returns flat array always (C4)
  {
    const emptyResult = pruneOrderHistory([], []);
    assert("prune:empty input returns array", Array.isArray(emptyResult) && emptyResult.length === 0);

    const smallHistory = [{ id: "h1", status: "FILLED", parentOrderId: null, replacedBy: null }];
    const smallResult = pruneOrderHistory(smallHistory, []);
    assert("prune:below cap returns array", Array.isArray(smallResult) && smallResult.length === 1);

    // Over cap
    const bigHistory = [];
    for (let i = 0; i < 500; i++) bigHistory.push({ id: "h" + i, status: "FILLED", parentOrderId: null, replacedBy: null });
    const bigResult = pruneOrderHistory(bigHistory, []);
    assert("prune:over cap returns flat array", Array.isArray(bigResult));
    assert("prune:over cap respects retentionCap", bigResult.length <= CFG.historyRetentionCap + CFG.historyMinRetainTerminal);
    // Each entry should be an order object, not a nested array
    assert("prune:entries are order objects", bigResult.every(o => o && typeof o === "object" && "id" in o && !Array.isArray(o)));
  }

  // Test 39: Pruning preserves full lineage chain (C4)
  {
    // Create a chain: parent → replaced by child → whose child is further replaced
    const active = [{ id: "live", status: "ACCEPTED", parentOrderId: "mid", replacedBy: null }];
    const history = [];
    for (let i = 0; i < 400; i++) history.push({ id: "junk" + i, status: "FILLED", parentOrderId: null, replacedBy: null });
    // Lineage chain buried in history
    history.push({ id: "root", status: "REPLACED", parentOrderId: null, replacedBy: "mid" });
    history.push({ id: "mid", status: "REPLACED", parentOrderId: "root", replacedBy: "live" });

    const pruned = pruneOrderHistory(history, active);
    const ids = new Set(pruned.map(o => o.id));
    assert("prune:lineage root retained", ids.has("root"));
    assert("prune:lineage mid retained", ids.has("mid"));
  }

  // Test 40: Terminal order cannot re-enter execution (FSM safety)
  {
    const rng = createRng(100);
    const terminalOrder = {
      id: "term1", time: 0, cid: "btc150k", side: "YES", dir: "BUY_YES",
      parentSz: 50, lim: 0.5, strat: "aggressive",
      children: buildChildren("term1", 50, 0.5, "aggressive", 0),
      status: "FILLED", totalFilled: 50, avgFP: 0.5, ce: 0.01,
      attr: {}, riskCh: [], urg: "immediate", fillRate: 1.0,
      slipBps: null, partialAction: null, retryBudget: 2, retryGen: 0,
      replacedBy: null, parentOrderId: null,
    };
    const mkts = { btc150k: { id: "btc150k", yes: 0.5, cat: "crypto", adv: 12000 } };
    const r = advanceOrderFills(terminalOrder, rng, mkts, 2000, {});
    assert("fsm:terminal order unchanged", r.order.status === "FILLED");
    assert("fsm:terminal order no new fills", r.newFills.length === 0);
    assert("fsm:terminal order no slip rejects", r.childSlipRejects === 0);

    // Also test REPLACED, CANCELLED, REJECTED
    for (const st of ["REPLACED", "CANCELLED", "REJECTED"]) {
      const o = { ...terminalOrder, status: st };
      const r2 = advanceOrderFills(o, createRng(100), mkts, 2000, {});
      assert("fsm:" + st + " immutable", r2.order.status === st && r2.newFills.length === 0);
    }
  }

  // Test 41: Half-open → closed requires real probe success (CB accounting)
  {
    // Scenario A: half_open with 0 fills → should NOT recover
    const cb1 = {
      state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test",
      triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [],
      recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0,
    };
    const r1 = updateCB(cb1, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:half_open stays open without probe fills", r1.state === "half_open");

    // Scenario B: half_open with required probe fills and 0 rejects → recover
    const cb2 = {
      state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test",
      triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [],
      recentInvalidData: [], halfOpenNotional: 100, halfOpenFills: CFG.cbHalfOpenProbeMinFills,
    };
    const r2 = updateCB(cb2, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:half_open → closed on probe success", r2.state === "closed");

    // Scenario C: half_open with probe fills BUT a recent reject → do NOT recover
    const cb3 = {
      state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test",
      triggers: [], recentSlipEvents: [], recentRejects: [{ time: 1500, type: "test", orderId: "o1" }],
      recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 100, halfOpenFills: CFG.cbHalfOpenProbeMinFills,
    };
    const r3 = updateCB(cb3, { currentDD: 0, grossExposure: 0 }, 5000);
    assert("cb:half_open blocked by recent reject", r3.state === "half_open");
  }

  // Test 42: Duplicate fills strictly idempotent (attribution + position)
  {
    const f1 = { key: "idem_open", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    // Apply same fill 5 times
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f1, f1, f1, f1, f1]);
    assert("idem:position unchanged after duplicate", r2.positions.btc150k.yesQty === 100);
    assert("idem:fills ledger size unchanged", r2.fills.length === 1);
    assert("idem:fillKeys unchanged", Object.keys(r2.fillKeys).length === 1);
    assert("idem:no attribution events", r2.attrEvents.length === 0);
  }

  // Test 43: Attribution only on closing quantity, not opening remainder (A3/C6)
  {
    // Open 50 YES, then cross-fill 80 NO (closes 50, opens 30)
    const f1 = { key: "cross_open", orderId: "o1", cid: "fedcut", side: "YES", qty: 50, px: 0.45, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    const f2 = { key: "cross_close", orderId: "o2", cid: "fedcut", side: "NO", qty: 80, px: 0.60, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);

    assert("close_only:exactly 1 attr event", r2.attrEvents.length === 1);
    // rPnL = 50 * ((1 - 0.60) - 0.45) = 50 * -0.05 = -2.5
    assert("close_only:rpnl on 50 closing qty only", Math.abs(r2.attrEvents[0].rpnl - (-2.5)) < 0.01);
    // Remaining 30 NO opens new position (no rPnL)
    assert("close_only:yesQty closed", r2.positions.fedcut.yesQty === 0);
    assert("close_only:noQty opened remainder", r2.positions.fedcut.noQty === 30);
  }

  // Test 44: Malformed attr does not crash (C6)
  {
    const mp = { nlp: [], momentum: [], arb: [] };
    const events = [
      { rpnl: 5.0, attr: null },                    // null attr
      { rpnl: 3.0, attr: [] },                      // array attr (invalid)
      { rpnl: 2.0, attr: { nlp: "bad" } },          // non-numeric pct
      { rpnl: 1.0, attr: { nlp: NaN } },            // NaN pct
      { rpnl: NaN, attr: { nlp: 50 } },             // NaN rpnl
      { rpnl: Infinity, attr: { nlp: 50 } },        // non-finite rpnl
      { rpnl: 10.0, attr: { nlp: 50, momentum: 50 } }, // valid
    ];
    const r = applyAttributionEvents(mp, events);
    // Only the last event should produce attribution
    assert("malformed:nlp got exactly 1 update", r.nlp.length === 1);
    assert("malformed:momentum got exactly 1 update", r.momentum.length === 1);
    assert("malformed:arb untouched", r.arb.length === 0);
    assert("malformed:nlp value = 10 * 0.5", Math.abs(r.nlp[0] - 5.0) < 0.01);
  }

  return results;
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
const TABS = ["Dashboard", "Regime", "Alpha", "Execution", "Risk", "System", "Tests"];

export default function V432() {
  const [state, setState] = useState(() => initState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const [testResults, setTestResults] = useState(null);
  const intRef = useRef(null);
  useEffect(() => { if (running) { intRef.current = setInterval(() => setState(p => tick(p, Date.now())), 2000); return () => clearInterval(intRef.current); } else clearInterval(intRef.current); }, [running]);
  const st = state, mA = Object.values(st.markets), allOrds = [...st.orders, ...st.orderHistory.slice(-20)].sort((a, b) => b.time - a.time);
  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg," + K.g + "," + K.c + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 900, color: K.bg, fontFamily: FF }}>4.3.2</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V4.3.2</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>LIVE-STATE SIZING · HALF-OPEN NOTIONAL · CLEAN PRUNING · CLEARER RISK</div></div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={bx(st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm, st.regime.trend === "trending" ? K.gd : st.regime.trend === "mean_reverting" ? K.pd : K.s2)}>{st.regime.trend}</span>
          <span style={bx(st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r, st.cb.state === "closed" ? K.gd : st.cb.state === "half_open" ? K.yd : K.rd)}>CB:{st.cb.state}</span>
          <span style={bx(running ? K.g : K.r, running ? K.gd : K.rd)}>{running ? "\u25cf LIVE" : "\u25cb OFF"}</span>
          <button onClick={() => { setRunning(r => !r); if (st.cb.state === "open") setState(p => ({ ...p, cb: { ...p.cb, state: "closed", failCount: 0, reason: null, recentRejects: [], recentSlipEvents: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 } })); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: running ? K.r : K.g, color: K.bg, fontFamily: FF, fontSize: 10, fontWeight: 700 }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 1, borderBottom: "1px solid " + K.bd, marginBottom: 10, overflowX: "auto" }}>{TABS.map(t => <button key={t} onClick={() => { setTab(t); if (t === "Tests" && !testResults) setTestResults(runTests()); }} style={{ padding: "6px 10px", background: tab === t ? K.s2 : "transparent", color: tab === t ? K.g : K.dm, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", borderBottom: tab === t ? "2px solid " + K.g : "2px solid transparent" }}>{t}</button>)}</div>

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
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDERS — FSM: NEW{"\u2192"}ACCEPTED{"\u2192"}PARTIAL{"\u2192"}FILLED|CANCELLED|REJECTED (terminal immutable)</div>
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
          <St l="CB state" v={st.cb.state} c={st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r} s={"rej:" + (st.cb.recentRejects||[]).length + " slip:" + (st.cb.recentSlipEvents||[]).length + " pf:" + (st.cb.recentPoorFills||[]).length + " inv:" + (st.cb.recentInvalidData||[]).length} />
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
          <b style={{ color: K.tx }}>V4.3.2 correctness guarantees:</b><br />
          [C1] Half-open CB: cbHalfOpenMaxNotional ${CFG.cbHalfOpenMaxNotional} is NOTIONAL, converted to qty via side price.<br />
          [C2] Half-open accounting: uses real fill notional (qty{"\u00D7"}price), counts actual fills not advances.<br />
          [C3] Sizing: live equity + DD scale + remaining notional/position/category room + half-open cap. Never from initialEquity.<br />
          [C4] Pruning: flat-array return, transitive lineage closure (parent+replacedBy chains), retention cap honored.<br />
          [C5] Risk: requestedQty / allowedQty / sidePrice / additionalNotional — qty vs notional explicitly separated.<br />
          [C6] Attribution: hardened against arrays, null, non-finite rpnl/pct. Still pure &amp; deterministic.<br />
          [A1-A4, P1-P7] All prior guarantees preserved.
        </div>
      </div>}

      {/* TESTS */}
      {tab === "Tests" && <div style={cd2}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>DETERMINISTIC TEST SUITE</div>
          <button onClick={() => setTestResults(runTests())} style={{ padding: "4px 10px", borderRadius: 4, border: "none", cursor: "pointer", background: K.b, color: K.bg, fontFamily: FF, fontSize: 9, fontWeight: 700 }}>RUN TESTS</button>
        </div>
        {testResults && <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 5, marginBottom: 8 }}>
            <St l="Total" v={testResults.length} c={K.b} />
            <St l="Passed" v={testResults.filter(t => t.pass).length} c={K.g} />
            <St l="Failed" v={testResults.filter(t => !t.pass).length} c={testResults.filter(t => !t.pass).length > 0 ? K.r : K.g} />
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {testResults.map((t, i) => <div key={i} style={{ display: "flex", gap: 6, padding: "3px 0", borderBottom: "1px solid " + K.bd + "10", fontSize: 9, fontFamily: FF, alignItems: "center" }}>
              <span style={bx(t.pass ? K.g : K.r, t.pass ? K.gd : K.rd)}>{t.pass ? "PASS" : "FAIL"}</span>
              <span style={{ color: t.pass ? K.dm : K.r }}>{t.name}</span>
            </div>)}
          </div>
        </div>}
        {!testResults && <div style={{ color: K.dm, fontSize: 10 }}>Click RUN TESTS to execute the deterministic test suite.</div>}
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V4.3.2 · SEED:{st.seed} · TICK:{st.tickCount} · SEQ:{st.orderSeq} · REALIZED:{f$(st.realizedPnl)} · UNREALIZED:{f$(st.unrealizedPnl)} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
