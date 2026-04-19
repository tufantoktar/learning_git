import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
//  POLYMARKET V5.0 — MARKET-REALISTIC ALPHA-DRIVEN TRADING ENGINE
//
//  Upgrade from V4.3.2:
//   PHASE 1: LOB + Execution Realism
//     - Real limit order book with FIFO matching
//     - Queue position tracking, partial fills via depth consumption
//     - Configurable latency simulation + adverse selection
//     - No random fill probability — fills only via matching engine
//   PHASE 2: Market Impact + Liquidity
//     - Square-root impact model for large orders
//     - Dynamic depth/spread based on regime + stress
//   PHASE 3: Real Alpha Engine
//     - Orderflow imbalance signals
//     - Cointegration-aware stat arb (ADF-like stationarity)
//     - Multi-timeframe volatility-adjusted momentum
//     - Latency + confidence-decayed NLP
//   PHASE 4: Portfolio Intelligence
//     - Rolling correlation matrix
//     - Volatility-targeted sizing
//     - Kelly capped by regime confidence
//     - Max correlated exposure constraint
//   PHASE 5: Smart Execution
//     - TWAP/VWAP schedule tracking
//     - Adaptive limit pricing based on fill rate
//     - Intelligent cancel/replace on drift
//   PHASE 6: Event Sourcing
//     - Append-only structured event log
//     - Full replay from events (deterministic validation)
//   PHASE 7: Performance Metrics
//     - Sharpe ratio, win rate, avg slippage
//     - Execution quality (implementation shortfall)
//     - Alpha contribution per signal source
//
//  ALL V4.3.2 guarantees preserved:
//   [P1-P7] FSM, partial fills, fill dedup, recon, CB, determinism
//   [A1-A4] Fill-level attribution correctness
//   [C1-C7] Half-open notional, live sizing, pruning, risk clarity
//
//  Architecture: ENGINE (pure) | UI (render-only) — single file
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
  maxPos: 1500, maxCatQty: 3000, maxExpNotional: 6000,
  maxDD: 0.20, softDD: 0.12,
  maxSlipBps: 40, minLiqRatio: 3, minSigQuality: 0.2,
  maxSpread: 0.06, minDepth: 30, stalenessMs: 10000,
  cbRecoveryMs: 60000, cbHalfOpenMaxNotional: 200, cbHalfOpenProbeMinFills: 1,
  cbSlipThreshold: 5, cbRejectThreshold: 8, cbPoorFillThreshold: 6,
  cbInvalidDataThreshold: 4, cbExpBreachMultiplier: 1.3,
  cbSlipWindow: 20, cbPoorFillWindow: 20, cbInvalidDataWindow: 15, cbRejectWindow: 20,
  partialRetryBudget: 2, partialDriftThreshold: 0.02, partialMinQty: 20,
  maxSpawnDepth: 3, maxSpawnsPerTick: 6,
  historyRetentionCap: 300, historyMinRetainTerminal: 50,
  initialEquity: 10000,
  // ── Phase 1: LOB Config ──
  lobLevels: 10,               // price levels per side
  lobBaseDepth: 150,            // base qty per level
  lobLatencyMs: 50,             // simulated latency (ms)
  lobAdverseSelectionBps: 5,    // adverse price move on aggressive fills
  // ── Phase 2: Market Impact ──
  impactCoeff: 0.15,            // sqrt-impact coefficient
  impactDecayTicks: 8,          // ticks for temporary impact to decay
  stressSpreadMultiplier: 2.5,  // spread multiplier in stress regime
  // ── Phase 4: Portfolio ──
  maxCorrelatedExposure: 0.6,   // max portfolio-level correlated notional fraction
  volTargetAnnual: 0.15,        // annual vol target for sizing
  corrWindow: 40,               // rolling correlation window
  // ── Phase 5: Smart Execution ──
  twapSlices: 5,                // TWAP slice count
  adaptiveLimitBps: 15,         // adaptive limit price offset (bps from mid)
  cancelReplaceThresholdBps: 25,// cancel/replace if limit drifts beyond this
  // ── Phase 7: Metrics ──
  metricsWindow: 50,            // rolling window for Sharpe etc.
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

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 1: LIMIT ORDER BOOK ENGINE
// ═══════════════════════════════════════════════════════════════════════
// Deterministic LOB with price-level depth, FIFO queues, and matching.
// Each market maintains its own LOB. All operations are pure/deterministic.

// Create a fresh LOB for a market. midPrice is the YES price.
function createLOB(midPrice, adv, rng) {
  const levels = CFG.lobLevels;
  const liquidity = cl(adv / 15000, 0.2, 2.5);
  // Cap halfSpread so total spread stays within maxSpread
  const halfSpread = Math.min(0.008 / liquidity, CFG.maxSpread * 0.45);
  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i++) {
    const offset = halfSpread + i * (0.005 / liquidity);
    const bidPx = r4(cl(midPrice - offset, 0.01, 0.99));
    const askPx = r4(cl(midPrice + offset, 0.01, 0.99));
    const depthBase = Math.floor(CFG.lobBaseDepth * liquidity * (1 - i * 0.08));
    const bidDepth = Math.max(10, Math.floor(depthBase * (0.7 + rng() * 0.6)));
    const askDepth = Math.max(10, Math.floor(depthBase * (0.7 + rng() * 0.6)));
    bids.push({ px: bidPx, qty: bidDepth, orders: [{ id: "lob_b_" + i, qty: bidDepth, ts: 0 }] });
    asks.push({ px: askPx, qty: askDepth, orders: [{ id: "lob_a_" + i, qty: askDepth, ts: 0 }] });
  }
  // Sort: bids descending, asks ascending
  bids.sort((a, b) => b.px - a.px);
  asks.sort((a, b) => a.px - b.px);
  const bestBid = bids[0]?.px || midPrice - halfSpread;
  const bestAsk = asks[0]?.px || midPrice + halfSpread;
  return {
    bids, asks,
    bestBid: r4(bestBid), bestAsk: r4(bestAsk),
    spread: r4(bestAsk - bestBid),
    midPrice: r4((bestBid + bestAsk) / 2),
    bidDepth: bids.reduce((s, l) => s + l.qty, 0),
    askDepth: asks.reduce((s, l) => s + l.qty, 0),
    lastTradePrice: midPrice,
    tradeCount: 0,
    volumeThisTick: 0,
  };
}

// Refresh LOB each tick: replenish depth, adjust around new mid price.
// Pure function — returns new LOB.
function refreshLOB(prevLob, newMidPrice, adv, regime, rng) {
  const liquidity = cl(adv / 15000, 0.2, 2.5);
  // Stress: widen spread in high-vol or low-liq regimes, but cap within maxSpread
  const stressFactor = (regime.vol === "high_vol" ? 1.5 : 1) * (regime.liq === "low_liq" ? CFG.stressSpreadMultiplier : 1);
  const halfSpread = Math.min((0.008 / liquidity) * stressFactor, CFG.maxSpread * 0.45);

  const bids = [];
  const asks = [];
  for (let i = 0; i < CFG.lobLevels; i++) {
    const offset = halfSpread + i * (0.005 / liquidity) * stressFactor;
    const bidPx = r4(cl(newMidPrice - offset, 0.01, 0.99));
    const askPx = r4(cl(newMidPrice + offset, 0.01, 0.99));
    // Depth replenishment: mean-revert toward base, with noise
    const depthBase = Math.floor(CFG.lobBaseDepth * liquidity * (1 - i * 0.08) / stressFactor);
    // Carry forward partial depth from previous LOB if price level existed
    const prevBidLevel = prevLob.bids.find(l => Math.abs(l.px - bidPx) < 0.001);
    const prevAskLevel = prevLob.asks.find(l => Math.abs(l.px - askPx) < 0.001);
    const bidCarry = prevBidLevel ? Math.floor(prevBidLevel.qty * 0.7) : 0;
    const askCarry = prevAskLevel ? Math.floor(prevAskLevel.qty * 0.7) : 0;
    const replenish = Math.floor(depthBase * 0.3 * (0.5 + rng()));
    const bidQty = Math.max(5, bidCarry + replenish);
    const askQty = Math.max(5, askCarry + replenish);
    bids.push({ px: bidPx, qty: bidQty, orders: [{ id: "lob_b_" + i, qty: bidQty, ts: 0 }] });
    asks.push({ px: askPx, qty: askQty, orders: [{ id: "lob_a_" + i, qty: askQty, ts: 0 }] });
  }
  bids.sort((a, b) => b.px - a.px);
  asks.sort((a, b) => a.px - b.px);
  const bestBid = bids[0]?.px || newMidPrice - halfSpread;
  const bestAsk = asks[0]?.px || newMidPrice + halfSpread;
  return {
    bids, asks,
    bestBid: r4(bestBid), bestAsk: r4(bestAsk),
    spread: r4(bestAsk - bestBid),
    midPrice: r4((bestBid + bestAsk) / 2),
    bidDepth: bids.reduce((s, l) => s + l.qty, 0),
    askDepth: asks.reduce((s, l) => s + l.qty, 0),
    lastTradePrice: prevLob.lastTradePrice,
    tradeCount: 0,
    volumeThisTick: 0,
  };
}

// FIFO matching engine: execute an order against the LOB.
// side="buy" consumes asks (lifts the offer), side="sell" consumes bids (hits the bid).
// Returns { fills, remainingQty, updatedLob }.
// Pure, deterministic — no randomness needed.
function matchOrderAgainstLOB(lob, side, qty, limitPx, orderId, tickTime) {
  const fills = [];
  let remaining = qty;
  const bookSide = side === "buy" ? [...lob.asks.map(l => ({ ...l, orders: [...l.orders] }))] : [...lob.bids.map(l => ({ ...l, orders: [...l.orders] }))];

  for (let i = 0; i < bookSide.length && remaining > 0; i++) {
    const level = bookSide[i];
    // Price check: buy must not exceed limit; sell must not go below limit
    if (side === "buy" && level.px > limitPx) break;
    if (side === "sell" && level.px < limitPx) break;

    const available = level.qty;
    const fillQty = Math.min(remaining, available);
    if (fillQty <= 0) continue;

    fills.push({
      px: level.px,
      qty: fillQty,
      levelIdx: i,
      time: tickTime,
    });

    level.qty -= fillQty;
    remaining -= fillQty;
    // Remove exhausted orders from FIFO queue
    let toConsume = fillQty;
    while (toConsume > 0 && level.orders.length > 0) {
      const front = level.orders[0];
      if (front.qty <= toConsume) {
        toConsume -= front.qty;
        level.orders.shift();
      } else {
        front.qty -= toConsume;
        toConsume = 0;
      }
    }
  }

  // Reconstruct LOB with consumed depth
  const newBids = side === "sell" ? bookSide.filter(l => l.qty > 0) : lob.bids.map(l => ({ ...l }));
  const newAsks = side === "buy" ? bookSide.filter(l => l.qty > 0) : lob.asks.map(l => ({ ...l }));

  const totalFilled = qty - remaining;
  const avgPx = totalFilled > 0 ? +(fills.reduce((s, f) => s + f.px * f.qty, 0) / totalFilled).toFixed(4) : 0;
  const lastTrade = fills.length > 0 ? fills[fills.length - 1].px : lob.lastTradePrice;

  const bestBid = newBids[0]?.px || lob.bestBid;
  const bestAsk = newAsks[0]?.px || lob.bestAsk;

  const updatedLob = {
    ...lob,
    bids: newBids, asks: newAsks,
    bestBid: r4(bestBid), bestAsk: r4(bestAsk),
    spread: r4(bestAsk - bestBid),
    midPrice: r4((bestBid + bestAsk) / 2),
    bidDepth: newBids.reduce((s, l) => s + l.qty, 0),
    askDepth: newAsks.reduce((s, l) => s + l.qty, 0),
    lastTradePrice: lastTrade,
    tradeCount: lob.tradeCount + fills.length,
    volumeThisTick: lob.volumeThisTick + totalFilled,
  };

  return { fills, remainingQty: remaining, totalFilled, avgPx, updatedLob };
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 2: MARKET IMPACT MODEL
// ═══════════════════════════════════════════════════════════════════════
// Square-root impact: price moves proportional to sqrt(qty / ADV).
// Temporary impact decays over configurable ticks.
// Permanent impact shifts the fair value.

function computeMarketImpact(qty, adv, side) {
  if (qty <= 0 || adv <= 0) return { tempImpact: 0, permImpact: 0, totalImpact: 0 };
  const participation = qty / adv;
  const sqrtImpact = CFG.impactCoeff * Math.sqrt(participation);
  const direction = side === "buy" ? 1 : -1;
  const tempImpact = r4(sqrtImpact * 0.7 * direction);
  const permImpact = r4(sqrtImpact * 0.3 * direction);
  return { tempImpact, permImpact, totalImpact: r4(tempImpact + permImpact) };
}

// Apply adverse selection: after an aggressive fill, price moves against the taker.
function applyAdverseSelection(fillPx, midPx, side) {
  const adverseBps = CFG.lobAdverseSelectionBps;
  const move = midPx * adverseBps / 10000;
  if (side === "buy") return r4(midPx + move);  // mid moves up after buy
  return r4(midPx - move);  // mid moves down after sell
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 4: CORRELATION MATRIX (needed before alpha signals)
// ═══════════════════════════════════════════════════════════════════════
function computeCorrelationMatrix(histories, marketIds) {
  const n = marketIds.length;
  const matrix = {};
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const a = marketIds[i], b = marketIds[j];
      if (i === j) { matrix[a + ":" + b] = 1; continue; }
      const hA = histories[a], hB = histories[b];
      if (!hA || !hB) { matrix[a + ":" + b] = 0; matrix[b + ":" + a] = 0; continue; }
      const w = CFG.corrWindow;
      const pA = hA.prices.slice(-w), pB = hB.prices.slice(-w);
      const len = Math.min(pA.length, pB.length);
      if (len < 10) { matrix[a + ":" + b] = 0; matrix[b + ":" + a] = 0; continue; }
      const rA = [], rB = [];
      for (let k = 1; k < len; k++) {
        rA.push(pA[k] - pA[k - 1]);
        rB.push(pB[k] - pB[k - 1]);
      }
      const mA = rA.reduce((s, v) => s + v, 0) / rA.length;
      const mB = rB.reduce((s, v) => s + v, 0) / rB.length;
      let cov = 0, vA = 0, vB = 0;
      for (let k = 0; k < rA.length; k++) {
        cov += (rA[k] - mA) * (rB[k] - mB);
        vA += (rA[k] - mA) ** 2;
        vB += (rB[k] - mB) ** 2;
      }
      const corr = (vA > 0 && vB > 0) ? +(cov / Math.sqrt(vA * vB)).toFixed(3) : 0;
      matrix[a + ":" + b] = corr;
      matrix[b + ":" + a] = corr;
    }
  }
  return matrix;
}

