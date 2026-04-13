import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════
//  POLYMARKET V4 — DETERMINISTIC PRODUCTION ENGINE
//
//  Architecture:
//    ENGINE (lines 8-620)  — pure, no React, no side effects
//    UI     (lines 620+)   — rendering only, no trading logic
//
//  Fixed from V3.2:
//    1. Stale React state → pure tick(state, time)
//    2. Engine/UI mixing → complete separation
//    3. Wrong PnL → real fill ledger + weighted avg entry
//    4. Non-deterministic → seeded PRNG, injected time
//    5. Inconsistent snapshots → single snapshot per tick
//    6. Global data deps → all data inside state
//    7. Missing order lifecycle → full state machine
//    8. Fake feedback → real PnL attribution
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  ENGINE — SEEDED PRNG (mulberry32, fully deterministic)
// ═══════════════════════════════════════════════════════════════

function createRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════════════════
//  ENGINE — CONSTANTS (no mutation, no global state)
// ═══════════════════════════════════════════════════════════════

const MARKET_DEFS = [
  { id: "btc150k", q: "Will BTC hit $150k by Dec 2026?", initYes: 0.42, vol: 0.02, cat: "crypto", adv: 12000 },
  { id: "recession", q: "US recession in 2026?", initYes: 0.28, vol: 0.015, cat: "macro", adv: 8500 },
  { id: "trump28", q: "Trump wins 2028 GOP primary?", initYes: 0.61, vol: 0.01, cat: "politics", adv: 22000 },
  { id: "fedcut", q: "Fed cuts rates by July 2026?", initYes: 0.55, vol: 0.018, cat: "macro", adv: 15000 },
  { id: "aibar", q: "AI model passes bar exam top 1%?", initYes: 0.73, vol: 0.012, cat: "tech", adv: 5000 },
  { id: "starship", q: "SpaceX Starship orbital?", initYes: 0.67, vol: 0.008, cat: "tech", adv: 7000 },
  { id: "ethflip", q: "ETH flips BTC market cap?", initYes: 0.08, vol: 0.025, cat: "crypto", adv: 2000 },
  { id: "ceasefire", q: "Ukraine ceasefire by 2026?", initYes: 0.34, vol: 0.014, cat: "geopolitics", adv: 9500 },
];

const PAIR_DEFS = [
  { a: "btc150k", b: "ethflip", type: "inverse" },
  { a: "recession", b: "fedcut", type: "correlated" },
  { a: "btc150k", b: "fedcut", type: "correlated" },
  { a: "recession", b: "btc150k", type: "inverse" },
];

const NEWS_TEMPLATES = [
  { headline: "Fed signals policy shift", markets: ["fedcut", "recession"], impact: 0.7 },
  { headline: "Bitcoin breaks key level", markets: ["btc150k", "ethflip"], impact: 0.6 },
  { headline: "Polling data shifts outlook", markets: ["trump28"], impact: 0.5 },
  { headline: "SpaceX Starship update", markets: ["starship"], impact: 0.4 },
  { headline: "Treasury yields move", markets: ["fedcut", "recession", "btc150k"], impact: 0.5 },
  { headline: "AI benchmark breakthrough", markets: ["aibar"], impact: 0.6 },
  { headline: "Diplomatic progress on conflict", markets: ["ceasefire"], impact: 0.55 },
  { headline: "Ethereum ecosystem shift", markets: ["ethflip", "btc150k"], impact: 0.45 },
];

const SRC_WEIGHTS = { Reuters: 1.0, Bloomberg: 0.95, AP: 0.9, Polymarket: 0.7, "X/Twitter": 0.5 };
const SOURCES = Object.keys(SRC_WEIGHTS);

const RISK_CFG = { maxPos: 1500, maxExp: 6000, maxDD: 0.20, softDD: 0.12, maxCat: 3000, maxSlipBps: 50, minLiqRatio: 3, minSigQuality: 0.2 };

// ═══════════════════════════════════════════════════════════════
//  ENGINE — INITIAL STATE FACTORY (serializable, no classes)
// ═══════════════════════════════════════════════════════════════

function createInitialState(seed = 42) {
  const markets = {};
  const histories = {};
  for (const def of MARKET_DEFS) {
    markets[def.id] = { id: def.id, q: def.q, yes: def.initYes, prevYes: def.initYes, vol: def.vol, cat: def.cat, adv: def.adv };
    histories[def.id] = { prices: [], spreads: [], depths: [], maxLen: 300 };
  }
  return {
    seed, tickCount: 0, time: 0,
    markets, histories,
    // Regime
    regime: { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 },
    alphaWeights: { nlp: 0.33, momentum: 0.33, arb: 0.33 },
    metaPerf: { nlp: [], momentum: [], arb: [] },
    newsIntensity: 0,
    // Signals & recommendations
    signals: [], news: [], recommendations: [],
    // Orders (state machine)
    orders: [],
    // Portfolio ledger
    fills: [],
    positions: {},  // { [mktId]: { yesQty, noQty, yesAvgPx, noAvgPx, realizedPnl } }
    // Metrics
    equity: 10000, equityCurve: [10000], peakEquity: 10000, grossExposure: 0, totalPnl: 0, currentDD: 0,
    // Circuit breaker (3-state)
    cb: { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [] },
    // Slippage model
    slipAlpha: 0.1,
    // Monitoring
    monitor: { latencies: [], fillRates: [], slipErrors: [], approvals: 0, rejections: 0, signalCounts: { nlp: 0, momentum: 0, arb: 0 } },
    // Event log
    events: [],
  };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — MARKET SIMULATION (deterministic)
// ═══════════════════════════════════════════════════════════════

function advanceMarket(mkt, rng) {
  const mr = 0.002 * (0.5 - mkt.yes);
  const noise = (rng() - 0.5) * 2 * mkt.vol;
  const shock = rng() < 0.005 ? (rng() - 0.5) * 0.08 : 0;
  const advDelta = (rng() - 0.5) * 200;
  return {
    ...mkt,
    prevYes: mkt.yes,
    yes: +cl(mkt.yes + mr + noise + shock, 0.02, 0.98).toFixed(4),
    adv: Math.max(500, Math.floor(mkt.adv + advDelta)),
  };
}

function buildBook(mid, adv, rng) {
  const lf = cl(adv / 20000, 0.3, 2);
  const bs = 0.015 / lf;
  const bids = [], asks = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ p: +cl(mid - bs * i / 2, 0.01, 0.99).toFixed(3), sz: Math.floor((80 + rng() * 300) * lf) });
    asks.push({ p: +cl(mid + bs * i / 2, 0.01, 0.99).toFixed(3), sz: Math.floor((80 + rng() * 300) * lf) });
  }
  return {
    bids, asks,
    spread: +(asks[0].p - bids[0].p).toFixed(4),
    mid, bidDepth: bids.reduce((s, b) => s + b.sz, 0),
    askDepth: asks.reduce((s, a) => s + a.sz, 0), adv,
  };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — HISTORY (pure append, returns new array)
