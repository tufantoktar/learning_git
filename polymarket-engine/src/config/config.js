// Engine configuration. All thresholds/limits live here so behavior is
// config-driven and deterministic.
// Keep this file free of logic — values only.

export const CFG = {
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