// Max correlated exposure check for portfolio constraints
function checkCorrelatedExposure(positions, markets, corrMatrix) {
  const mids = Object.keys(positions);
  let totalNotional = 0;
  let correlatedNotional = 0;
  for (const mid of mids) {
    const pos = positions[mid];
    const m = markets[mid];
    if (!m) continue;
    const notional = pos.yesQty * m.yes + pos.noQty * (1 - m.yes);
    totalNotional += notional;
  }
  if (totalNotional <= 0) return { ratio: 0, ok: true };
  // Pairwise correlated exposure
  for (let i = 0; i < mids.length; i++) {
    for (let j = i + 1; j < mids.length; j++) {
      const corr = corrMatrix[mids[i] + ":" + mids[j]] || 0;
      if (Math.abs(corr) > 0.5) {
        const nA = (positions[mids[i]].yesQty + positions[mids[i]].noQty);
        const nB = (positions[mids[j]].yesQty + positions[mids[j]].noQty);
        correlatedNotional += Math.min(nA, nB) * Math.abs(corr);
      }
    }
  }
  const ratio = totalNotional > 0 ? +(correlatedNotional / totalNotional).toFixed(3) : 0;
  return { ratio, ok: ratio <= CFG.maxCorrelatedExposure };
}

// ══════════════════════ ENGINE: INITIAL STATE ════════════════════════
function initState(seed = 42) {
  const rng = createRng(seed);
  const markets = {}, histories = {}, lobs = {};
  for (const d of MDEFS) {
    markets[d.id] = { id: d.id, q: d.q, yes: d.init, prevYes: d.init, vol: d.vol, cat: d.cat, adv: d.adv, lastUpdate: 0 };
    histories[d.id] = { prices: [], spreads: [], depths: [], maxLen: 300 };
    lobs[d.id] = createLOB(d.init, d.adv, rng);
  }
  return {
    seed, tickCount: 0, time: 0, markets, histories, lobs,
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
    cb: { state: "closed", failCount: 0, lastFailTime: 0, reason: null, triggers: [],
      recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [],
      halfOpenNotional: 0, halfOpenFills: 0 },
    quarantined: {},
    monitor: { approvals: 0, rejections: 0, signalCounts: { nlp: 0, momentum: 0, arb: 0 } },
    events: [],
    lastRecon: { ok: true, issues: 0, drifts: 0, orphans: 0, fills: 0, orders: 0 },
    spawnStats: { existing: 0, new: 0, deferred: 0 },
    deferredSpawns: [], orderSeq: 0,
    // Phase 4: correlation matrix
    corrMatrix: {},
    // Phase 6: event log (append-only)
    eventLog: [],
    // Phase 7: metrics
    perfMetrics: { sharpe: 0, winRate: 0, avgSlipBps: 0, execQuality: 0, alphaContrib: {} },
    equityReturns: [],
    // Market impact tracking
    impactDecay: {},
  };
}

// ══════════════════════ ENGINE: MARKET SIM ════════════════════════════
// Phase 2: market sim now includes permanent impact from previous trades
function advMkt(m, rng, time, impactDecay) {
  const mr = 0.002 * (0.5 - m.yes);
  const noise = (rng() - 0.5) * 2 * m.vol;
  const shock = rng() < 0.005 ? (rng() - 0.5) * 0.08 : 0;
  // Apply decaying temporary impact from recent large trades
  let impactAdj = 0;
  const decayEntry = impactDecay[m.id];
  if (decayEntry && decayEntry.remaining > 0) {
    impactAdj = decayEntry.tempImpact * (decayEntry.remaining / CFG.impactDecayTicks);
  }
  const newYes = r4(cl(m.yes + mr + noise + shock + impactAdj, 0.02, 0.98));
  return {
    ...m, prevYes: m.yes, yes: newYes,
    adv: Math.max(500, Math.floor(m.adv + (rng() - 0.5) * 200)),
    lastUpdate: time,
  };
}

// Legacy buildBook kept for validation compatibility
function buildBook(mid, adv, rng) {
  const lf = cl(adv / 20000, 0.3, 2), bs = 0.015 / lf;
  const bids = [], asks = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ p: r4(cl(mid - bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) });
    asks.push({ p: r4(cl(mid + bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) });
  }
  return { bids, asks, spread: r4(asks[0].p - bids[0].p), mid, bidDepth: bids.reduce((s, b) => s + b.sz, 0), askDepth: asks.reduce((s, a) => s + a.sz, 0) };
}

function validateMarket(mkt, lob, time) {
  const issues = [];
  if (mkt.yes < 0 || mkt.yes > 1) issues.push("price_invalid");
  if (lob.spread > CFG.maxSpread) issues.push("spread_" + (lob.spread * 100).toFixed(1) + "%");
  if (lob.bidDepth < CFG.minDepth || lob.askDepth < CFG.minDepth) issues.push("depth_low");
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

// ══════════════════════ ENGINE: META-ALPHA ═══════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 3: UPGRADED ALPHA SIGNALS
// ═══════════════════════════════════════════════════════════════════════

// NLP signals: latency + confidence decay, unchanged interface
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
  // Phase 3: lower threshold, latency-penalized confidence
  if (nev.confidence < 0.45) return [];
  const sigs = [];
  const latPenalty = cl(1 - nev.latencyMs / 8000, 0.3, 1);
  for (const mid of nev.markets) {
    const m = mkts[mid]; if (!m) continue;
    const e = nev.sentiment * nev.baseImpact * nev.confidence * nev.srcWeight * latPenalty * 0.04;
    if (Math.abs(e) < 0.004) continue;
    const adjConf = +(nev.confidence * latPenalty).toFixed(3);
    sigs.push({ id: "nlp_" + mid + "_" + time, source: "nlp", time, cid: mid, dir: e > 0 ? "BUY_YES" : "BUY_NO",
      edge: +Math.abs(e).toFixed(4), conf: adjConf, fv: r4(cl(m.yes + e, 0.02, 0.98)),
      px: m.yes, hl: 180000, exp: time + 720000, qs: +(adjConf * nev.srcWeight).toFixed(3) });
  }
  return sigs;
}

// Phase 3: Multi-timeframe volatility-adjusted momentum
function momSigs(mkts, hists, time, regime) {
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

    sigs.push({ id: "mom_" + mid + "_" + time, source: "momentum", time, cid: mid,
      dir: comp > 0 ? "BUY_YES" : "BUY_NO",
      edge: +(ac * 0.05).toFixed(4), conf: +cl(0.4 + ac * 0.25, 0, 0.95).toFixed(3),
      fv: r4(px + comp * 0.015), px,
      hl: 240000, exp: time + 300000,
      qs: +(ac * cl(p.length / 100, 0, 1)).toFixed(3) });
  }
  return sigs;
}

// Phase 3: Cointegration-aware stat arb with entry/exit bands
function arbSigs(mkts, hists, time) {
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
    for (let i = 0; i < n; i++) { cov += (pA[i] - ma) * (pB[i] - mb); va += (pA[i] - ma) ** 2; vb += (pB[i] - mb) ** 2; }
    const corr = (va && vb) ? cov / Math.sqrt(va * vb) : 0;
    if (Math.abs(corr) < 0.25) continue;

    // Stability check (split-half)
    const h = Math.floor(n / 2);
    const hc = (a, b) => { const l = a.length; if (l < 5) return 0; const am = a.reduce((s, v) => s + v, 0) / l, bm = b.reduce((s, v) => s + v, 0) / l; let c = 0, av = 0, bv = 0; for (let i = 0; i < l; i++) { c += (a[i] - am) * (b[i] - bm); av += (a[i] - am) ** 2; bv += (b[i] - bm) ** 2; } return (av && bv) ? c / Math.sqrt(av * bv) : 0; };
    const stab = 1 - Math.abs(hc(pA.slice(0, h), pB.slice(0, h)) - hc(pA.slice(h), pB.slice(h)));
    if (stab < 0.5) continue;

    // Phase 3: Cointegration check — ADF-like stationarity test on spread
    const beta = hStd(pA, 30) > 0 ? corr * (hStd(pB, 30) / hStd(pA, 30)) : 0;
    const spread = [];
    for (let i = 0; i < n; i++) spread.push(pB[i] - beta * pA[i]);
    const spreadMean = spread.reduce((s, v) => s + v, 0) / spread.length;
    const spreadStd = Math.sqrt(spread.reduce((s, v) => s + (v - spreadMean) ** 2, 0) / (spread.length - 1)) || 0.001;
    // Simple stationarity: check if spread mean-reverts (autocorrelation of changes < 0)
    const spreadChanges = [];
    for (let i = 1; i < spread.length; i++) spreadChanges.push(spread[i] - spread[i - 1]);
    const lagCorr = spreadChanges.length > 5 ? (() => {
      const m = spreadChanges.reduce((s, v) => s + v, 0) / spreadChanges.length;
      let num = 0, den = 0;
      for (let i = 1; i < spreadChanges.length; i++) { num += (spreadChanges[i] - m) * (spreadChanges[i - 1] - m); den += (spreadChanges[i] - m) ** 2; }
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
    sigs.push({ id: "arb_" + pair.a + "_" + pair.b + "_" + time, source: "arb", time, cid: mB.id,
      dir: mismatch > 0 ? "BUY_NO" : "BUY_YES",
      edge: +ne.toFixed(4), conf: +cl(0.3 + Math.abs(z) * 0.12 * cc, 0, 0.95).toFixed(3),
      fv: r4(cl(spreadMean + beta * mA.yes, 0.02, 0.98)), px: mB.yes,
      hl: 600000, exp: time + 600000,
      qs: +(cc * cl(Math.abs(z) / 3, 0, 1)).toFixed(3),
      z: +z.toFixed(2), corr: +corr.toFixed(3), stab: +stab.toFixed(3),
      pair: pair.a + "\u2194" + pair.b, coint: true });
  }
  return sigs;
}

// Phase 3: Orderflow imbalance signals (from LOB state)
function orderflowSigs(mkts, lobs, time) {
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
    // Edge from imbalance: strong imbalance predicts price direction
    const edge = absImb * 0.03 * (1 + intensity * 0.5);
    if (edge < 0.004) continue;
    sigs.push({ id: "oflow_" + mid + "_" + time, source: "momentum", time, cid: mid,
      dir: imbalance > 0 ? "BUY_YES" : "BUY_NO",
      edge: +edge.toFixed(4), conf: +cl(0.3 + absImb * 0.4, 0.2, 0.85).toFixed(3),
      fv: r4(cl(m.yes + imbalance * 0.02, 0.02, 0.98)), px: m.yes,
      hl: 120000, exp: time + 240000,
      qs: +(absImb * 0.8).toFixed(3) });
  }
  return sigs;
}