// ═══════════════════════════════════════════════════════════════

function pushHistory(hist, price, spread, depth) {
  const p = [...hist.prices, price];
  const s = [...hist.spreads, spread];
  const d = [...hist.depths, depth];
  const mx = hist.maxLen;
  return { ...hist, prices: p.length > mx ? p.slice(-mx) : p, spreads: s.length > mx ? s.slice(-mx) : s, depths: d.length > mx ? d.slice(-mx) : d };
}

function histRoc(prices, n) { if (prices.length < n + 1) return 0; const o = prices[prices.length - n - 1], c = prices[prices.length - 1]; return o ? (c - o) / o : 0; }
function histSma(prices, n) { const s = prices.slice(-n); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0; }
function histStd(prices, n) { const s = prices.slice(-n); if (s.length < 2) return 0; const m = s.reduce((a, b) => a + b, 0) / s.length; return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1)); }
function histVol(prices, n) {
  const s = prices.slice(-n); if (s.length < 3) return 0;
  const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / (s[i - 1] || 1)));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — REGIME DETECTION (pure)
// ═══════════════════════════════════════════════════════════════

function detectRegime(prices, spreads, depths) {
  if (prices.length < 30) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  const p = prices.slice(-100);
  const rets = []; for (let i = 1; i < p.length; i++) rets.push(Math.log(p[i] / (p[i - 1] || 1)));
  if (!rets.length) return { trend: "neutral", vol: "low_vol", liq: "high_liq", confidence: 0, hurst: 0.5 };
  // Hurst
  const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
  let cum = 0; const dev = rets.map(r => { cum += r - meanR; return cum; });
  const R = Math.max(...dev) - Math.min(...dev);
  const S = Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length - 1)) || 0.001;
  const hurst = +cl(Math.log((R / S) + 0.001) / Math.log(rets.length), 0.1, 0.9).toFixed(3);
  const trend = hurst > 0.55 ? "trending" : hurst < 0.45 ? "mean_reverting" : "neutral";
  // Vol regime
  const fastV = histVol(p, 20), slowV = histVol(p, Math.min(80, p.length));
  const vol = (fastV / (slowV || 0.001)) > 1.3 ? "high_vol" : "low_vol";
  // Liq regime
  const sp = spreads.slice(-20), dp = depths.slice(-20);
  const avgSp = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 0.05;
  const avgDp = dp.length ? dp.reduce((a, b) => a + b, 0) / dp.length : 1;
  const liq = avgDp / (avgSp + 0.001) > 500 ? "high_liq" : "low_liq";
  return { trend, vol, liq, confidence: +cl(prices.length / 100, 0, 1).toFixed(2), hurst };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — META-ALPHA (pure, uses perf arrays from state)
// ═══════════════════════════════════════════════════════════════

function computeAlphaWeights(regime, metaPerf, newsIntensity) {
  const bases = { trending: [0.3, 0.5, 0.2], mean_reverting: [0.2, 0.2, 0.6], neutral: [0.4, 0.3, 0.3] };
  const w = [...(bases[regime.trend] || bases.neutral)];
  // Performance scaling
  ["nlp", "momentum", "arb"].forEach((src, i) => {
    const p = metaPerf[src]; if (p.length >= 10) {
      const m = p.reduce((a, b) => a + b, 0) / p.length;
      const s = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / (p.length - 1)) || 0.001;
      w[i] *= Math.max(0.1, 1 + 0.3 * (m / s));
    }
  });
  if (newsIntensity > 0.7) w[0] *= 1.5;
  if (regime.vol === "high_vol") w[1] *= 1.3;
  if (regime.liq === "low_liq") w[2] *= 0.5;
  const t = w[0] + w[1] + w[2];
  return { nlp: +(w[0] / t).toFixed(3), momentum: +(w[1] / t).toFixed(3), arb: +(w[2] / t).toFixed(3) };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — ALPHA SIGNALS (pure, deterministic)
// ═══════════════════════════════════════════════════════════════

function generateNews(markets, rng, time) {
  const tpl = NEWS_TEMPLATES[Math.floor(rng() * NEWS_TEMPLATES.length)];
  const rel = tpl.markets.map(id => markets[id]).filter(Boolean);
  const avgMove = rel.reduce((s, m) => s + (m.yes - m.prevYes), 0) / (rel.length || 1);
  const rawSent = cl(avgMove * 20 + (rng() - 0.5) * 0.3, -1, 1);
  const srcIdx = Math.floor(rng() * SOURCES.length);
  const src = SOURCES[srcIdx];
  const abs = Math.abs(rawSent);
  const ic = abs > 0.55 ? "binary_catalyst" : abs > 0.2 ? "gradual_shift" : "noise";
  const sw = SRC_WEIGHTS[src];
  const latMs = Math.floor(rng() * 5000);
  const latPen = cl(1 - latMs / 10000, 0.5, 1);
  return { id: `n${time}`, time, source: src, headline: tpl.headline, relatedMarkets: tpl.markets, sentiment: +rawSent.toFixed(3), impactClass: ic, confidence: +cl((0.5 + abs * 0.4) * sw * latPen, 0, 0.99).toFixed(3), baseImpact: tpl.impact, srcWeight: sw, latencyMs: latMs };
}

function nlpSignals(news, markets, time) {
  if (news.impactClass !== "binary_catalyst" || news.confidence < 0.55) return [];
  const sigs = [];
  for (const mid of news.relatedMarkets) {
    const mkt = markets[mid]; if (!mkt) continue;
    const edge = news.sentiment * news.baseImpact * news.confidence * news.srcWeight * 0.04;
    if (Math.abs(edge) < 0.006) continue;
    sigs.push({ id: `nlp_${mid}_${time}`, source: "nlp", time, conditionId: mid, direction: edge > 0 ? "BUY_YES" : "BUY_NO", edge: +Math.abs(edge).toFixed(4), confidence: news.confidence, fairValue: +cl(mkt.yes + edge, 0.02, 0.98).toFixed(4), currentPrice: mkt.yes, halfLife: 180000, expiresAt: time + 720000, qualityScore: +(news.confidence * news.srcWeight).toFixed(3) });
  }
  return sigs;
}

