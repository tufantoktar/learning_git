// Market-level primitives: LOB creation/refresh, FIFO matching, market
// price simulation, validation, and cross-market correlation helpers.
// All functions are pure and deterministic (randomness enters only via a
// seeded RNG passed by the caller).

import { cl, r4 } from "../utils/math.js";
import { CFG } from "../config/config.js";

/**
 * Create a fresh LOB for a market. midPrice is the YES price.
 * @param {number} midPrice
 * @param {number} adv
 * @param {import('./types.js').Rng} rng
 * @returns {import('./types.js').Lob}
 */
export function createLOB(midPrice, adv, rng) {
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

/**
 * Refresh LOB each tick: replenish depth, adjust around new mid price.
 * Pure — returns a new LOB.
 * @param {import('./types.js').Lob} prevLob
 * @param {number} newMidPrice
 * @param {number} adv
 * @param {import('./types.js').Regime} regime
 * @param {import('./types.js').Rng} rng
 * @returns {import('./types.js').Lob}
 */
export function refreshLOB(prevLob, newMidPrice, adv, regime, rng) {
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

/**
 * FIFO matching engine. Executes an order against the LOB.
 * side="buy" consumes asks (lifts the offer); side="sell" consumes bids (hits the bid).
 * Pure and deterministic — no randomness is used here.
 * @param {import('./types.js').Lob} lob
 * @param {"buy"|"sell"} side
 * @param {number} qty
 * @param {number} limitPx
 * @param {string} orderId
 * @param {number} tickTime
 * @returns {import('./types.js').MatchResult}
 */
export function matchOrderAgainstLOB(lob, side, qty, limitPx, orderId, tickTime) {
  const fills = [];
  let remaining = qty;
  const bookSide = side === "buy"
    ? [...lob.asks.map(l => ({ ...l, orders: [...l.orders] }))]
    : [...lob.bids.map(l => ({ ...l, orders: [...l.orders] }))];

  for (let i = 0; i < bookSide.length && remaining > 0; i++) {
    const level = bookSide[i];
    // Price check: buy must not exceed limit; sell must not go below limit
    if (side === "buy" && level.px > limitPx) break;
    if (side === "sell" && level.px < limitPx) break;

    const available = level.qty;
    const fillQty = Math.min(remaining, available);
    if (fillQty <= 0) continue;

    fills.push({ px: level.px, qty: fillQty, levelIdx: i, time: tickTime });

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
  const avgPx = totalFilled > 0
    ? +(fills.reduce((s, f) => s + f.px * f.qty, 0) / totalFilled).toFixed(4)
    : 0;
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

/**
 * Square-root impact: price moves proportional to sqrt(qty / ADV).
 * Temporary impact decays over configurable ticks; permanent impact
 * shifts the fair value.
 * @param {number} qty
 * @param {number} adv
 * @param {"buy"|"sell"} side
 * @returns {{tempImpact: number, permImpact: number, totalImpact: number}}
 */
export function computeMarketImpact(qty, adv, side) {
  if (qty <= 0 || adv <= 0) return { tempImpact: 0, permImpact: 0, totalImpact: 0 };
  const participation = qty / adv;
  const sqrtImpact = CFG.impactCoeff * Math.sqrt(participation);
  const direction = side === "buy" ? 1 : -1;
  const tempImpact = r4(sqrtImpact * 0.7 * direction);
  const permImpact = r4(sqrtImpact * 0.3 * direction);
  return { tempImpact, permImpact, totalImpact: r4(tempImpact + permImpact) };
}

/**
 * Apply adverse selection: after an aggressive fill, price moves against the taker.
 * @param {number} fillPx
 * @param {number} midPx
 * @param {"buy"|"sell"} side
 * @returns {number}
 */
export function applyAdverseSelection(fillPx, midPx, side) {
  const adverseBps = CFG.lobAdverseSelectionBps;
  const move = midPx * adverseBps / 10000;
  if (side === "buy") return r4(midPx + move);  // mid moves up after buy
  return r4(midPx - move);  // mid moves down after sell
}

/**
 * Advance a market one tick: mean-reverting drift + noise + rare shock +
 * decaying temporary impact from prior large trades.
 * @param {import('./types.js').Market} m
 * @param {import('./types.js').Rng} rng
 * @param {number} time
 * @param {Object<string, {tempImpact: number, permImpact: number, remaining: number}>} impactDecay
 * @returns {import('./types.js').Market}
 */
export function advMkt(m, rng, time, impactDecay) {
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

/**
 * Legacy 5-level synthetic book. Kept for validation-compatibility callers
 * that don't have a full LOB snapshot. Not used by the matching engine.
 * @param {number} mid
 * @param {number} adv
 * @param {import('./types.js').Rng} rng
 * @returns {Object}
 */
export function buildBook(mid, adv, rng) {
  const lf = cl(adv / 20000, 0.3, 2), bs = 0.015 / lf;
  const bids = [], asks = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ p: r4(cl(mid - bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) });
    asks.push({ p: r4(cl(mid + bs * i / 2, 0.01, 0.99)), sz: Math.floor((80 + rng() * 300) * lf) });
  }
  return {
    bids, asks,
    spread: r4(asks[0].p - bids[0].p),
    mid,
    bidDepth: bids.reduce((s, b) => s + b.sz, 0),
    askDepth: asks.reduce((s, a) => s + a.sz, 0),
  };
}

/**
 * Validate a market snapshot against the LOB: checks price bounds, spread,
 * depth, and staleness.
 * @param {import('./types.js').Market} mkt
 * @param {import('./types.js').Lob} lob
 * @param {number} time
 * @returns {{valid: boolean, issues: string[]}}
 */
export function validateMarket(mkt, lob, time) {
  const issues = [];
  if (mkt.yes < 0 || mkt.yes > 1) issues.push("price_invalid");
  if (lob.spread > CFG.maxSpread) issues.push("spread_" + (lob.spread * 100).toFixed(1) + "%");
  if (lob.bidDepth < CFG.minDepth || lob.askDepth < CFG.minDepth) issues.push("depth_low");
  if (time - mkt.lastUpdate > CFG.stalenessMs && mkt.lastUpdate > 0) issues.push("stale");
  return { valid: issues.length === 0, issues };
}

/**
 * Rolling pairwise return-correlation matrix across given market ids.
 * Returns a dictionary keyed by "a:b" for every ordered pair including self.
 * @param {Object<string, import('./types.js').History>} histories
 * @param {string[]} marketIds
 * @returns {Object<string, number>}
 */
export function computeCorrelationMatrix(histories, marketIds) {
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

/**
 * Portfolio-level correlated-exposure check.
 * Flags if correlated notional exceeds configured fraction of total notional.
 * @param {Object<string, {yesQty: number, noQty: number}>} positions
 * @param {Object<string, import('./types.js').Market>} markets
 * @param {Object<string, number>} corrMatrix
 * @returns {{ratio: number, ok: boolean}}
 */
export function checkCorrelatedExposure(positions, markets, corrMatrix) {
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