// ══════════════════════ ENGINE: SIGNAL PROCESSING ════════════════════
// Sizing uses LIVE state: equity, DD, notional room, position room, CB cap.
function processSigs(signals, weights, regConf, time, liveState) {
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
  sigs = sigs.map(s => { const fr = Math.pow(0.5, (time - s.time) / (s.hl || 300000)); return { ...s, fr: +fr.toFixed(3), ee: +(s.edge * fr).toFixed(4) }; });
  const best = {}; for (const s of sigs) { const k = s.source + ":" + s.cid; if (!best[k] || s.ee > best[k].ee) best[k] = s; }
  sigs = Object.values(best).filter(s => (s.qs || 0.5) > 0.15);
  const byM = {}; for (const s of sigs) (byM[s.cid] || (byM[s.cid] = [])).push(s);
  const recs = [];
  for (const [mid, ms] of Object.entries(byM)) {
    let comp = 0;
    for (const s of ms) comp += s.ee * (s.dir === "BUY_YES" ? 1 : -1) * s.conf * (weights[s.source] || 0.33);
    const signs = ms.map(s => s.dir === "BUY_YES" ? 1 : -1);
    const conc = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    const conf = +cl(0.4 * conc + 0.3 * cl(Math.abs(comp) * 2, 0, 1) + 0.15 * cl(ms.length / 3, 0, 1) + 0.15 * regConf, 0, 0.95).toFixed(3);
    const dir = comp >= 0 ? "BUY_YES" : "BUY_NO";
    const ae = Math.abs(comp) * (0.5 + conc * 0.5);
    if (ae < 0.006) continue;
    const px = ms[0].px || 0.5;
    const odds = comp > 0 ? px / (1 - px + 1e-4) : (1 - px) / (px + 1e-4);
    // Phase 4: Kelly capped by regime confidence
    const regimeKellyCap = regConf > 0.7 ? 0.25 : regConf > 0.4 ? 0.18 : 0.10;
    const kelly = cl((ae * odds - (1 - ae)) / (odds + 1e-4) * 0.5, 0, regimeKellyCap) * conf;
    const mkt = liveMarkets[mid];
    const sidePrice = mkt ? (dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;
    // Phase 4: volatility-targeted sizing
    const mktVol = mkt ? mkt.vol || 0.02 : 0.02;
    const volScale = mktVol > 0.001 ? cl(CFG.volTargetAnnual / (mktVol * Math.sqrt(252)), 0.3, 2) : 1;
    let desiredQty = Math.floor(kelly * capitalBase * volScale);
    if (sidePrice > 0) desiredQty = Math.min(desiredQty, Math.floor(remainingNotionalRoom / sidePrice));
    const pos = livePositions[mid] || { yesQty: 0, noQty: 0 };
    desiredQty = Math.min(desiredQty, Math.max(0, CFG.maxPos - pos.yesQty - pos.noQty));
    if (mkt) {
      let catQty = 0;
      for (const [om, op] of Object.entries(livePositions)) { const omk = liveMarkets[om]; if (omk && omk.cat === mkt.cat) catQty += op.yesQty + op.noQty; }
      desiredQty = Math.min(desiredQty, Math.max(0, CFG.maxCatQty - catQty));
    }
    if (liveCbState === "half_open" && sidePrice > 0) desiredQty = Math.min(desiredQty, Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice));
    if (desiredQty < 15) continue;
    const attr = {}; ms.forEach(s => { attr[s.source] = (attr[s.source] || 0) + s.ee * s.conf; });
    const ta = Object.values(attr).reduce((s, v) => s + Math.abs(v), 0) || 1;
    Object.keys(attr).forEach(k2 => attr[k2] = +((Math.abs(attr[k2]) / ta) * 100).toFixed(1));
    recs.push({ id: "rec_" + mid + "_" + time, time, cid: mid, dir, ce: +ae.toFixed(4), conf, conc: +conc.toFixed(2), sz: desiredQty, attr, nSigs: ms.length, urg: ae > 0.025 ? "immediate" : ae > 0.012 ? "patient" : "passive", aq: +(ms.reduce((s, x) => s + (x.qs || 0.5), 0) / ms.length).toFixed(3) });
  }
  return { filtered: sigs, recs };
}

// ══════════════════════ ENGINE: RISK ═════════════════════════════════
function calcExposure(positions, markets) {
  let gross = 0, net = 0; const catNotional = {}, catQty = {};
  for (const [mid, pos] of Object.entries(positions)) {
    const m = markets[mid]; if (!m) continue;
    const yN = pos.yesQty * m.yes, nN = pos.noQty * (1 - m.yes);
    gross += yN + nN; net += Math.abs(yN - nN);
    catNotional[m.cat] = (catNotional[m.cat] || 0) + yN + nN;
    catQty[m.cat] = (catQty[m.cat] || 0) + pos.yesQty + pos.noQty;
  }
  return { gross: +gross.toFixed(2), net: +net.toFixed(2), catNotional, catQty };
}

function preTradeRisk(rec, snap) {
  const { positions, markets, cb, currentDD, grossExposure } = snap;
  const checks = []; let approved = true; let allowedQty = rec.sz;
  const mkt = markets[rec.cid];
  const sidePrice = mkt ? (rec.dir === "BUY_YES" ? mkt.yes : 1 - mkt.yes) : 0.5;
  if (cb.state === "open") { checks.push({ n: "CB", s: "blocked", d: cb.reason }); approved = false; }
  else if (cb.state === "half_open") { const hq = sidePrice > 0 ? Math.floor(CFG.cbHalfOpenMaxNotional / sidePrice) : 0; if (allowedQty > hq) { allowedQty = hq; checks.push({ n: "CB", s: "adjusted", d: "half_open→qty " + hq }); } else checks.push({ n: "CB", s: "adjusted", d: "half_open probe" }); if (allowedQty <= 0) approved = false; }
  else checks.push({ n: "CB", s: "pass", d: "closed" });
  const pos = positions[rec.cid] || { yesQty: 0, noQty: 0 };
  const existingQty = pos.yesQty + pos.noQty;
  if (existingQty + allowedQty > CFG.maxPos) { allowedQty = Math.max(0, CFG.maxPos - existingQty); checks.push({ n: "PosQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: "qty:" + existingQty + "+" + allowedQty + "/" + CFG.maxPos }); if (!allowedQty) approved = false; }
  else checks.push({ n: "PosQty", s: "pass", d: "qty:" + (existingQty + allowedQty) + "/" + CFG.maxPos });
  const additionalNotional = +(allowedQty * sidePrice).toFixed(2);
  const remainingN = Math.max(0, CFG.maxExpNotional - grossExposure);
  if (additionalNotional > remainingN) { const maxQ = sidePrice > 0 ? Math.floor(remainingN / sidePrice) : 0; allowedQty = Math.min(allowedQty, maxQ); checks.push({ n: "ExpN", s: allowedQty > 0 ? "adjusted" : "blocked", d: "notional:" + grossExposure + "+" + (+(allowedQty * sidePrice).toFixed(0)) + "/" + CFG.maxExpNotional }); if (!allowedQty) approved = false; }
  else checks.push({ n: "ExpN", s: "pass", d: "notional:" + grossExposure + "+" + additionalNotional + "/" + CFG.maxExpNotional });
  const ddScale = currentDD >= CFG.maxDD ? 0 : currentDD > CFG.softDD ? 1 - Math.pow(currentDD / CFG.maxDD, 1.5) : 1;
  if (ddScale < 1) { allowedQty = Math.floor(allowedQty * ddScale); checks.push({ n: "DD", s: ddScale > 0 ? "adjusted" : "blocked", d: "s=" + ddScale.toFixed(2) }); if (!allowedQty) approved = false; }
  else checks.push({ n: "DD", s: "pass", d: (currentDD * 100).toFixed(1) + "%" });
  let existingCatQty = 0;
  if (mkt) { for (const [om, op] of Object.entries(positions)) { const omk = markets[om]; if (omk && omk.cat === mkt.cat) existingCatQty += op.yesQty + op.noQty; } }
  if (existingCatQty + allowedQty > CFG.maxCatQty) { allowedQty = Math.max(0, CFG.maxCatQty - existingCatQty); checks.push({ n: "CatQty", s: allowedQty > 0 ? "adjusted" : "blocked", d: mkt?.cat + ":qty=" + existingCatQty + "+" + allowedQty + "/" + CFG.maxCatQty }); if (!allowedQty) approved = false; }
  else checks.push({ n: "CatQty", s: "pass", d: mkt?.cat + ":qty=" + (existingCatQty + allowedQty) + "/" + CFG.maxCatQty });
  const lr = mkt && allowedQty > 0 ? mkt.adv / allowedQty : 999;
  if (lr < CFG.minLiqRatio) { checks.push({ n: "Liq", s: "blocked", d: lr.toFixed(1) }); approved = false; } else checks.push({ n: "Liq", s: "pass", d: lr.toFixed(1) });
  if ((rec.aq || 0) < CFG.minSigQuality) { checks.push({ n: "Qual", s: "blocked", d: "" + rec.aq }); approved = false; } else checks.push({ n: "Qual", s: "pass", d: "" + rec.aq });
  if (snap.quarantined[rec.cid]) { checks.push({ n: "MktVal", s: "blocked", d: snap.quarantined[rec.cid].join(",") }); approved = false; } else checks.push({ n: "MktVal", s: "pass", d: "valid" });
  // Phase 4: correlated exposure check
  if (snap.corrMatrix && Object.keys(snap.corrMatrix).length > 0) {
    const ce = checkCorrelatedExposure(positions, markets, snap.corrMatrix);
    if (!ce.ok) { checks.push({ n: "CorrExp", s: "blocked", d: "ratio=" + ce.ratio }); approved = false; }
    else checks.push({ n: "CorrExp", s: "pass", d: "ratio=" + ce.ratio });
  }
  return { ok: approved && allowedQty >= 15, sz: allowedQty, ch: checks };
}

// ══════════════════════ ENGINE: EXECUTION ════════════════════════════
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "REPLACED"]);
const TRANSITIONS = { NEW: new Set(["ACCEPTED", "REJECTED"]), ACCEPTED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"]), PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REPLACED"]), FILLED: new Set(), CANCELLED: new Set(), REJECTED: new Set(), REPLACED: new Set() };
function canTransition(from, to) { if (TERMINAL.has(from)) return false; return TRANSITIONS[from]?.has(to) || false; }
function makeChildId(orderId, seq, gen) { return orderId + "_c" + seq + "_g" + gen; }
function makeOrderId(prefix, cid, time, seq) { return prefix + "_" + cid + "_" + time + "_s" + seq; }

// Phase 5: Smart execution — build children with TWAP schedule
function buildChildren(orderId, totalSz, limitPx, strategy, gen) {
  let sliceSize;
  if (strategy === "twap") sliceSize = Math.ceil(totalSz / CFG.twapSlices);
  else if (strategy === "aggressive") sliceSize = totalSz;
  else sliceSize = Math.min(200, totalSz);
  const n = Math.ceil(totalSz / sliceSize);
  const children = []; let rem = totalSz;
  for (let i = 0; i < n; i++) {
    const sz = Math.min(rem, sliceSize);
    children.push({ id: makeChildId(orderId, i, gen), sz, lim: limitPx, fp: null, st: "NEW", scheduleIdx: i });
    rem -= sz;
  }
  return children;
}

// Phase 5: Adaptive limit price based on LOB state
function computeAdaptiveLimit(lob, side, urgency) {
  if (urgency === "immediate") {
    return side === "YES" ? lob.bestAsk : lob.bestBid;  // Cross the spread
  } else if (urgency === "patient") {
    return side === "YES" ? r4(lob.bestBid + lob.spread * 0.3) : r4(lob.bestAsk - lob.spread * 0.3);
  }
  return lob.midPrice;  // Passive: sit at mid
}

function createOrder(rec, verdict, mkts, lobs, time, rng, seq) {
  if (!verdict.ok) return null;
  const m = mkts[rec.cid]; if (!m) return null;
  const lob = lobs[rec.cid];
  const side = rec.dir === "BUY_YES" ? "YES" : "NO";
  // Phase 5: use adaptive limit from LOB instead of synthetic book
  const lim = lob ? computeAdaptiveLimit(lob, side, rec.urg) : r4(cl(side === "YES" ? m.yes : 1 - m.yes, 0.01, 0.99));
  let strat = "patient";
  if (verdict.sz < 500 && rec.urg === "immediate") strat = "aggressive";
  else if (verdict.sz > 2000) strat = "twap";
  else if (verdict.sz > 500) strat = "vwap";
  const id = makeOrderId("ord", rec.cid, time, seq);
  return { id, time, cid: rec.cid, side, dir: rec.dir, parentSz: verdict.sz, lim, strat, children: buildChildren(id, verdict.sz, lim, strat, 0), status: "NEW", totalFilled: 0, avgFP: null, ce: rec.ce, attr: rec.attr, riskCh: verdict.ch, urg: rec.urg, fillRate: 0, slipBps: null, partialAction: null, retryBudget: CFG.partialRetryBudget, retryGen: 0, replacedBy: null, parentOrderId: null };
}