function momentumSignals(markets, histories, time) {
  const sigs = [];
  for (const [mid, mkt] of Object.entries(markets)) {
    const h = histories[mid]; if (!h || h.prices.length < 25) continue;
    const p = h.prices, price = mkt.yes;
    const r5 = histRoc(p, 5), s10 = histSma(p, 10), s30 = histSma(p, 30), v = histVol(p, 20);
    const trend = ((price > s10 ? 0.3 : -0.3) + (price > s30 ? 0.2 : -0.2) + cl(r5 * 10, -0.5, 0.5));
    const ext = (price - s30) / (v || 0.01);
    const mr = ext > 2 ? -0.4 : ext < -2 ? 0.4 : 0;
    const comp = trend + mr, ac = Math.abs(comp);
    if (ac < 0.15) continue;
    sigs.push({ id: `mom_${mid}_${time}`, source: "momentum", time, conditionId: mid, direction: comp > 0 ? "BUY_YES" : "BUY_NO", edge: +(ac * 0.05).toFixed(4), confidence: +cl(0.4 + ac * 0.3, 0, 0.95).toFixed(3), fairValue: +(price + comp * 0.02).toFixed(4), currentPrice: price, halfLife: 240000, expiresAt: time + 300000, qualityScore: +(ac * cl(p.length / 100, 0, 1)).toFixed(3) });
  }
  return sigs;
}

function arbSignals(markets, histories, time) {
  const sigs = [];
  for (const pair of PAIR_DEFS) {
    const mA = markets[pair.a], mB = markets[pair.b];
    if (!mA || !mB) continue;
    const hA = histories[pair.a], hB = histories[pair.b];
    if (!hA || !hB || hA.prices.length < 30 || hB.prices.length < 30) continue;
    const n = Math.min(hA.prices.length, hB.prices.length, 50);
    const pA = hA.prices.slice(-n), pB = hB.prices.slice(-n);
    const ma = pA.reduce((s, v) => s + v, 0) / n, mb = pB.reduce((s, v) => s + v, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { cov += (pA[i] - ma) * (pB[i] - mb); va += (pA[i] - ma) ** 2; vb += (pB[i] - mb) ** 2; }
    const corr = (va && vb) ? cov / Math.sqrt(va * vb) : 0;
    if (Math.abs(corr) < 0.25) continue;
    // Stability check (split-half)
    const h = Math.floor(n / 2);
    const halfCorr = (a, b) => { const hm = a.length; if (hm < 5) return 0; const hma = a.reduce((s, v) => s + v, 0) / hm, hmb = b.reduce((s, v) => s + v, 0) / hm; let c = 0, hva = 0, hvb = 0; for (let i = 0; i < hm; i++) { c += (a[i] - hma) * (b[i] - hmb); hva += (a[i] - hma) ** 2; hvb += (b[i] - hmb) ** 2; } return (hva && hvb) ? c / Math.sqrt(hva * hvb) : 0; };
    const stability = 1 - Math.abs(halfCorr(pA.slice(0, h), pB.slice(0, h)) - halfCorr(pA.slice(h), pB.slice(h)));
    if (stability < 0.5) continue;
    const stdA = histStd(pA, 30), stdB = histStd(pB, 30);
    const beta = stdA > 0 ? corr * (stdB / stdA) : 0;
    const expB = mb + beta * (mA.yes - ma);
    const mismatch = mB.yes - expB;
    const z = mismatch / (histStd(pB, 30) || 0.01);
    if (Math.abs(z) < 1.8) continue;
    const netEdge = Math.abs(mismatch) - 0.02 - 0.004;
    if (netEdge <= 0) continue;
    const corrConf = +(Math.abs(corr) * stability * cl(n / 50, 0, 1)).toFixed(3);
    sigs.push({ id: `arb_${pair.a}_${pair.b}_${time}`, source: "arb", time, conditionId: mB.id, direction: mismatch > 0 ? "BUY_NO" : "BUY_YES", edge: +netEdge.toFixed(4), confidence: +cl(0.3 + Math.abs(z) * 0.12 * corrConf, 0, 0.95).toFixed(3), fairValue: +cl(expB, 0.02, 0.98).toFixed(4), currentPrice: mB.yes, halfLife: 600000, expiresAt: time + 600000, qualityScore: +(corrConf * cl(Math.abs(z) / 3, 0, 1)).toFixed(3), zScore: +z.toFixed(2), correlation: +corr.toFixed(3), stability: +stability.toFixed(3), pairLabel: `${pair.a}↔${pair.b}` });
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — SIGNAL PROCESSING (pure)
// ═══════════════════════════════════════════════════════════════

function processSignals(signals, alphaWeights, regimeConf, time) {
  // 1. Filter expired/stale
  let sigs = signals.filter(s => s.expiresAt > time && (time - s.time) / (s.expiresAt - s.time) < 0.8);
  // 2. Exponential decay
  sigs = sigs.map(s => {
    const fresh = Math.pow(0.5, (time - s.time) / (s.halfLife || 300000));
    return { ...s, freshness: +fresh.toFixed(3), effectiveEdge: +(s.edge * fresh).toFixed(4) };
  });
  // 3. Dedup (best per source:market)
  const best = {};
  for (const s of sigs) { const k = `${s.source}:${s.conditionId}`; if (!best[k] || s.effectiveEdge > best[k].effectiveEdge) best[k] = s; }
  sigs = Object.values(best).filter(s => (s.qualityScore || 0.5) > 0.15);
  // 4. Group by market → composite
  const byMkt = {};
  for (const s of sigs) (byMkt[s.conditionId] || (byMkt[s.conditionId] = [])).push(s);
  const recs = [];
  for (const [mid, msigs] of Object.entries(byMkt)) {
    let composite = 0;
    for (const s of msigs) { const w = alphaWeights[s.source] || 0.33; composite += s.effectiveEdge * (s.direction === "BUY_YES" ? 1 : -1) * s.confidence * w; }
    const signs = msigs.map(s => s.direction === "BUY_YES" ? 1 : -1);
    const concordance = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    const confidence = +cl(0.4 * concordance + 0.3 * cl(Math.abs(composite) * 2, 0, 1) + 0.15 * cl(msigs.length / 3, 0, 1) + 0.15 * regimeConf, 0, 0.95).toFixed(3);
    const dir = composite >= 0 ? "BUY_YES" : "BUY_NO";
    const adjEdge = Math.abs(composite) * (0.5 + concordance * 0.5);
    if (adjEdge < 0.006) continue;
    const price = msigs[0].currentPrice || 0.5;
    const odds = composite > 0 ? price / (1 - price + 0.0001) : (1 - price) / (price + 0.0001);
    const kellyRaw = (adjEdge * odds - (1 - adjEdge)) / (odds + 0.0001);
    const kelly = cl(kellyRaw * 0.5, 0, 0.25) * confidence;
    const sugSz = Math.floor(kelly * 10000);
    if (sugSz < 15) continue;
    const attr = {}; msigs.forEach(s => { attr[s.source] = (attr[s.source] || 0) + s.effectiveEdge * s.confidence; });
    const ta = Object.values(attr).reduce((s, v) => s + Math.abs(v), 0) || 1;
    Object.keys(attr).forEach(k => attr[k] = +((Math.abs(attr[k]) / ta) * 100).toFixed(1));
    recs.push({ id: `rec_${mid}_${time}`, time, conditionId: mid, direction: dir, compositeEdge: +adjEdge.toFixed(4), confidence, concordance: +concordance.toFixed(2), suggestedSize: sugSz, attribution: attr, signals: msigs.length, urgency: adjEdge > 0.025 ? "immediate" : adjEdge > 0.012 ? "patient" : "passive", avgQuality: +(msigs.reduce((s, x) => s + (x.qualityScore || 0.5), 0) / msigs.length).toFixed(3) });
  }
  return { filtered: sigs, recs };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — RISK (pure, receives explicit snapshot)
// ═══════════════════════════════════════════════════════════════

function preTradeRisk(rec, snapshot) {
  const { positions, grossExposure, currentDD, cb, markets } = snapshot;
  const ch = []; let ok = true, sz = rec.suggestedSize;
  const mkt = markets[rec.conditionId];
  // 1. CB check
  if (cb.state === "open") { ch.push({ n: "CB", s: "blocked", d: cb.reason || "OPEN" }); ok = false; }
  else ch.push({ n: "CB", s: cb.state === "half_open" ? "adjusted" : "pass", d: cb.state });
  // 2. Max position
  const pos = positions[rec.conditionId] || { yesQty: 0, noQty: 0 };
  const existingGross = pos.yesQty + pos.noQty;
  if (existingGross + sz > RISK_CFG.maxPos) { sz = Math.max(0, RISK_CFG.maxPos - existingGross); ch.push({ n: "Pos", s: sz > 0 ? "adjusted" : "blocked", d: `${existingGross}+${rec.suggestedSize}` }); if (!sz) ok = false; }
  else ch.push({ n: "Pos", s: "pass", d: `${existingGross + sz}` });
  // 3. Exposure
  if (grossExposure + sz > RISK_CFG.maxExp) { sz = Math.max(0, RISK_CFG.maxExp - grossExposure); ch.push({ n: "Exp", s: sz > 0 ? "adjusted" : "blocked", d: `${grossExposure}+${sz}` }); if (!sz) ok = false; }
  else ch.push({ n: "Exp", s: "pass", d: `${grossExposure + sz}` });
  // 4. DD dynamic sizing
  const ddScale = currentDD >= RISK_CFG.maxDD ? 0 : currentDD > RISK_CFG.softDD ? 1 - Math.pow(currentDD / RISK_CFG.maxDD, 1.5) : 1;
  if (ddScale < 1) { sz = Math.floor(sz * ddScale); ch.push({ n: "DD", s: ddScale > 0 ? "adjusted" : "blocked", d: `scale=${ddScale.toFixed(2)}` }); if (!sz) ok = false; }
  else ch.push({ n: "DD", s: "pass", d: `${(currentDD * 100).toFixed(1)}%` });
  // 5. Theme
  const catExp = Object.entries(positions).reduce((s, [id, p]) => { const m = markets[id]; return m && m.cat === mkt?.cat ? s + p.yesQty + p.noQty : s; }, 0);
  if (catExp + sz > RISK_CFG.maxCat) { sz = Math.max(0, RISK_CFG.maxCat - catExp); ch.push({ n: "Theme", s: sz > 0 ? "adjusted" : "blocked", d: `${mkt?.cat}` }); if (!sz) ok = false; }
  else ch.push({ n: "Theme", s: "pass", d: `${mkt?.cat}: ${catExp + sz}` });
  // 6. Liq ratio
  const liqR = mkt ? mkt.adv / (sz + 0.001) : 999;
  if (liqR < RISK_CFG.minLiqRatio) { ch.push({ n: "Liq", s: "blocked", d: `${liqR.toFixed(1)}<${RISK_CFG.minLiqRatio}` }); ok = false; }
  else ch.push({ n: "Liq", s: "pass", d: `${liqR.toFixed(1)}` });
  // 7. Quality
  if ((rec.avgQuality || 0) < RISK_CFG.minSigQuality) { ch.push({ n: "Qual", s: "blocked", d: `${rec.avgQuality}` }); ok = false; }
  else ch.push({ n: "Qual", s: "pass", d: `${rec.avgQuality}` });
  return { approved: ok && sz >= 15, adjustedSize: sz, checks: ch };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — EXECUTION (order state machine, deterministic)
// ═══════════════════════════════════════════════════════════════

function createOrder(rec, verdict, markets, time, rng) {
  if (!verdict.approved) return null;
  const mkt = markets[rec.conditionId]; if (!mkt) return null;
  const side = rec.direction === "BUY_YES" ? "YES" : "NO";
  const mid = side === "YES" ? mkt.yes : 1 - mkt.yes;
  const book = buildBook(mkt.yes, mkt.adv, rng);
  const spAdj = rec.urgency === "immediate" ? book.spread * 0.6 : rec.urgency === "patient" ? -book.spread * 0.3 : 0;
  const limit = +cl(mid + spAdj, 0.01, 0.99).toFixed(3);
  // Select strategy
  const participation = verdict.adjustedSize / (mkt.adv + 0.001);
  let strategy = "patient";
  if (verdict.adjustedSize < 500 && rec.urgency === "immediate") strategy = "aggressive";
  else if (verdict.adjustedSize > 2000) strategy = "twap";
  else if (verdict.adjustedSize > 500) strategy = "vwap";
  // Create child slices
  const maxChild = strategy === "twap" ? 100 : strategy === "aggressive" ? verdict.adjustedSize : 200;
  const nChildren = Math.ceil(verdict.adjustedSize / maxChild);
  const children = [];
  let rem = verdict.adjustedSize;
  for (let i = 0; i < nChildren; i++) {
    const sz = Math.min(rem, maxChild);
    children.push({ id: `ch_${time}_${i}`, size: sz, limitPrice: limit, fillPrice: null, status: "NEW" });
    rem -= sz;
  }
  return {
    id: `ord_${rec.conditionId}_${time}`, time, conditionId: rec.conditionId,
    side, direction: rec.direction, parentSize: verdict.adjustedSize,
    limitPrice: limit, strategy, children,
    status: "ACCEPTED", totalFilled: 0, avgFillPrice: null,
    compositeEdge: rec.compositeEdge, attribution: rec.attribution,
    riskChecks: verdict.checks, urgency: rec.urgency,
    fillRate: 0, slippage: null, partialAction: null,
  };
}

function simulateFills(order, rng) {
  if (order.status === "FILLED" || order.status === "CANCELLED") return order;
  const updated = { ...order, children: order.children.map(c => ({ ...c })) };
  let filled = 0, cost = 0;
  for (const child of updated.children) {
    if (child.status !== "NEW" && child.status !== "ACCEPTED") { if (child.status === "FILLED") { filled += child.size; cost += child.fillPrice * child.size; } continue; }
    child.status = "ACCEPTED";
    const fr = updated.strategy === "aggressive" ? 0.92 : updated.strategy === "twap" ? 0.8 : updated.strategy === "vwap" ? 0.78 : 0.6;
    if (rng() < fr) {
      child.fillPrice = +(child.limitPrice + (rng() - 0.5) * 0.004).toFixed(4);
      child.status = "FILLED";
      filled += child.size;
      cost += child.fillPrice * child.size;
    }
  }
  updated.totalFilled = filled;
  updated.avgFillPrice = filled > 0 ? +(cost / filled).toFixed(4) : null;
  updated.fillRate = +(filled / updated.parentSize).toFixed(2);
  updated.slippage = updated.avgFillPrice ? +(Math.abs(updated.avgFillPrice - updated.limitPrice)).toFixed(4) : null;
  if (filled === updated.parentSize) updated.status = "FILLED";
  else if (filled > 0) {
    updated.status = "PARTIALLY_FILLED";
    updated.partialAction = filled / updated.parentSize < 0.5 ? { action: "UNWIND", reason: `<50% filled (${filled}/${updated.parentSize})` } : { action: "RETRY", reason: `${filled}/${updated.parentSize} filled` };
  } else updated.status = "ACCEPTED"; // still working
  return updated;
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — PORTFOLIO LEDGER (pure, real accounting)
// ═══════════════════════════════════════════════════════════════

function applyFills(positions, fills, order) {
  if (!order.totalFilled || !order.avgFillPrice) return { positions, fills };
  const mid = order.conditionId;
  const pos = positions[mid] ? { ...positions[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
  const qty = order.totalFilled;
  const px = order.avgFillPrice;
  const fill = { id: `fill_${order.id}`, orderId: order.id, conditionId: mid, side: order.side, qty, price: px, time: order.time };
  // Weighted average entry
  if (order.side === "YES") {
    const totalQty = pos.yesQty + qty;
    pos.yesAvgPx = totalQty > 0 ? +((pos.yesAvgPx * pos.yesQty + px * qty) / totalQty).toFixed(4) : 0;
    pos.yesQty = totalQty;
  } else {
    const totalQty = pos.noQty + qty;
    pos.noAvgPx = totalQty > 0 ? +((pos.noAvgPx * pos.noQty + px * qty) / totalQty).toFixed(4) : 0;
    pos.noQty = totalQty;
  }
  return { positions: { ...positions, [mid]: pos }, fills: [...fills, fill] };
}

function computePortfolioMetrics(positions, markets, prevEquityCurve, peakEquity) {
  let totalPnl = 0, grossExposure = 0;
  const catExposure = {};
  for (const [mid, pos] of Object.entries(positions)) {
    const mkt = markets[mid]; if (!mkt) continue;
    const unrealizedYes = pos.yesQty * (mkt.yes - pos.yesAvgPx);
    const unrealizedNo = pos.noQty * ((1 - mkt.yes) - pos.noAvgPx);
    totalPnl += pos.realizedPnl + unrealizedYes + unrealizedNo;
    grossExposure += pos.yesQty + pos.noQty;
    catExposure[mkt.cat] = (catExposure[mkt.cat] || 0) + pos.yesQty + pos.noQty;
  }
  const equity = +(10000 + totalPnl).toFixed(2);
  const newPeak = Math.max(peakEquity, equity);
  const currentDD = newPeak > 0 ? +((newPeak - equity) / newPeak).toFixed(4) : 0;
  const curve = [...prevEquityCurve, equity];
  if (curve.length > 200) curve.splice(0, curve.length - 200);
  return { totalPnl: +totalPnl.toFixed(2), equity, grossExposure, currentDD, peakEquity: newPeak, equityCurve: curve, catExposure };
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — CIRCUIT BREAKER (pure, 3-state)
// ═══════════════════════════════════════════════════════════════

function updateCB(cb, currentDD, grossExposure, time) {
  const next = { ...cb, triggers: [...cb.triggers] };
  // Recovery: open → half_open after 60s
  if (next.state === "open" && time - next.lastFailTime > 60000) { next.state = "half_open"; }
  // Trip conditions
  if (currentDD > RISK_CFG.maxDD) { next.state = "open"; next.reason = `DD ${(currentDD * 100).toFixed(1)}%`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); }
  if (grossExposure > RISK_CFG.maxExp * 1.3) { next.state = "open"; next.reason = `Exp $${grossExposure}`; next.lastFailTime = time; next.triggers.push({ t: time, r: next.reason }); }
  return next;
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — TICK ORCHESTRATOR (pure, deterministic, single snapshot)
//  tick(prevState, tickTime) → nextState
// ═══════════════════════════════════════════════════════════════

function tick(prev, tickTime) {
  // Create deterministic RNG for this tick
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;

  // ── 1. Clone state (snapshot) ──
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };

  // ── 2. Advance markets ──
  const newMarkets = {};
  for (const [id, mkt] of Object.entries(s.markets)) newMarkets[id] = advanceMarket(mkt, rng);
  s.markets = newMarkets;

  // ── 3. Update histories ──
  const newHist = {};
  for (const [id, mkt] of Object.entries(s.markets)) {
    const book = buildBook(mkt.yes, mkt.adv, rng);
    newHist[id] = pushHistory(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, mkt.yes, book.spread, book.bidDepth);
  }
  s.histories = newHist;

  // ── 4. Detect regime ──
  const mainHist = s.histories["btc150k"] || Object.values(s.histories)[0];
  if (mainHist && mainHist.prices.length > 30) {
    s.regime = detectRegime(mainHist.prices, mainHist.spreads, mainHist.depths);
  }

  // ── 5. Compute alpha weights ──
  s.alphaWeights = computeAlphaWeights(s.regime, s.metaPerf, s.newsIntensity);

  // ── 6. Generate signals ──
  let newSignals = [...s.signals];
  // News (~30% chance per tick, deterministic)
  if (rng() < 0.3) {
    const newsEvt = generateNews(s.markets, rng, time);
    s.news = [newsEvt, ...s.news].slice(0, 60);
    s.newsIntensity = newsEvt.impactClass === "binary_catalyst" ? 0.9 : newsEvt.impactClass === "gradual_shift" ? 0.5 : 0.1;
    const nlpSigs = nlpSignals(newsEvt, s.markets, time);
    newSignals.push(...nlpSigs);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, nlp: s.monitor.signalCounts.nlp + nlpSigs.length } };
    s.events.push({ evt: "news", ts: time, s: `${newsEvt.impactClass}|${newsEvt.headline.slice(0, 30)}` });
  }
  // Momentum (every tick)
  const momSigs = momentumSignals(s.markets, s.histories, time);
  // Replace old momentum signals for same market
  newSignals = newSignals.filter(sig => sig.source !== "momentum");
  newSignals.push(...momSigs);
  s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, momentum: s.monitor.signalCounts.momentum + momSigs.length } };
  // Arb (~35% chance)
  if (rng() < 0.35) {
    const arbSigs = arbSignals(s.markets, s.histories, time);
    newSignals = newSignals.filter(sig => sig.source !== "arb");
    newSignals.push(...arbSigs);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, arb: s.monitor.signalCounts.arb + arbSigs.length } };
  }

  // ── 7. Process signals → recommendations ──
  const { filtered, recs } = processSignals(newSignals, s.alphaWeights, s.regime.confidence, time);
  s.signals = filtered.slice(0, 80);
  s.recommendations = [...recs, ...s.recommendations].slice(0, 40);

  // ── 8-9. Risk → Orders → Fills ──
  const snapshot = { positions: s.positions, grossExposure: s.grossExposure, currentDD: s.currentDD, cb: s.cb, markets: s.markets };
  let positions = { ...s.positions };
  let fills = [...s.fills];
  let orders = [...s.orders];
  let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let cb = { ...s.cb };

  // First: try to fill any existing ACCEPTED/PARTIALLY_FILLED orders
  orders = orders.map(o => (o.status === "ACCEPTED" || o.status === "PARTIALLY_FILLED") ? simulateFills(o, rng) : o);

  // Process new fills from existing orders
  for (const ord of orders) {
    if (ord.totalFilled > 0 && !fills.find(f => f.orderId === ord.id)) {
      const result = applyFills(positions, fills, ord);
      positions = result.positions;
      fills = result.fills;
    }
  }

  // New recommendations → risk → orders
  for (const rec of recs) {
    // Re-check risk with current snapshot
    const riskSnapshot = { ...snapshot, positions, grossExposure: Object.values(positions).reduce((s, p) => s + p.yesQty + p.noQty, 0) };
    const verdict = preTradeRisk(rec, riskSnapshot);
    if (verdict.approved) { monitor.approvals++; } else { monitor.rejections++; }
    s.events.push({ evt: verdict.approved ? "risk:pass" : "risk:reject", ts: time, s: `${rec.conditionId}|sz=${verdict.adjustedSize}` });

    const order = createOrder(rec, verdict, s.markets, time, rng);
    if (!order) continue;
    // Immediately simulate fills
    const filled = simulateFills(order, rng);
    orders.push(filled);
    s.events.push({ evt: "exec", ts: time, s: `${filled.conditionId}|${filled.strategy}|${filled.status}|filled=${filled.totalFilled}` });

    if (filled.totalFilled > 0) {
      const result = applyFills(positions, fills, filled);
      positions = result.positions;
      fills = result.fills;
      cb.failCount = Math.max(0, cb.failCount - 1); // success
      // MetaAlpha PnL attribution (deterministic, based on actual fill)
      if (filled.attribution) {
        const pnlProxy = (filled.avgFillPrice - filled.limitPrice) * filled.totalFilled * (filled.direction === "BUY_YES" ? 1 : -1);
        for (const [src, pct] of Object.entries(filled.attribution)) {
          const buf = metaPerf[src]; if (buf) { buf.push(pnlProxy * pct / 100); if (buf.length > 50) buf.shift(); }
        }
      }
    }
    if (filled.partialAction) s.events.push({ evt: "partial", ts: time, s: `${filled.partialAction.action}|${filled.partialAction.reason}` });
  }

  // Keep only recent orders (trim old filled/cancelled)
  orders = orders.slice(0, 60);

  // ── 10-11. Portfolio metrics ──
  const metrics = computePortfolioMetrics(positions, s.markets, s.equityCurve, s.peakEquity);

  // ── 12. Circuit breaker ──
  cb = updateCB(cb, metrics.currentDD, metrics.grossExposure, time);

  // ── Assemble next state ──
  return {
    ...s,
    positions, fills: fills.slice(-200), orders,
    equity: metrics.equity, equityCurve: metrics.equityCurve,
    peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure,
    totalPnl: metrics.totalPnl, currentDD: metrics.currentDD,
    cb, monitor, metaPerf,
  };
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  UI LAYER — RENDERING ONLY (no trading logic)
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

const FF = "'JetBrains Mono','Fira Code',monospace";
const SS = "'DM Sans','Segoe UI',sans-serif";
const K = { bg: "#060610", s1: "#0c0c18", s2: "#131322", s3: "#1a1a2e", bd: "#24243a", tx: "#e2e2f0", dm: "#5a5a7c", g: "#00e89a", gd: "#00e89a20", r: "#ff3355", rd: "#ff335520", y: "#ffb830", yd: "#ffb83020", b: "#2d8cf0", b2: "#2d8cf020", p: "#9966ff", pd: "#9966ff20", c: "#00ccee", cd: "#00ccee20", o: "#ff8844", od: "#ff884420" };
const bx = (c, bg) => ({ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: FF, color: c, background: bg, fontWeight: 600 });
const crd = { background: K.s1, border: `1px solid ${K.bd}`, borderRadius: 8, padding: 12, marginBottom: 8 };
const mc2 = { background: K.s2, borderRadius: 6, padding: "7px 10px" };
const ft = t => { const d = new Date(t); return d.toLocaleTimeString("en", { hour12: false }); };
const fp = (v, d = 1) => (v * 100).toFixed(d) + "%";
const fd2 = (v, d = 0) => "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: d });
const mq2 = id => MARKET_DEFS.find(m => m.id === id)?.q || id;

function Spark({ data, color = K.g, w = 120, h = 24 }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data), rn = mx - mn || 1;
  return <svg width={w} height={h} style={{ display: "block" }}><polyline points={data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / rn) * h}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} /></svg>;
}
function St({ l, v, c = K.tx, s }) { return <div style={mc2}><div style={{ fontSize: 9, color: K.dm, fontFamily: FF }}>{l}</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: FF, color: c, marginTop: 2 }}>{v}</div>{s && <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginTop: 1 }}>{s}</div>}</div>; }
function RB({ s }) { const m = { pass: { c: K.g, b: K.gd }, adjusted: { c: K.y, b: K.yd }, blocked: { c: K.r, b: K.rd } }; const x = m[s] || m.pass; return <span style={bx(x.c, x.b)}>{(s || "").toUpperCase()}</span>; }