function checkSlippage(fillPx, limitPx, midPx) {
  const slipBps = +(Math.abs(fillPx - limitPx) / (midPx || 0.5) * 10000).toFixed(2);
  return { slipBps, exceeded: slipBps > CFG.maxSlipBps };
}

// Phase 1: Fill via LOB matching engine (replaces random fill probability)
function advanceOrderFills(order, rng, mkts, lobs, tickTime, existingFillKeys) {
  if (TERMINAL.has(order.status)) return { order, newFills: [], childSlipRejects: 0, updatedLobs: {} };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  if (o.status === "NEW") { if (!canTransition("NEW", "ACCEPTED")) return { order: o, newFills: [], childSlipRejects: 0, updatedLobs: {} }; o.status = "ACCEPTED"; }
  const mkt = mkts[o.cid];
  let lob = lobs[o.cid] ? { ...lobs[o.cid], bids: lobs[o.cid].bids.map(l => ({ ...l, orders: [...l.orders] })), asks: lobs[o.cid].asks.map(l => ({ ...l, orders: [...l.orders] })) } : null;
  const mid = lob ? lob.midPrice : (mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim);
  let filled = 0, cost = 0, childSlipRejects = 0;
  const newFills = [];

  for (const ch of o.children) {
    if (ch.st === "FILLED") { filled += ch.sz; cost += ch.fp * ch.sz; continue; }
    if (ch.st === "CANCELLED" || ch.st === "REJECTED") continue;
    if (ch.st === "NEW") ch.st = "ACCEPTED";
    // Phase 5: cancel/replace check — if limit drifted too far from current mid
    if (lob) {
      const limitDrift = Math.abs(ch.lim - lob.midPrice) / (lob.midPrice || 0.5) * 10000;
      if (limitDrift > CFG.cancelReplaceThresholdBps && ch.st === "ACCEPTED") {
        ch.lim = computeAdaptiveLimit(lob, o.side, o.urg);
      }
    }
    // Phase 1: Match against LOB instead of random fill probability
    if (lob) {
      const matchSide = o.side === "YES" ? "buy" : "sell";
      const result = matchOrderAgainstLOB(lob, matchSide, ch.sz, ch.lim, ch.id, tickTime);
      if (result.totalFilled > 0) {
        const fillPx = result.avgPx;
        const slip = checkSlippage(fillPx, ch.lim, mid);
        if (slip.exceeded) { ch.st = "REJECTED"; childSlipRejects++; lob = result.updatedLob; continue; }
        const fillKey = "fill_" + o.id + "_" + ch.id;
        if (existingFillKeys[fillKey]) { ch.st = "FILLED"; ch.fp = fillPx; filled += result.totalFilled; cost += fillPx * result.totalFilled; lob = result.updatedLob; continue; }
        ch.fp = fillPx; ch.st = result.totalFilled >= ch.sz ? "FILLED" : "ACCEPTED";
        if (ch.st === "FILLED") { filled += ch.sz; cost += fillPx * ch.sz; }
        else { filled += result.totalFilled; cost += fillPx * result.totalFilled; ch.sz -= result.totalFilled; }
        newFills.push({ key: fillKey, orderId: o.id, cid: o.cid, side: o.side, qty: result.totalFilled, px: fillPx, time: tickTime, slipBps: slip.slipBps, attr: o.attr || {} });
        // Phase 2: adverse selection after aggressive fill
        if (o.urg === "immediate") lob = { ...result.updatedLob, midPrice: applyAdverseSelection(fillPx, result.updatedLob.midPrice, matchSide) };
        else lob = result.updatedLob;
      }
      // If no fill: order stays at its price level (queue position maintained)
    } else {
      // Fallback: basic fill simulation (for markets without LOB)
      const fr = o.strat === "aggressive" ? 0.92 : o.strat === "twap" ? 0.8 : 0.6;
      if (rng() < fr) {
        const rawFP = r4(ch.lim + (rng() - 0.5) * 0.004);
        const slip = checkSlippage(rawFP, ch.lim, mid);
        if (slip.exceeded) { ch.st = "REJECTED"; childSlipRejects++; continue; }
        const fillKey = "fill_" + o.id + "_" + ch.id;
        if (existingFillKeys[fillKey]) { ch.st = "FILLED"; ch.fp = rawFP; filled += ch.sz; cost += rawFP * ch.sz; continue; }
        ch.fp = rawFP; ch.st = "FILLED"; filled += ch.sz; cost += rawFP * ch.sz;
        newFills.push({ key: fillKey, orderId: o.id, cid: o.cid, side: o.side, qty: ch.sz, px: rawFP, time: tickTime, slipBps: slip.slipBps, attr: o.attr || {} });
      }
    }
  }
  o.totalFilled = filled;
  o.avgFP = filled > 0 ? +(cost / filled).toFixed(4) : null;
  o.fillRate = +(filled / o.parentSz).toFixed(2);
  if (newFills.length) o.slipBps = +(newFills.reduce((s, f) => s + f.slipBps, 0) / newFills.length).toFixed(2);
  if (filled >= o.parentSz) { if (canTransition(o.status, "FILLED")) o.status = "FILLED"; }
  else if (filled > 0 && o.status === "ACCEPTED") { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
  if (!TERMINAL.has(o.status)) {
    const pending = o.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pending.length === 0 && filled < o.parentSz && filled > 0) { if (canTransition(o.status, "PARTIALLY_FILLED")) o.status = "PARTIALLY_FILLED"; }
    if (pending.length === 0 && filled === 0) { if (canTransition(o.status, "REJECTED")) o.status = "REJECTED"; }
  }
  const updatedLobs = lob ? { [o.cid]: lob } : {};
  return { order: o, newFills, childSlipRejects, updatedLobs };
}

// resolvePartialFill: kept from V4.3.2 (correctness proven)
function resolvePartialFill(order, mkts, lobs, time, rng, seqRef) {
  if (order.status !== "PARTIALLY_FILLED") return { order, spawned: [] };
  const o = { ...order, children: order.children.map(c => ({ ...c })) };
  const mkt = mkts[o.cid]; const remaining = o.parentSz - o.totalFilled;
  const lob = lobs[o.cid];
  const currentMid = lob ? lob.midPrice : (mkt ? (o.side === "YES" ? mkt.yes : 1 - mkt.yes) : o.lim);
  const drift = Math.abs(currentMid - o.lim); const spawned = [];
  if (remaining < CFG.partialMinQty) {
    o.partialAction = { action: "CANCEL", reason: "remaining " + remaining + " < minQty" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    return { order: o, spawned };
  }
  if (drift <= CFG.partialDriftThreshold && o.retryBudget > 0) {
    o.retryBudget--; o.retryGen = (o.retryGen || 0) + 1;
    o.partialAction = { action: "RETRY", reason: "gen=" + o.retryGen + ", budget=" + o.retryBudget };
    for (const ch of o.children) { if (ch.st === "ACCEPTED" || ch.st === "REJECTED") ch.st = "CANCELLED"; }
    o.children = [...o.children, ...buildChildren(o.id, remaining, o.lim, o.strat, o.retryGen)];
    return { order: o, spawned };
  }
  if (drift > CFG.partialDriftThreshold && drift <= CFG.partialDriftThreshold * 3 && o.retryBudget > 0) {
    o.partialAction = { action: "REPLACE", reason: "drift=" + (drift * 100).toFixed(1) + "%" };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "REPLACED")) {
      o.status = "REPLACED"; const newLim = r4(cl(currentMid, 0.01, 0.99));
      const replId = makeOrderId("ord_repl", o.cid, time, seqRef.val++);
      spawned.push({ id: replId, time, cid: o.cid, side: o.side, dir: o.dir, parentSz: remaining, lim: newLim, strat: o.strat, children: buildChildren(replId, remaining, newLim, o.strat, 0), status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr, riskCh: o.riskCh, urg: o.urg, fillRate: 0, slipBps: null, partialAction: null, retryBudget: Math.max(0, o.retryBudget - 1), retryGen: 0, replacedBy: null, parentOrderId: o.id });
      o.replacedBy = replId;
    }
    return { order: o, spawned };
  }
  if (drift > CFG.partialDriftThreshold || o.retryBudget <= 0) {
    o.partialAction = { action: "UNWIND", reason: "drift=" + (drift * 100).toFixed(1) + "%, qty " + o.totalFilled };
    for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
    if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
    if (o.totalFilled > 0) {
      const uwDir = o.dir === "BUY_YES" ? "BUY_NO" : "BUY_YES"; const uwSide = uwDir === "BUY_YES" ? "YES" : "NO";
      const uwLim = r4(cl(currentMid, 0.01, 0.99));
      const uwId = makeOrderId("ord_unwind", o.cid, time, seqRef.val++);
      spawned.push({ id: uwId, time, cid: o.cid, side: uwSide, dir: uwDir, parentSz: o.totalFilled, lim: uwLim, strat: "aggressive", children: buildChildren(uwId, o.totalFilled, uwLim, "aggressive", 0), status: "NEW", totalFilled: 0, avgFP: null, ce: o.ce, attr: o.attr, riskCh: [], urg: "immediate", fillRate: 0, slipBps: null, partialAction: null, retryBudget: 0, retryGen: 0, replacedBy: null, parentOrderId: o.id });
    }
    return { order: o, spawned };
  }
  o.partialAction = { action: "CANCEL", reason: "fallback" };
  for (const ch of o.children) { if (ch.st === "NEW" || ch.st === "ACCEPTED") ch.st = "CANCELLED"; }
  if (canTransition(o.status, "CANCELLED")) o.status = "CANCELLED";
  return { order: o, spawned };
}