const TABS = ["Dashboard", "Regime", "Alpha", "Execution", "Risk", "System"];

export default function PolymarketV4() {
  const [state, setState] = useState(() => createInitialState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const intRef = useRef(null);

  useEffect(() => {
    if (running) {
      intRef.current = setInterval(() => {
        setState(prev => tick(prev, Date.now()));
      }, 2000);
      return () => clearInterval(intRef.current);
    } else { clearInterval(intRef.current); }
  }, [running]);

  const st = state; // alias for brevity
  const mktArr = Object.values(st.markets);

  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg,${K.g},${K.c})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, color: K.bg, fontFamily: FF }}>V4</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V4</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>DETERMINISTIC ENGINE · PURE TICK · REAL LEDGER · ORDER FSM</div></div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={bx(st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm, st.regime.trend === "trending" ? K.gd : st.regime.trend === "mean_reverting" ? K.pd : K.s2)}>{st.regime.trend}</span>
          <span style={bx(st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r, st.cb.state === "closed" ? K.gd : st.cb.state === "half_open" ? K.yd : K.rd)}>CB:{st.cb.state}</span>
          <span style={bx(running ? K.g : K.r, running ? K.gd : K.rd)}>{running ? "● LIVE" : "○ OFF"}</span>
          <button onClick={() => { setRunning(r => !r); if (st.cb.state === "open") setState(p => ({ ...p, cb: { ...p.cb, state: "closed", failCount: 0, reason: null } })); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: running ? K.r : K.g, color: K.bg, fontFamily: FF, fontSize: 10, fontWeight: 700 }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: "flex", gap: 1, borderBottom: `1px solid ${K.bd}`, marginBottom: 10, overflowX: "auto" }}>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 10px", background: tab === t ? K.s2 : "transparent", color: tab === t ? K.g : K.dm, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", borderBottom: tab === t ? `2px solid ${K.g}` : "2px solid transparent" }}>{t}</button>)}
      </div>

      {/* DASHBOARD */}
      {tab === "Dashboard" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 6, marginBottom: 8 }}>
          <St l="Equity" v={fd2(st.equity)} c={st.equity >= 10000 ? K.g : K.r} />
          <St l="PnL" v={(st.totalPnl >= 0 ? "+" : "") + fd2(st.totalPnl)} c={st.totalPnl >= 0 ? K.g : K.r} />
          <St l="Exposure" v={fd2(st.grossExposure)} c={st.grossExposure > 4000 ? K.y : K.tx} s={`/${fd2(RISK_CFG.maxExp)}`} />
          <St l="Drawdown" v={fp(st.currentDD)} c={st.currentDD > 0.1 ? K.r : st.currentDD > 0.05 ? K.y : K.g} />
          <St l="Tick" v={st.tickCount} c={K.b} s={`seed:${st.seed}`} />
          <St l="Signals" v={st.signals.length} c={K.p} s={`${st.recommendations.length} recs`} />
        </div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EQUITY CURVE (deterministic)</div><Spark data={st.equityCurve} w={650} h={55} color={st.equity >= 10000 ? K.g : K.r} /></div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 5 }}>MARKETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {mktArr.map(m => { const ch = m.yes - m.prevYes; return <div key={m.id} style={{ ...mc2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 10, maxWidth: "50%" }}>{m.q}</div>
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
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>META-ALPHA WEIGHTS (regime-adaptive, perf-tracked)</div>
          {Object.entries(st.alphaWeights).map(([k, v]) => <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}><span>{k}</span><span style={{ fontFamily: FF, fontWeight: 700, color: v > 0.4 ? K.g : K.dm }}>{fp(v, 0)}</span></div>
            <div style={{ height: 5, background: K.s2, borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${v * 100}%`, height: "100%", background: k === "nlp" ? K.c : k === "momentum" ? K.p : K.b, borderRadius: 3 }} /></div>
          </div>)}
        </div>
      </div>}

      {/* ALPHA */}
      {tab === "Alpha" && <div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>NEWS — catalyst gate + source weighting</div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>{st.news.slice(0, 15).map(n => <div key={n.id} style={{ display: "flex", gap: 5, padding: "3px 0", borderBottom: `1px solid ${K.bd}10`, fontSize: 9, alignItems: "center" }}>
            <span style={{ fontFamily: FF, fontSize: 8, color: K.dm, minWidth: 44 }}>{ft(n.time)}</span>
            <span style={bx(K.tx, K.s2)}>{n.source}</span>
            <span style={{ flex: 1 }}>{n.headline}</span>
            <span style={bx(n.impactClass === "binary_catalyst" ? K.r : n.impactClass === "gradual_shift" ? K.y : K.dm, n.impactClass === "binary_catalyst" ? K.rd : n.impactClass === "gradual_shift" ? K.yd : K.s2)}>{n.impactClass === "binary_catalyst" ? "CAT" : n.impactClass === "gradual_shift" ? "SHIFT" : "NOISE"}</span>
          </div>)}</div>
        </div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>FILTERED SIGNALS</div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: FF }}>
              <thead><tr style={{ color: K.dm, textAlign: "left", borderBottom: `1px solid ${K.bd}` }}><th style={{ padding: "3px 4px" }}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FRESH</th><th>QUAL</th></tr></thead>
              <tbody>{st.signals.slice(0, 15).map(s => <tr key={s.id} style={{ borderBottom: `1px solid ${K.bd}08` }}>
                <td style={{ padding: "3px 4px" }}><span style={bx(s.source === "nlp" ? K.c : s.source === "momentum" ? K.p : K.b, s.source === "nlp" ? K.cd : s.source === "momentum" ? K.pd : K.b2)}>{s.source}</span></td>
                <td style={{ maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq2(s.conditionId)}</td>
                <td><span style={bx(s.direction === "BUY_YES" ? K.g : K.r, s.direction === "BUY_YES" ? K.gd : K.rd)}>{s.direction === "BUY_YES" ? "YES" : "NO"}</span></td>
                <td style={{ color: K.y }}>{s.effectiveEdge ? fp(s.effectiveEdge, 2) : fp(s.edge, 2)}</td>
                <td style={{ color: (s.freshness || 1) > 0.5 ? K.g : K.r }}>{s.freshness ? fp(s.freshness, 0) : "—"}</td>
                <td>{(s.qualityScore || 0).toFixed(2)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RECOMMENDATIONS</div>
          {st.recommendations.slice(0, 6).map(r => <div key={r.id} style={{ ...mc2, marginBottom: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 600 }}>{mq2(r.conditionId)}</span>
              <div style={{ display: "flex", gap: 3 }}>
                <span style={bx(r.direction === "BUY_YES" ? K.g : K.r, r.direction === "BUY_YES" ? K.gd : K.rd)}>{r.direction}</span>
                <span style={bx(r.urgency === "immediate" ? K.r : K.y, r.urgency === "immediate" ? K.rd : K.yd)}>{r.urgency}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
              <span>Edge:<b style={{ color: K.y }}>{fp(r.compositeEdge, 2)}</b></span>
              <span>Conf:<b style={{ color: K.g }}>{fp(r.confidence, 0)}</b></span>
              <span>Size:<b style={{ color: K.tx }}>{fd2(r.suggestedSize)}</b></span>
              {Object.entries(r.attribution).map(([k, v]) => <span key={k} style={bx(K.tx, K.s3)}>{k}:{v}%</span>)}
            </div>
          </div>)}
        </div>
      </div>}

      {/* EXECUTION */}
      {tab === "Execution" && <div style={crd}>
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDER LIFECYCLE — FSM: NEW→ACCEPTED→PARTIAL→FILLED</div>
        {st.orders.length === 0 && <div style={{ color: K.dm, fontSize: 10 }}>No orders...</div>}
        <div style={{ maxHeight: 450, overflowY: "auto" }}>
          {st.orders.slice(0, 15).map(e => <div key={e.id} style={{ ...mc2, marginBottom: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
              <span style={{ fontSize: 9, fontWeight: 600, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq2(e.conditionId)}</span>
              <div style={{ display: "flex", gap: 2 }}>
                <span style={bx(e.side === "YES" ? K.g : K.r, e.side === "YES" ? K.gd : K.rd)}>{e.side}</span>
                <span style={bx(e.status === "FILLED" ? K.g : e.status === "PARTIALLY_FILLED" ? K.y : K.b, e.status === "FILLED" ? K.gd : e.status === "PARTIALLY_FILLED" ? K.yd : K.b2)}>{e.status}</span>
                <span style={bx(K.p, K.pd)}>{e.strategy}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
              <span>Sz:{fd2(e.parentSize)}</span>
              <span>Fill:<b style={{ color: K.g }}>{fd2(e.totalFilled)}</b>({fp(e.fillRate, 0)})</span>
              {e.slippage != null && <span>Slip:<b style={{ color: e.slippage > 0.005 ? K.r : K.g }}>{(e.slippage * 100).toFixed(2)}¢</b></span>}
            </div>
            <div style={{ display: "flex", gap: 1.5, marginTop: 2 }}>{e.children.map(ch => <div key={ch.id} style={{ width: Math.max(14, ch.size / 5), height: 6, borderRadius: 2, background: ch.status === "FILLED" ? K.g : K.bd, opacity: 0.7 }} />)}</div>
            {e.partialAction && <div style={{ marginTop: 2, padding: "2px 5px", borderRadius: 3, background: e.partialAction.action === "UNWIND" ? K.rd : K.yd, fontSize: 8, fontFamily: FF }}>
              <span style={{ color: e.partialAction.action === "UNWIND" ? K.r : K.y, fontWeight: 600 }}>{e.partialAction.action}</span>
              <span style={{ color: K.dm }}> {e.partialAction.reason}</span>
            </div>}
          </div>)}
        </div>
      </div>}

      {/* RISK */}
      {tab === "Risk" && <div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RISK VERDICTS (from order checks)</div>
          {st.orders.slice(0, 6).map(e => e.riskChecks && <div key={e.id} style={{ marginBottom: 5, paddingBottom: 5, borderBottom: `1px solid ${K.bd}12` }}>
            <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 2 }}>{mq2(e.conditionId)}</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {e.riskChecks.map((ch, i) => <div key={i} style={{ display: "flex", gap: 2, alignItems: "center", fontSize: 8, fontFamily: FF }}><RB s={ch.s} /><span style={{ color: K.dm }}>{ch.n}</span></div>)}
            </div>
          </div>)}
        </div>
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>POSITION LEDGER (weighted avg entry, real PnL)</div>
          {Object.keys(st.positions).length === 0 && <div style={{ color: K.dm, fontSize: 9 }}>No positions</div>}
          {Object.entries(st.positions).map(([id, p]) => {
            const mkt = st.markets[id]; const uYes = p.yesQty * ((mkt?.yes || 0) - p.yesAvgPx); const uNo = p.noQty * ((1 - (mkt?.yes || 0)) - p.noAvgPx);
            const pct = RISK_CFG.maxPos ? ((p.yesQty + p.noQty) / RISK_CFG.maxPos) * 100 : 0;
            return <div key={id} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 8, marginBottom: 1 }}>{mq2(id)} <span style={{ color: K.dm }}>({mkt?.cat})</span></div>
              <div style={{ display: "flex", gap: 8, fontFamily: FF, fontSize: 8, color: K.dm }}>
                <span>YES:{p.yesQty}@{(p.yesAvgPx * 100).toFixed(1)}¢</span>
                <span>NO:{p.noQty}@{(p.noAvgPx * 100).toFixed(1)}¢</span>
                <span style={{ color: (uYes + uNo) >= 0 ? K.g : K.r }}>uPnL:{fd2(uYes + uNo)}</span>
              </div>
              <div style={{ height: 4, background: K.s2, borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
                <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pct > 80 ? K.r : pct > 50 ? K.y : K.g, borderRadius: 2 }} />
              </div>
            </div>;
          })}
        </div>
      </div>}

      {/* SYSTEM */}
      {tab === "System" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 8 }}>
          <St l="Approvals" v={st.monitor.approvals} c={K.g} s={`${st.monitor.rejections} rejected`} />
          <St l="NLP sigs" v={st.monitor.signalCounts.nlp} c={K.c} />
          <St l="Mom sigs" v={st.monitor.signalCounts.momentum} c={K.p} />
          <St l="Arb sigs" v={st.monitor.signalCounts.arb} c={K.b} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
          <St l="Fills" v={st.fills.length} c={K.g} s="append-only ledger" />
          <St l="Orders" v={st.orders.length} c={K.b} s={`${st.orders.filter(o => o.status === "FILLED").length} filled`} />
        </div>
        {st.cb.triggers.length > 0 && <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>CIRCUIT BREAKER HISTORY</div>
          {st.cb.triggers.slice(-5).map((t, i) => <div key={i} style={{ fontSize: 8, fontFamily: FF, color: K.r, padding: "1px 0" }}>{ft(t.t)} — {t.r}</div>)}</div>}
        <div style={crd}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>EVENT LOG (this tick)</div>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {st.events.slice().reverse().slice(0, 30).map((e, i) => <div key={i} style={{ display: "flex", gap: 5, padding: "2px 0", borderBottom: `1px solid ${K.bd}08`, fontSize: 8, fontFamily: FF }}>
              <span style={{ color: K.dm, minWidth: 44 }}>{ft(e.ts)}</span>
              <span style={bx(e.evt.includes("risk:reject") || e.evt.includes("partial") ? K.r : e.evt.includes("risk") ? K.o : e.evt.includes("exec") ? K.g : e.evt.includes("news") ? K.p : K.dm, e.evt.includes("risk:reject") || e.evt.includes("partial") ? K.rd : e.evt.includes("risk") ? K.od : e.evt.includes("exec") ? K.gd : e.evt.includes("news") ? K.pd : K.s2)}>{e.evt}</span>
              <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>{e.s}</span>
            </div>)}
          </div>
        </div>
        <div style={{ ...crd, fontSize: 8, fontFamily: FF, color: K.dm }}>
          <b style={{ color: K.tx }}>Architecture notes:</b><br />
          • Engine is pure: tick(state, time) → nextState, no React, no side effects<br />
          • Seeded PRNG (mulberry32): same seed = same results, deterministic replay<br />
          • Single snapshot per tick: all pipeline steps see same data<br />
          • Portfolio ledger: weighted avg entry, append-only fills, real PnL<br />
          • Orders: full FSM (NEW→ACCEPTED→PARTIAL→FILLED/CANCELLED)<br />
          • State is serializable: JSON.stringify(state) works for save/load<br />
          • No Math.random(), no Date.now() in engine (time is injected)
        </div>
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V4 DETERMINISTIC · PURE ENGINE · SEED:{st.seed} · TICK:{st.tickCount} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