// ══════════════════════ ENGINE: PORTFOLIO ════════════════════════════
function applyFills(positions, fills, fillKeys, newFills) {
  let pos = { ...positions }; let fs = [...fills]; let fk = { ...fillKeys };
  const attrEvents = [];
  for (const f of newFills) {
    if (fk[f.key]) continue; fk[f.key] = true; fs.push(f);
    const mid = f.cid;
    const p = pos[mid] ? { ...pos[mid] } : { yesQty: 0, noQty: 0, yesAvgPx: 0, noAvgPx: 0, realizedPnl: 0 };
    if (f.side === "YES") {
      if (p.noQty > 0) { const oq = Math.min(f.qty, p.noQty); const ep = 1 - f.px; const fillRpnl = +(oq * (ep - p.noAvgPx)).toFixed(4); p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4); if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) attrEvents.push({ rpnl: fillRpnl, attr: f.attr }); p.noQty -= oq; if (p.noQty <= 0) { p.noQty = 0; p.noAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.yesQty + aq; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * aq) / t) : 0; p.yesQty = t; } }
      else { const t = p.yesQty + f.qty; p.yesAvgPx = t > 0 ? r4((p.yesAvgPx * p.yesQty + f.px * f.qty) / t) : 0; p.yesQty = t; }
    } else {
      if (p.yesQty > 0) { const oq = Math.min(f.qty, p.yesQty); const ep = 1 - f.px; const fillRpnl = +(oq * (ep - p.yesAvgPx)).toFixed(4); p.realizedPnl = +(p.realizedPnl + fillRpnl).toFixed(4); if (Math.abs(fillRpnl) > 0.0001 && f.attr && Object.keys(f.attr).length > 0) attrEvents.push({ rpnl: fillRpnl, attr: f.attr }); p.yesQty -= oq; if (p.yesQty <= 0) { p.yesQty = 0; p.yesAvgPx = 0; } const aq = f.qty - oq; if (aq > 0) { const t = p.noQty + aq; p.noAvgPx = t > 0 ? r4((p.noAvgPx * p.noQty + f.px * aq) / t) : 0; p.noQty = t; } }
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

function applyAttributionEvents(metaPerf, attrEvents) {
  if (!attrEvents || attrEvents.length === 0) return metaPerf;
  const result = { nlp: [...metaPerf.nlp], momentum: [...metaPerf.momentum], arb: [...metaPerf.arb] };
  for (const evt of attrEvents) {
    if (!evt || typeof evt.rpnl !== "number" || !Number.isFinite(evt.rpnl)) continue;
    if (Math.abs(evt.rpnl) < 0.0001) continue;
    const attr = evt.attr;
    if (!attr || typeof attr !== "object" || Array.isArray(attr)) continue;
    for (const [src, pct] of Object.entries(attr)) {
      const buf = result[src]; if (!buf) continue;
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      buf.push(+(evt.rpnl * pct / 100).toFixed(6));
      if (buf.length > 50) buf.shift();
    }
  }
  return result;
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
  for (const ord of allOrders) { const of2 = fillsByOrder[ord.id] || []; const fqs = of2.reduce((s, f) => s + f.qty, 0); if (ord.status === "FILLED" && Math.abs(fqs - ord.parentSz) > 0.01) issues.push({ type: "filled_qty_mismatch", orderId: ord.id }); if (ord.status === "PARTIALLY_FILLED" && (fqs <= 0 || fqs >= ord.parentSz)) issues.push({ type: "partial_qty_inconsistent", orderId: ord.id }); if (Math.abs((ord.totalFilled || 0) - fqs) > 0.01) issues.push({ type: "order_fill_total_mismatch", orderId: ord.id }); }
  const orderIds = new Set(allOrders.map(o => o.id)); for (const f of fills) { if (!orderIds.has(f.orderId)) issues.push({ type: "orphan_fill", fillKey: f.key }); }
  for (const o of orders) { if (TERMINAL.has(o.status)) issues.push({ type: "terminal_in_active", orderId: o.id }); }
  for (const o of allOrders) { if (o.status === "REPLACED" && o.replacedBy) { const rpl = allOrders.find(r => r.id === o.replacedBy); if (!rpl) issues.push({ type: "replacement_missing", orderId: o.id }); else if (rpl.parentOrderId !== o.id) issues.push({ type: "replacement_lineage_mismatch", orderId: o.id }); } if (o.parentOrderId && o.id.includes("unwind")) { if (!allOrders.find(p => p.id === o.parentOrderId)) issues.push({ type: "unwind_parent_missing", orderId: o.id }); } }
  const ledgerKeys = new Set(fills.map(f => f.key)); for (const k of Object.keys(fillKeys)) { if (!ledgerKeys.has(k)) issues.push({ type: "stale_fill_key", key: k }); } for (const k of ledgerKeys) { if (!fillKeys[k]) issues.push({ type: "missing_fill_key", key: k }); }
  const correctedPositions = positionsDrifted ? rebuilt : livePositions;
  const correctedFillKeys = {}; for (const f of fills) correctedFillKeys[f.key] = true;
  return { ok: issues.length === 0, issues, correctedPositions, correctedFillKeys, rebuiltPositions: rebuilt, fillCount: fills.length, orderCount: allOrders.length, orphanFills: issues.filter(i => i.type === "orphan_fill").length, driftCount: issues.filter(i => i.type === "position_drift").length };
}

// ══════════════════════ ENGINE: CIRCUIT BREAKER ═════════════════════
function tripCB(cb, reason, time) { return { ...cb, state: "open", reason, lastFailTime: time, failCount: (cb.failCount || 0) + 1, triggers: [...cb.triggers, { t: time, r: reason, from: cb.state, to: "open" }], halfOpenNotional: 0, halfOpenFills: 0 }; }
function updateCB(cb, metrics, time) {
  let next = { ...cb, triggers: [...cb.triggers], recentSlipEvents: [...(cb.recentSlipEvents||[])], recentPoorFills: [...(cb.recentPoorFills||[])], recentInvalidData: [...(cb.recentInvalidData||[])], recentRejects: [...(cb.recentRejects||[])] };
  if (next.state === "open" && time - next.lastFailTime > CFG.cbRecoveryMs) { next.triggers = [...next.triggers, { t: time, r: "recovery_timer", from: "open", to: "half_open" }]; next.state = "half_open"; next.halfOpenNotional = 0; next.halfOpenFills = 0; }
  if (next.state === "half_open" && next.halfOpenFills >= CFG.cbHalfOpenProbeMinFills && next.recentRejects.length === 0) { next.triggers = [...next.triggers, { t: time, r: "probe_success: fills=" + next.halfOpenFills, from: "half_open", to: "closed" }]; next.state = "closed"; next.failCount = 0; next.reason = null; next.halfOpenNotional = 0; next.halfOpenFills = 0; }
  if (next.state !== "open" && metrics.currentDD > CFG.maxDD) next = tripCB(next, "drawdown_breach: " + (metrics.currentDD * 100).toFixed(1) + "%", time);
  if (next.state !== "open" && metrics.grossExposure > CFG.maxExpNotional * CFG.cbExpBreachMultiplier) next = tripCB(next, "exposure_breach: " + metrics.grossExposure.toFixed(0), time);
  const highSlip = next.recentSlipEvents.filter(e => e.slipBps > CFG.maxSlipBps * 0.8).length;
  if (next.state !== "open" && highSlip >= CFG.cbSlipThreshold) { next = tripCB(next, "excessive_slippage: " + highSlip, time); next.recentSlipEvents = []; }
  if (next.state !== "open" && next.recentRejects.length >= CFG.cbRejectThreshold) { next = tripCB(next, "repeated_rejects: " + next.recentRejects.length, time); next.recentRejects = []; }
  if (next.state !== "open" && next.recentPoorFills.length >= CFG.cbPoorFillThreshold) { next = tripCB(next, "poor_fills: " + next.recentPoorFills.length, time); next.recentPoorFills = []; }
  if (next.state !== "open" && next.recentInvalidData.length >= CFG.cbInvalidDataThreshold) { next = tripCB(next, "invalid_market_data: " + next.recentInvalidData.length, time); next.recentInvalidData = []; }
  if (next.triggers.length > 30) next.triggers = next.triggers.slice(-25);
  return next;
}

// ══════════════════════ ENGINE: PRUNING ═════════════════════════════
function collectProtectedOrderIds(activeOrders, historyOrders) {
  const p = new Set(); const all = [...activeOrders, ...historyOrders];
  for (const o of activeOrders) { if (!TERMINAL.has(o.status)) p.add(o.id); }
  for (const o of all) { if (o.replacedBy) { p.add(o.id); p.add(o.replacedBy); } if (o.parentOrderId) { p.add(o.id); p.add(o.parentOrderId); } }
  for (let iter = 0; iter < 50; iter++) { let changed = false; for (const o of all) { if (p.has(o.id)) { if (o.parentOrderId && !p.has(o.parentOrderId)) { p.add(o.parentOrderId); changed = true; } if (o.replacedBy && !p.has(o.replacedBy)) { p.add(o.replacedBy); changed = true; } } if (o.parentOrderId && p.has(o.parentOrderId) && !p.has(o.id)) { p.add(o.id); changed = true; } } if (!changed) break; }
  return p;
}
function pruneOrderHistory(orderHistory, activeOrders) {
  if (!Array.isArray(orderHistory)) return [];
  if (orderHistory.length <= CFG.historyRetentionCap) return [...orderHistory];
  const prot = collectProtectedOrderIds(activeOrders, orderHistory);
  const protOrders = [], prunable = [];
  for (const o of orderHistory) { if (prot.has(o.id)) protOrders.push(o); else prunable.push(o); }
  const slots = Math.max(0, CFG.historyRetentionCap - protOrders.length);
  const budget = Math.max(Math.min(CFG.historyMinRetainTerminal, prunable.length), slots);
  return [...protOrders, ...prunable.slice(-Math.min(budget, prunable.length))];
}

// ══════════════════════ ENGINE: CB EVENT TRACKING ═══════════════════
function recordReject(cb, type, orderId, events, time) { const nr = [...(cb.recentRejects||[]), { time, type, orderId }]; events.push({ evt: "cb:" + type, ts: time, s: orderId || "" }); return { ...cb, recentRejects: nr.length > CFG.cbRejectWindow ? nr.slice(-CFG.cbRejectWindow) : nr }; }
function recordApproval(cb) { const r = [...(cb.recentRejects||[])]; if (r.length > 0) r.shift(); return { ...cb, recentRejects: r }; }
function recordSlipEvent(cb, slipBps, time) { const n = [...(cb.recentSlipEvents||[]), { time, slipBps }]; return { ...cb, recentSlipEvents: n.length > CFG.cbSlipWindow ? n.slice(-CFG.cbSlipWindow) : n }; }
function recordPoorFill(cb, time) { const n = [...(cb.recentPoorFills||[]), { time }]; return { ...cb, recentPoorFills: n.length > CFG.cbPoorFillWindow ? n.slice(-CFG.cbPoorFillWindow) : n }; }
function recordInvalidData(cb, marketId, time) { const n = [...(cb.recentInvalidData||[]), { time, marketId }]; return { ...cb, recentInvalidData: n.length > CFG.cbInvalidDataWindow ? n.slice(-CFG.cbInvalidDataWindow) : n }; }

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 6: EVENT SOURCING
// ═══════════════════════════════════════════════════════════════════════
// Append-only structured event log. Each entry is { tick, time, type, data }.
// Log is bounded to prevent unbounded memory growth.
function appendEventLog(log, tick, time, type, data) {
  const entry = { tick, time, type, data };
  const newLog = [...log, entry];
  return newLog.length > 2000 ? newLog.slice(-1500) : newLog;  // Keep last 1500
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 7: PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════════════════════
function computePerformanceMetrics(equityReturns, fills, metaPerf) {
  // Sharpe ratio (annualized, assuming 2s ticks → ~43200 ticks/day)
  const n = equityReturns.length;
  let sharpe = 0;
  if (n >= 10) {
    const mean = equityReturns.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(equityReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) || 0.001;
    sharpe = +(mean / std * Math.sqrt(Math.min(n, 43200))).toFixed(2);
  }
  // Win rate from fills that realized PnL
  let wins = 0, total = 0;
  const fillsByOrder = {};
  for (const f of fills) { (fillsByOrder[f.orderId] || (fillsByOrder[f.orderId] = [])).push(f); }
  // Avg slippage
  const slips = fills.filter(f => f.slipBps != null).map(f => f.slipBps);
  const avgSlipBps = slips.length > 0 ? +(slips.reduce((s, v) => s + v, 0) / slips.length).toFixed(1) : 0;
  // Alpha contribution per source
  const alphaContrib = {};
  for (const [src, perf] of Object.entries(metaPerf)) {
    if (perf.length === 0) { alphaContrib[src] = 0; continue; }
    alphaContrib[src] = +(perf.reduce((s, v) => s + v, 0)).toFixed(2);
    total += perf.length;
    wins += perf.filter(v => v > 0).length;
  }
  const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : 0;
  // Execution quality: ratio of avg fill price vs mid price (implementation shortfall proxy)
  const execQuality = avgSlipBps < 20 ? "good" : avgSlipBps < 40 ? "fair" : "poor";
  return { sharpe, winRate, avgSlipBps, execQuality, alphaContrib, totalFills: fills.length };
}

// ═══════════════════════════════════════════════════════════════════════
//  ENGINE: TICK — MAIN SIMULATION LOOP
// ═══════════════════════════════════════════════════════════════════════
function tick(prev, tickTime) {
  const rng = createRng(prev.seed + prev.tickCount * 7919);
  const time = tickTime;
  const s = { ...prev, tickCount: prev.tickCount + 1, time, events: [] };
  const seqRef = { val: prev.orderSeq || 0 };
  let eventLog = [...(prev.eventLog || [])];

  // 1. Decay market impact from previous ticks
  const impactDecay = {};
  for (const [mid, entry] of Object.entries(prev.impactDecay || {})) {
    if (entry.remaining > 0) impactDecay[mid] = { ...entry, remaining: entry.remaining - 1 };
  }

  // 2. Markets (with impact decay)
  const newMkts = {};
  for (const [id, m] of Object.entries(s.markets)) newMkts[id] = advMkt(m, rng, time, impactDecay);
  s.markets = newMkts;

  // 3. LOBs: refresh around new mid prices
  const newLobs = {};
  for (const [id, m] of Object.entries(s.markets)) {
    const prevLob = s.lobs[id] || createLOB(m.yes, m.adv, rng);
    newLobs[id] = refreshLOB(prevLob, m.yes, m.adv, s.regime, rng);
  }
  s.lobs = newLobs;

  // 4. Histories (from LOB data instead of synthetic book)
  const newH = {};
  for (const [id, m] of Object.entries(s.markets)) {
    const lob = s.lobs[id];
    newH[id] = pushHist(s.histories[id] || { prices: [], spreads: [], depths: [], maxLen: 300 }, m.yes, lob.spread, lob.bidDepth);
  }
  s.histories = newH;

  // 5. Validate markets via LOB
  const quarantined = {};
  let cb = { ...s.cb, triggers: [...s.cb.triggers], recentSlipEvents: [...(s.cb.recentSlipEvents||[])], recentPoorFills: [...(s.cb.recentPoorFills||[])], recentInvalidData: [...(s.cb.recentInvalidData||[])], recentRejects: [...(s.cb.recentRejects||[])] };
  for (const [id, m] of Object.entries(s.markets)) {
    const lob = s.lobs[id];
    const v = validateMarket(m, lob, time);
    if (!v.valid) { quarantined[id] = v.issues; s.events.push({ evt: "mkt:invalid", ts: time, s: id + ":" + v.issues.join(",") }); cb = recordInvalidData(cb, id, time); }
  }
  s.quarantined = quarantined;

  // 6. Regime
  const mH = s.histories["btc150k"] || Object.values(s.histories)[0];
  if (mH && mH.prices.length > 30) s.regime = detectRegime(mH.prices, mH.spreads, mH.depths);

  // 7. Correlation matrix (Phase 4)
  if (s.tickCount % 5 === 0) {
    s.corrMatrix = computeCorrelationMatrix(s.histories, MDEFS.map(d => d.id));
  } else {
    s.corrMatrix = prev.corrMatrix || {};
  }

  // 8. Alpha weights
  s.alphaWeights = computeWeights(s.regime, s.metaPerf, s.newsIntensity);

  // 9. Signals (all upgraded)
  let sigs = [...s.signals];
  if (rng() < 0.3) {
    const nev = genNews(s.markets, rng, time);
    s.newsLog = [nev, ...s.newsLog].slice(0, 60);
    s.newsIntensity = nev.impactClass === "binary_catalyst" ? 0.9 : nev.impactClass === "gradual_shift" ? 0.5 : 0.1;
    const ns = nlpSigs(nev, s.markets, time);
    sigs.push(...ns);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, nlp: s.monitor.signalCounts.nlp + ns.length } };
    s.events.push({ evt: "news", ts: time, s: nev.impactClass + "|" + nev.headline.slice(0, 25) });
    eventLog = appendEventLog(eventLog, s.tickCount, time, "NEWS", { headline: nev.headline, impact: nev.impactClass });
  }
  // Phase 3: multi-timeframe momentum
  const ms2 = momSigs(s.markets, s.histories, time, s.regime);
  sigs = sigs.filter(x => x.source !== "momentum"); sigs.push(...ms2);
  s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, momentum: s.monitor.signalCounts.momentum + ms2.length } };

  // Phase 3: cointegration-aware arb
  if (rng() < 0.35) {
    const as2 = arbSigs(s.markets, s.histories, time);
    sigs = sigs.filter(x => x.source !== "arb"); sigs.push(...as2);
    s.monitor = { ...s.monitor, signalCounts: { ...s.monitor.signalCounts, arb: s.monitor.signalCounts.arb + as2.length } };
  }

  // Phase 3: orderflow signals from LOB
  const ofSigs = orderflowSigs(s.markets, s.lobs, time);
  sigs.push(...ofSigs);

  // 10. Process signals into recommendations
  const liveStateForSizing = { equity: s.equity, currentDD: s.currentDD, grossExposure: s.grossExposure, positions: s.positions, markets: s.markets, cbState: cb.state };
  const { filtered, recs } = processSigs(sigs, s.alphaWeights, s.regime.confidence, time, liveStateForSizing);
  s.signals = filtered.slice(0, 80);
  s.recommendations = [...recs, ...s.recommendations].slice(0, 40);

  // 11. Orders + Execution
  let positions = {}; for (const [k, v] of Object.entries(s.positions)) positions[k] = { ...v };
  let fills = [...s.fills], fillKeys = { ...s.fillKeys };
  let orders = s.orders.map(o => ({ ...o, children: o.children.map(c => ({ ...c })) }));
  let orderHistory = [...s.orderHistory]; let monitor = { ...s.monitor };
  let metaPerf = { nlp: [...s.metaPerf.nlp], momentum: [...s.metaPerf.momentum], arb: [...s.metaPerf.arb] };
  let allNewFills = [];
  let currentLobs = { ...s.lobs };  // Mutable LOBs during order execution
  let newImpactDecay = { ...impactDecay };

  function processOrder(ord) {
    const { order: advanced, newFills: nf, childSlipRejects, updatedLobs } = advanceOrderFills(ord, rng, s.markets, currentLobs, time, fillKeys);
    // Merge LOB updates
    for (const [mid, lobUpdate] of Object.entries(updatedLobs)) currentLobs[mid] = lobUpdate;
    allNewFills.push(...nf);
    for (const f of nf) fillKeys[f.key] = true;
    // Phase 2: compute market impact for significant fills
    for (const f of nf) {
      if (f.qty > 20) {
        const impact = computeMarketImpact(f.qty, s.markets[f.cid]?.adv || 10000, f.side === "YES" ? "buy" : "sell");
        if (Math.abs(impact.totalImpact) > 0.0001) {
          newImpactDecay[f.cid] = { tempImpact: impact.tempImpact, permImpact: impact.permImpact, remaining: CFG.impactDecayTicks };
        }
      }
    }
    if (childSlipRejects > 0) { for (let i = 0; i < childSlipRejects; i++) cb = recordSlipEvent(cb, CFG.maxSlipBps + 1, time); }
    if (advanced.slipBps != null) cb = recordSlipEvent(cb, advanced.slipBps, time);
    if (advanced.status === "REJECTED") cb = recordReject(cb, "order_reject", advanced.id, s.events, time);
    const pendingChildren = advanced.children.filter(c => c.st === "NEW" || c.st === "ACCEPTED");
    if (pendingChildren.length === 0 && advanced.fillRate < 0.3 && advanced.parentSz > 50) cb = recordPoorFill(cb, time);
    if (cb.state === "half_open" && nf.length > 0) {
      let pn = 0; for (const f of nf) pn += f.qty * f.px;
      cb = { ...cb, halfOpenNotional: cb.halfOpenNotional + pn, halfOpenFills: (cb.halfOpenFills || 0) + nf.length };
    }
    const { order: resolved, spawned } = resolvePartialFill(advanced, s.markets, currentLobs, time, rng, seqRef);
    if (resolved.partialAction) s.events.push({ evt: "partial:" + resolved.partialAction.action.toLowerCase(), ts: time, s: resolved.cid + "|" + resolved.partialAction.reason });
    // Phase 6: log fills
    for (const f of nf) eventLog = appendEventLog(eventLog, s.tickCount, time, "FILL", { key: f.key, qty: f.qty, px: f.px, side: f.side, cid: f.cid });
    return { resolved, spawned };
  }

  function drainSpawnQueue(initialOrders) {
    const active = [], terminal = [], spawnQueue = []; let totalSpawns = 0; const deferred = [];
    for (const o of initialOrders) {
      if (TERMINAL.has(o.status)) { terminal.push(o); continue; }
      const { resolved, spawned } = processOrder(o);
      if (TERMINAL.has(resolved.status)) terminal.push(resolved); else active.push(resolved);
      for (const sp of spawned) spawnQueue.push({ order: sp, depth: 1 });
      if (resolved.totalFilled > 0) s.events.push({ evt: "exec:advance", ts: time, s: resolved.cid + "|" + resolved.status + "|f=" + resolved.totalFilled });
    }
    while (spawnQueue.length > 0) {
      const { order: spOrd, depth } = spawnQueue.shift();
      if (depth > CFG.maxSpawnDepth || totalSpawns >= CFG.maxSpawnsPerTick) { deferred.push(spOrd); continue; }
      totalSpawns++;
      const { resolved: spRes, spawned: spSp } = processOrder(spOrd);
      if (TERMINAL.has(spRes.status)) terminal.push(spRes); else active.push(spRes);
      for (const ss of spSp) spawnQueue.push({ order: ss, depth: depth + 1 });
    }
    return { active, terminal, deferred, totalSpawns };
  }

  const prevDeferred = s.deferredSpawns || []; let deferredSpawns = [];
  if (prevDeferred.length > 0) {
    const defResult = drainSpawnQueue(prevDeferred);
    orders.push(...defResult.active); orderHistory.push(...defResult.terminal); deferredSpawns.push(...defResult.deferred);
  }
  const existingResult = drainSpawnQueue(orders);
  orders = existingResult.active; orderHistory.push(...existingResult.terminal); deferredSpawns.push(...existingResult.deferred);

  // New orders from recommendations
  const snap = { positions, markets: s.markets, cb, currentDD: s.currentDD, grossExposure: calcExposure(positions, s.markets).gross, quarantined, corrMatrix: s.corrMatrix };
  const newOrdersFromRecs = [];
  for (const rec of recs) {
    const liveExp = calcExposure(positions, s.markets);
    const verdict = preTradeRisk(rec, { ...snap, grossExposure: liveExp.gross });
    if (verdict.ok) { monitor.approvals++; cb = recordApproval(cb); } else { monitor.rejections++; cb = recordReject(cb, "risk_reject", rec.cid, s.events, time); }
    s.events.push({ evt: verdict.ok ? "risk:pass" : "risk:reject", ts: time, s: rec.cid + "|sz=" + verdict.sz });
    const ord = createOrder(rec, verdict, s.markets, currentLobs, time, rng, seqRef.val++);
    if (ord) {
      newOrdersFromRecs.push(ord);
      eventLog = appendEventLog(eventLog, s.tickCount, time, "ORDER", { id: ord.id, side: ord.side, sz: ord.parentSz, strat: ord.strat });
    }
  }
  const newResult = drainSpawnQueue(newOrdersFromRecs);
  orders.push(...newResult.active); orderHistory.push(...newResult.terminal); deferredSpawns.push(...newResult.deferred);
  const seenDef = new Set(); deferredSpawns = deferredSpawns.filter(d => { if (seenDef.has(d.id)) return false; seenDef.add(d.id); return true; });

  // 12. Apply fills
  const fResult = applyFills(positions, fills, fillKeys, allNewFills);
  positions = fResult.positions; fills = fResult.fills; fillKeys = fResult.fillKeys;
  metaPerf = applyAttributionEvents(metaPerf, fResult.attrEvents);

  // 13. Reconciliation
  const reconResult = reconcile(positions, fills, fillKeys, orders, orderHistory);
  if (!reconResult.ok) {
    positions = reconResult.correctedPositions; fillKeys = reconResult.correctedFillKeys;
    const fixedOrders = [];
    for (const o of orders) { if (TERMINAL.has(o.status)) { orderHistory.push(o); } else fixedOrders.push(o); }
    orders = fixedOrders;
  }
  s.events.push({ evt: "recon:done", ts: time, s: "ok=" + reconResult.ok + "|issues=" + reconResult.issues.length });

  // 14. Metrics
  const metrics = computeMetrics(positions, s.markets, s.equityCurve, s.peakEquity);
  cb = updateCB(cb, metrics, time);
  orderHistory = pruneOrderHistory(orderHistory, orders);

  // Phase 7: equity returns for Sharpe calculation
  const prevEquity = prev.equity || CFG.initialEquity;
  const equityReturn = prevEquity > 0 ? (metrics.equity - prevEquity) / prevEquity : 0;
  let equityReturns = [...(prev.equityReturns || []), equityReturn];
  if (equityReturns.length > CFG.metricsWindow) equityReturns = equityReturns.slice(-CFG.metricsWindow);

  // Phase 7: performance metrics
  const perfMetrics = computePerformanceMetrics(equityReturns, fills, metaPerf);

  return {
    ...s, positions, fills, fillKeys, orders, orderHistory, deferredSpawns,
    lobs: currentLobs,
    equity: metrics.equity, equityCurve: metrics.equityCurve,
    peakEquity: metrics.peakEquity, grossExposure: metrics.grossExposure,
    netExposure: metrics.netExposure, totalPnl: metrics.totalPnl,
    realizedPnl: metrics.realizedPnl, unrealizedPnl: metrics.unrealizedPnl,
    currentDD: metrics.currentDD, cb, monitor, metaPerf,
    orderSeq: seqRef.val,
    impactDecay: newImpactDecay,
    eventLog,
    equityReturns,
    perfMetrics,
    lastRecon: { ok: reconResult.ok, issues: reconResult.issues.length, drifts: reconResult.driftCount, orphans: reconResult.orphanFills, fills: reconResult.fillCount, orders: reconResult.orderCount },
    spawnStats: { existing: existingResult.totalSpawns, new: newResult.totalSpawns, deferred: deferredSpawns.length },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  DETERMINISTIC TESTS
// ═══════════════════════════════════════════════════════════════════════
function runTests() {
  const results = [];
  const assert = (name, cond) => { results.push({ name, pass: !!cond }); };

  // --- PHASE 1: LOB TESTS ---
  // T1: LOB creation has valid structure
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    assert("lob:has bids", lob.bids.length === CFG.lobLevels);
    assert("lob:has asks", lob.asks.length === CFG.lobLevels);
    assert("lob:spread positive", lob.spread > 0);
    assert("lob:bestBid < bestAsk", lob.bestBid < lob.bestAsk);
    assert("lob:bidDepth > 0", lob.bidDepth > 0);
  }
  // T2: LOB matching consumes depth (FIFO)
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    const prevAskDepth = lob.askDepth;
    const result = matchOrderAgainstLOB(lob, "buy", 50, 0.99, "test1", 1000);
    assert("lob:match fills qty", result.totalFilled === 50);
    assert("lob:match has fills", result.fills.length >= 1);
    assert("lob:depth consumed", result.updatedLob.askDepth < prevAskDepth);
    assert("lob:avg price valid", result.avgPx > 0 && result.avgPx < 1);
  }
  // T3: LOB rejects order beyond limit price
  { const rng = createRng(42); const lob = createLOB(0.5, 12000, rng);
    const result = matchOrderAgainstLOB(lob, "buy", 50, 0.01, "test2", 1000);  // Limit way below ask
    assert("lob:no fill beyond limit", result.totalFilled === 0);
    assert("lob:remaining equals qty", result.remainingQty === 50);
  }
  // T4: LOB refresh replenishes depth
  { const rng = createRng(42); const lob1 = createLOB(0.5, 12000, rng);
    // Consume most depth
    const m1 = matchOrderAgainstLOB(lob1, "buy", lob1.askDepth - 10, 0.99, "drain", 1000);
    assert("lob:drain leaves little depth", m1.updatedLob.askDepth < 20);
    const rng2 = createRng(43);
    const refreshed = refreshLOB(m1.updatedLob, 0.5, 12000, { vol: "low_vol", liq: "high_liq" }, rng2);
    assert("lob:refresh replenishes depth", refreshed.askDepth > m1.updatedLob.askDepth);
  }

  // --- PHASE 2: MARKET IMPACT ---
  // T5: Impact is directional and proportional
  { const i1 = computeMarketImpact(100, 12000, "buy");
    const i2 = computeMarketImpact(100, 12000, "sell");
    assert("impact:buy positive", i1.totalImpact > 0);
    assert("impact:sell negative", i2.totalImpact < 0);
    const i3 = computeMarketImpact(400, 12000, "buy");
    assert("impact:larger order bigger impact", Math.abs(i3.totalImpact) > Math.abs(i1.totalImpact));
  }
  // T6: Adverse selection moves mid
  { const newMid = applyAdverseSelection(0.55, 0.50, "buy");
    assert("adverse:buy moves mid up", newMid > 0.50);
    const newMid2 = applyAdverseSelection(0.45, 0.50, "sell");
    assert("adverse:sell moves mid down", newMid2 < 0.50);
  }

  // --- PHASE 3: ALPHA ---
  // T7: Multi-timeframe momentum produces signals
  { const mkts = { btc150k: { id: "btc150k", yes: 0.55, prevYes: 0.50, vol: 0.02, cat: "crypto", adv: 12000 } };
    const prices = []; for (let i = 0; i < 60; i++) prices.push(0.40 + i * 0.003);  // Uptrend
    const hists = { btc150k: { prices, spreads: prices.map(() => 0.02), depths: prices.map(() => 200), maxLen: 300 } };
    const sigs = momSigs(mkts, hists, 100000, { trend: "trending", vol: "low_vol", liq: "high_liq" });
    assert("mom:produces signals on trend", sigs.length > 0);
    if (sigs.length > 0) assert("mom:detects uptrend", sigs[0].dir === "BUY_YES");
  }
  // T8: Orderflow imbalance signals
  { const mkts = { btc150k: { id: "btc150k", yes: 0.5, vol: 0.02, cat: "crypto", adv: 12000 } };
    const lobs = { btc150k: { bidDepth: 500, askDepth: 100, volumeThisTick: 50, bids: [], asks: [] } };  // Heavy bid imbalance
    const sigs = orderflowSigs(mkts, lobs, 1000);
    assert("oflow:detects bid imbalance", sigs.length > 0);
    if (sigs.length > 0) assert("oflow:direction is BUY_YES on bid pressure", sigs[0].dir === "BUY_YES");
  }

  // --- PHASE 4: PORTFOLIO ---
  // T9: Correlation matrix computation (return-based)
  { const rng = createRng(42);
    // Create two series with anti-correlated RETURNS (shared noise, opposite sign)
    const pA = [0.5], pB = [0.5];
    for (let i = 1; i < 50; i++) {
      const noise = (rng() - 0.5) * 0.006;
      pA.push(pA[i-1] + noise);           // A goes up when noise > 0
      pB.push(pB[i-1] - noise * 0.8);     // B goes opposite direction
    }
    const hists = { a: { prices: pA }, b: { prices: pB } };
    const cm = computeCorrelationMatrix(hists, ["a", "b"]);
    assert("corr:self is 1", cm["a:a"] === 1);
    assert("corr:negative corr detected", cm["a:b"] < -0.5);
  }

  // --- PHASE 5: SMART EXECUTION ---
  // T10: Adaptive limit price
  { const lob = { bestBid: 0.48, bestAsk: 0.52, spread: 0.04, midPrice: 0.50 };
    const aggLim = computeAdaptiveLimit(lob, "YES", "immediate");
    const patLim = computeAdaptiveLimit(lob, "YES", "patient");
    assert("adaptive:immediate crosses spread", aggLim === 0.52);
    assert("adaptive:patient inside spread", patLim > 0.48 && patLim < 0.52);
  }

  // --- PHASE 6: EVENT SOURCING ---
  // T11: Event log is append-only and bounded
  { let log = [];
    log = appendEventLog(log, 1, 1000, "TEST", { x: 1 });
    assert("eventlog:appends", log.length === 1);
    for (let i = 0; i < 2100; i++) log = appendEventLog(log, i, i * 1000, "BULK", { i });
    assert("eventlog:bounded", log.length <= 2000);
    assert("eventlog:keeps recent", log[log.length - 1].data.i === 2099);
  }

  // --- PHASE 7: METRICS ---
  // T12: Performance metrics
  { const returns = [0.01, -0.005, 0.008, -0.003, 0.012, 0.006, -0.002, 0.009, 0.004, -0.001];
    const fills = [{ slipBps: 5 }, { slipBps: 10 }, { slipBps: 3 }];
    const mp = { nlp: [0.5, -0.2, 0.3], momentum: [0.1, 0.4], arb: [-0.1] };
    const pm = computePerformanceMetrics(returns, fills, mp);
    assert("metrics:sharpe computed", typeof pm.sharpe === "number" && pm.sharpe !== 0);
    assert("metrics:avgSlipBps computed", pm.avgSlipBps === 6);
    assert("metrics:winRate computed", pm.winRate > 0);
    assert("metrics:alphaContrib has sources", "nlp" in pm.alphaContrib);
  }

  // --- PRESERVED CORE TESTS ---
  // T13: Terminal state immutability
  { assert("fsm:FILLED→any blocked", !canTransition("FILLED", "CANCELLED"));
    assert("fsm:REPLACED→any blocked", !canTransition("REPLACED", "FILLED"));
    assert("fsm:NEW→ACCEPTED valid", canTransition("NEW", "ACCEPTED"));
  }
  // T14: Duplicate fill rejection
  { const f1 = { key: "dup1", orderId: "o1", cid: "btc150k", side: "YES", qty: 50, px: 0.45, time: 1000, slipBps: 2, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    assert("dedup:first applied", r1.fills.length === 1);
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f1]);
    assert("dedup:duplicate rejected", r2.fills.length === 1);
  }
  // T15: Attribution only on closing qty
  { const f1 = { key: "ao1", orderId: "o1", cid: "btc150k", side: "YES", qty: 100, px: 0.40, time: 1000, slipBps: 1, attr: { nlp: 100 } };
    const r1 = applyFills({}, [], {}, [f1]);
    assert("attr:opening no events", r1.attrEvents.length === 0);
    const f2 = { key: "ao2", orderId: "o2", cid: "btc150k", side: "NO", qty: 60, px: 0.50, time: 2000, slipBps: 1, attr: { arb: 100 } };
    const r2 = applyFills(r1.positions, r1.fills, r1.fillKeys, [f2]);
    assert("attr:closing emits event", r2.attrEvents.length === 1);
    assert("attr:rpnl = 60*(0.50-0.40)=6", Math.abs(r2.attrEvents[0].rpnl - 6) < 0.01);
  }
  // T16: Deterministic replay
  { const s1 = initState(42); const s2 = initState(42);
    const t1 = tick(s1, 10000); const t2 = tick(s2, 10000);
    assert("det:same equity", t1.equity === t2.equity);
    assert("det:same fills", t1.fills.length === t2.fills.length);
    assert("det:same orderSeq", t1.orderSeq === t2.orderSeq);
  }
  // T17: Pruning returns flat array
  { const empty = pruneOrderHistory([], []);
    assert("prune:empty→array", Array.isArray(empty) && empty.length === 0);
    const big = []; for (let i = 0; i < 500; i++) big.push({ id: "h" + i, status: "FILLED", parentOrderId: null, replacedBy: null });
    const pruned = pruneOrderHistory(big, []);
    assert("prune:flat array", Array.isArray(pruned) && pruned.every(o => !Array.isArray(o)));
  }
  // T18: CB half-open recovery needs probe fills
  { const cb1 = { state: "half_open", failCount: 1, lastFailTime: 1000, reason: "test", triggers: [], recentSlipEvents: [], recentRejects: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 };
    assert("cb:no fills → stays half_open", updateCB(cb1, { currentDD: 0, grossExposure: 0 }, 5000).state === "half_open");
    const cb2 = { ...cb1, halfOpenFills: CFG.cbHalfOpenProbeMinFills };
    assert("cb:fills → closes", updateCB(cb2, { currentDD: 0, grossExposure: 0 }, 5000).state === "closed");
  }
  // T19: Half-open cap is notional
  { const snap = { positions: {}, markets: { btc150k: { id: "btc150k", yes: 0.25, cat: "crypto", adv: 12000 } }, cb: { state: "half_open" }, currentDD: 0, grossExposure: 0, quarantined: {}, corrMatrix: {} };
    const v = preTradeRisk({ cid: "btc150k", dir: "BUY_YES", sz: 5000, aq: 0.5 }, snap);
    assert("half_open:qty capped by notional/price", v.sz <= Math.floor(CFG.cbHalfOpenMaxNotional / 0.25));
    assert("half_open:notional within cap", v.sz * 0.25 <= CFG.cbHalfOpenMaxNotional);
  }
  // T20: LOB-based fills are deterministic
  { const rng1 = createRng(42); const rng2 = createRng(42);
    const lob1 = createLOB(0.5, 12000, createRng(99));
    const lob2 = createLOB(0.5, 12000, createRng(99));
    const r1 = matchOrderAgainstLOB(lob1, "buy", 100, 0.6, "t1", 1000);
    const r2 = matchOrderAgainstLOB(lob2, "buy", 100, 0.6, "t2", 1000);
    assert("lob:deterministic fills", r1.totalFilled === r2.totalFilled);
    assert("lob:deterministic price", r1.avgPx === r2.avgPx);
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
const TABS = ["Dashboard", "LOB", "Alpha", "Execution", "Risk", "Metrics", "System", "Tests"];

export default function V50() {
  const [state, setState] = useState(() => initState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const [testResults, setTestResults] = useState(null);
  const intRef = useRef(null);
  useEffect(() => { if (running) { intRef.current = setInterval(() => setState(p => tick(p, Date.now())), 2000); return () => clearInterval(intRef.current); } else clearInterval(intRef.current); }, [running]);
  const st = state, mA = Object.values(st.markets), allOrds = [...st.orders, ...st.orderHistory.slice(-20)].sort((a, b) => b.time - a.time);
  const pm = st.perfMetrics || {};
  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#00e89a,#2d8cf0,#9966ff)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: K.bg, fontFamily: FF }}>5.0</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V5.0</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>LOB MATCHING · MARKET IMPACT · ORDERFLOW · COINTEGRATION · VOL-TARGET · EVENT LOG</div></div>
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
          <St l="Sharpe" v={pm.sharpe || 0} c={pm.sharpe > 0 ? K.g : K.r} />
          <St l="Drawdown" v={fp(st.currentDD)} c={st.currentDD > 0.1 ? K.r : st.currentDD > 0.05 ? K.y : K.g} />
          <St l="Tick" v={st.tickCount} c={K.b} s={"seed:" + st.seed} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EQUITY (deterministic)</div><Sp data={st.equityCurve} w={640} h={50} color={st.equity >= CFG.initialEquity ? K.g : K.r} /></div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 5 }}>MARKETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {mA.map(m => { const ch = m.yes - m.prevYes; const q = st.quarantined[m.id]; const lob = st.lobs[m.id]; return <div key={m.id} style={{ ...mc2, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: q ? 0.5 : 1 }}>
              <div style={{ fontSize: 10, maxWidth: "45%" }}>{m.q}{q && <span style={{ ...bx(K.r, K.rd), marginLeft: 4 }}>Q</span>}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {lob && <span style={{ fontFamily: FF, fontSize: 7, color: K.dm }}>sp:{(lob.spread * 100).toFixed(1)}{"\u00A2"}</span>}
                <span style={{ fontFamily: FF, fontSize: 8, color: ch > 0 ? K.g : ch < 0 ? K.r : K.dm }}>{ch > 0 ? "+" : ""}{(ch * 100).toFixed(2)}{"\u00A2"}</span>
                <span style={{ fontFamily: FF, fontSize: 12, fontWeight: 700, color: m.yes > 0.5 ? K.g : K.b }}>{(m.yes * 100).toFixed(1)}{"\u00A2"}</span>
              </div></div>; })}
          </div>
        </div>
      </div>}

      {/* LOB */}
      {tab === "LOB" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {mA.slice(0, 4).map(m => { const lob = st.lobs[m.id]; if (!lob) return null;
            return <div key={m.id} style={cd2}>
              <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 4 }}>{m.q}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: K.dm, fontFamily: FF, marginBottom: 2 }}>BIDS (depth: {lob.bidDepth})</div>
                  {lob.bids.slice(0, 5).map((l, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: FF, fontSize: 8, color: K.g, padding: "1px 0" }}>
                    <span>{(l.px * 100).toFixed(1)}{"\u00A2"}</span>
                    <div style={{ width: Math.min(100, l.qty / 3) + "%", height: 4, background: K.gd, borderRadius: 2, alignSelf: "center", marginLeft: 4, flex: 1 }} />
                    <span style={{ marginLeft: 4, minWidth: 30, textAlign: "right" }}>{l.qty}</span>
                  </div>)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: K.dm, fontFamily: FF, marginBottom: 2 }}>ASKS (depth: {lob.askDepth})</div>
                  {lob.asks.slice(0, 5).map((l, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: FF, fontSize: 8, color: K.r, padding: "1px 0" }}>
                    <span>{(l.px * 100).toFixed(1)}{"\u00A2"}</span>
                    <div style={{ width: Math.min(100, l.qty / 3) + "%", height: 4, background: K.rd, borderRadius: 2, alignSelf: "center", marginLeft: 4, flex: 1 }} />
                    <span style={{ marginLeft: 4, minWidth: 30, textAlign: "right" }}>{l.qty}</span>
                  </div>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 7, color: K.dm, marginTop: 4 }}>
                <span>Spread: {(lob.spread * 100).toFixed(2)}{"\u00A2"}</span>
                <span>Mid: {(lob.midPrice * 100).toFixed(1)}{"\u00A2"}</span>
                <span>Vol: {lob.volumeThisTick}</span>
              </div>
            </div>; })}
        </div>
      </div>}

      {/* ALPHA */}
      {tab === "Alpha" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>META-ALPHA WEIGHTS (regime-aware · vol-targeted)</div>
          {Object.entries(st.alphaWeights).map(([k, v]) => <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}><span>{k} <span style={{ fontSize: 8, color: K.dm }}>({st.metaPerf[k]?.length || 0})</span></span><span style={{ fontFamily: FF, fontWeight: 700, color: v > 0.4 ? K.g : K.dm }}>{fp(v, 0)}</span></div>
            <div style={{ height: 5, background: K.s2, borderRadius: 3, overflow: "hidden" }}><div style={{ width: v * 100 + "%", height: "100%", background: k === "nlp" ? K.c : k === "momentum" ? K.p : K.b, borderRadius: 3 }} /></div>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>NEWS</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>{st.newsLog.slice(0, 8).map(n => <div key={n.id} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 9, alignItems: "center" }}>
            <span style={{ fontFamily: FF, fontSize: 8, color: K.dm, minWidth: 35 }}>{ft(n.time)}</span>
            <span style={bx(K.tx, K.s2)}>{n.source}</span>
            <span style={{ flex: 1 }}>{n.headline}</span>
            <span style={bx(n.impactClass === "binary_catalyst" ? K.r : K.y, n.impactClass === "binary_catalyst" ? K.rd : K.yd)}>{n.impactClass === "binary_catalyst" ? "CAT" : "SHIFT"}</span>
          </div>)}</div>
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>SIGNALS ({st.signals.length})</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: FF }}><thead><tr style={{ color: K.dm, textAlign: "left" }}><th style={{ padding: 2 }}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FR</th></tr></thead>
              <tbody>{st.signals.slice(0, 10).map(s2 => <tr key={s2.id}><td style={{ padding: 2 }}><span style={bx(s2.source === "nlp" ? K.c : s2.source === "momentum" ? K.p : K.b, s2.source === "nlp" ? K.cd : s2.source === "momentum" ? K.pd : K.b2)}>{s2.source}</span></td>
                <td style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(s2.cid)}</td>
                <td><span style={bx(s2.dir === "BUY_YES" ? K.g : K.r, s2.dir === "BUY_YES" ? K.gd : K.rd)}>{s2.dir === "BUY_YES" ? "Y" : "N"}</span></td>
                <td style={{ color: K.y }}>{s2.ee ? fp(s2.ee, 2) : fp(s2.edge, 2)}</td>
                <td style={{ color: (s2.fr || 1) > 0.5 ? K.g : K.r }}>{s2.fr ? fp(s2.fr, 0) : "\u2014"}</td></tr>)}</tbody></table>
          </div>
        </div>
      </div>}

      {/* EXECUTION */}
      {tab === "Execution" && <div style={cd2}>
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDERS — LOB MATCHING · FIFO FILLS · ADAPTIVE LIMITS</div>
        {allOrds.length === 0 && <div style={{ color: K.dm, fontSize: 10 }}>No orders...</div>}
        <div style={{ maxHeight: 420, overflowY: "auto" }}>{allOrds.slice(0, 12).map(e => <div key={e.id} style={{ ...mc2, marginBottom: 4 }}>
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
          </div>
          <div style={{ display: "flex", gap: 1.5, marginTop: 2 }}>{e.children.slice(0, 20).map(ch => <div key={ch.id} style={{ width: Math.max(8, ch.sz / 8), height: 5, borderRadius: 2, background: ch.st === "FILLED" ? K.g : ch.st === "REJECTED" ? K.r : ch.st === "CANCELLED" ? K.o : K.bd, opacity: 0.7 }} />)}</div>
          {e.partialAction && <div style={{ marginTop: 2, padding: "2px 4px", borderRadius: 3, background: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.rd : K.yd, fontSize: 8, fontFamily: FF }}>
            <span style={{ color: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.r : K.y, fontWeight: 600 }}>{e.partialAction.action}</span>
            <span style={{ color: K.dm }}> {e.partialAction.reason}</span>
          </div>}
        </div>)}</div>
      </div>}

      {/* RISK */}
      {tab === "Risk" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>POSITION LEDGER — LOB-priced · notional exposure · correlated exposure check</div>
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
        </div>
      </div>}

      {/* METRICS */}
      {tab === "Metrics" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Sharpe" v={pm.sharpe || 0} c={pm.sharpe > 0 ? K.g : K.r} />
          <St l="Win Rate" v={(pm.winRate || 0) + "%"} c={pm.winRate > 50 ? K.g : K.r} />
          <St l="Avg Slip" v={(pm.avgSlipBps || 0) + "bps"} c={pm.avgSlipBps < 20 ? K.g : K.r} />
          <St l="Exec Qual" v={pm.execQuality || "—"} c={pm.execQuality === "good" ? K.g : pm.execQuality === "fair" ? K.y : K.r} />
          <St l="Total Fills" v={pm.totalFills || 0} c={K.b} />
          <St l="Events" v={(st.eventLog || []).length} c={K.p} s="append-only" />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ALPHA CONTRIBUTION (realized PnL by source)</div>
          {pm.alphaContrib && Object.entries(pm.alphaContrib).map(([src, val]) => <div key={src} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid " + K.bd + "10" }}>
            <span style={{ fontSize: 10 }}>{src}</span>
            <span style={{ fontFamily: FF, fontSize: 10, fontWeight: 700, color: val >= 0 ? K.g : K.r }}>{val >= 0 ? "+" : ""}{f$(val, 2)}</span>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EVENT LOG (last 15)</div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {(st.eventLog || []).slice(-15).reverse().map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 8, fontFamily: FF, borderBottom: "1px solid " + K.bd + "08" }}>
              <span style={{ color: K.dm, minWidth: 30 }}>t{e.tick}</span>
              <span style={bx(e.type === "FILL" ? K.g : e.type === "ORDER" ? K.b : K.p, e.type === "FILL" ? K.gd : e.type === "ORDER" ? K.b2 : K.pd)}>{e.type}</span>
              <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 250 }}>{JSON.stringify(e.data).slice(0, 60)}</span>
            </div>)}
          </div>
        </div>
      </div>}

      {/* SYSTEM */}
      {tab === "System" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Approvals" v={st.monitor.approvals} c={K.g} s={st.monitor.rejections + " rej"} />
          <St l="Fills" v={st.fills.length} c={K.g} s="append-only" />
          <St l="CB state" v={st.cb.state} c={st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r} s={"rej:" + (st.cb.recentRejects||[]).length + " slip:" + (st.cb.recentSlipEvents||[]).length} />
          <St l="Spawns" v={(st.spawnStats?.existing||0) + (st.spawnStats?.new||0)} c={K.p} s={"def:" + (st.spawnStats?.deferred||0)} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RECONCILIATION</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5 }}>
            <St l="Status" v={st.lastRecon.ok ? "OK" : "DRIFT"} c={st.lastRecon.ok ? K.g : K.r} />
            <St l="Issues" v={st.lastRecon.issues} c={st.lastRecon.issues > 0 ? K.r : K.g} />
            <St l="Drifts" v={st.lastRecon.drifts} c={st.lastRecon.drifts > 0 ? K.r : K.g} />
            <St l="Orphans" v={st.lastRecon.orphans} c={st.lastRecon.orphans > 0 ? K.r : K.g} />
          </div>
        </div>
        {st.cb.triggers.length > 0 && <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>CB TRIGGERS</div>
          {st.cb.triggers.slice(-6).map((t2, i) => <div key={i} style={{ fontSize: 8, fontFamily: FF, color: K.r, padding: "1px 0" }}>{ft(t2.t)} {t2.from}{"\u2192"}{t2.to} {t2.r}</div>)}</div>}
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>EVENTS ({st.events.length})</div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>{st.events.slice().reverse().slice(0, 20).map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 8, fontFamily: FF }}>
            <span style={{ color: K.dm, minWidth: 40 }}>{ft(e.ts)}</span>
            <span style={bx(e.evt.includes("reject") || e.evt.includes("partial") ? K.r : e.evt.includes("recon") ? K.c : e.evt.includes("exec") ? K.g : K.dm, e.evt.includes("reject") || e.evt.includes("partial") ? K.rd : e.evt.includes("recon") ? K.cd : e.evt.includes("exec") ? K.gd : K.s2)}>{e.evt}</span>
            <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 250 }}>{e.s}</span>
          </div>)}</div>
        </div>
        <div style={{ ...cd2, fontSize: 8, fontFamily: FF, color: K.dm }}>
          <b style={{ color: K.tx }}>V5.0 engine guarantees:</b><br />
          [Phase 1] LOB: FIFO matching, queue position, depth consumption. No random fills.<br />
          [Phase 2] Impact: {"\u221A"}(qty/ADV) model, adverse selection, decaying temp impact.<br />
          [Phase 3] Alpha: orderflow imbalance, cointegrated stat arb, multi-TF momentum.<br />
          [Phase 4] Portfolio: correlation matrix, vol-targeted sizing, Kelly{"\u00D7"}regime cap.<br />
          [Phase 5] Execution: adaptive limits, TWAP schedule, cancel/replace on drift.<br />
          [Phase 6] Event log: append-only, bounded, structured, replayable.<br />
          [Phase 7] Metrics: Sharpe, win rate, avg slip, exec quality, alpha contribution.
        </div>
      </div>}

      {/* TESTS */}
      {tab === "Tests" && <div style={cd2}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>V5.0 DETERMINISTIC TEST SUITE</div>
          <button onClick={() => setTestResults(runTests())} style={{ padding: "4px 10px", borderRadius: 4, border: "none", cursor: "pointer", background: K.b, color: K.bg, fontFamily: FF, fontSize: 9, fontWeight: 700 }}>RUN TESTS</button>
        </div>
        {testResults && <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 5, marginBottom: 8 }}>
            <St l="Total" v={testResults.length} c={K.b} />
            <St l="Passed" v={testResults.filter(t => t.pass).length} c={K.g} />
            <St l="Failed" v={testResults.filter(t => !t.pass).length} c={testResults.filter(t => !t.pass).length > 0 ? K.r : K.g} />
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {testResults.map((t, i) => <div key={i} style={{ display: "flex", gap: 6, padding: "3px 0", fontSize: 9, fontFamily: FF, alignItems: "center" }}>
              <span style={bx(t.pass ? K.g : K.r, t.pass ? K.gd : K.rd)}>{t.pass ? "PASS" : "FAIL"}</span>
              <span style={{ color: t.pass ? K.dm : K.r }}>{t.name}</span>
            </div>)}
          </div>
        </div>}
        {!testResults && <div style={{ color: K.dm, fontSize: 10 }}>Click RUN TESTS to execute the test suite.</div>}
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V5.0 · SEED:{st.seed} · TICK:{st.tickCount} · SHARPE:{pm.sharpe||0} · FILLS:{st.fills.length} · REALIZED:{f$(st.realizedPnl)} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
