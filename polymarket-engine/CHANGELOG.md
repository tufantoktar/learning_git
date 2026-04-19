# Changelog

## [5.1.0] — Phase 1 Modular Refactor

### Changed
- **Extracted pure/low-risk modules from single-file App.jsx into a module tree.**
- No behavior change: 52/52 deterministic tests pass, determinism verified.
- Imports only — no new logic, no signature changes.

### File tree
```
src/
├── App.jsx              (main — reduced, imports from modules below)
├── config/
│   ├── config.js        CFG
│   ├── marketDefs.js    MDEFS, PAIRS, NEWS
│   └── constants.js     SRC_W, SRCS
├── engine/
│   ├── types.js         JSDoc typedefs
│   ├── prng.js          createRng
│   ├── history.js       pushHist, hRoc, hSma, hStd, hVol
│   ├── regime.js        detectRegime, computeWeights
│   ├── market.js        createLOB, refreshLOB, matchOrderAgainstLOB,
│   │                    computeMarketImpact, applyAdverseSelection,
│   │                    advMkt, buildBook, validateMarket,
│   │                    computeCorrelationMatrix, checkCorrelatedExposure
│   └── alpha.js         genNews, nlpSigs, momSigs, arbSigs,
│                        orderflowSigs, processSigs
└── utils/
    └── math.js          cl, r4
```

### Not extracted yet (reserved for Phase 2)
- Execution (FSM, orders, fills, slippage)
- Risk (preTradeRisk, calcExposure)
- Portfolio (applyFills, computeMetrics, applyAttributionEvents)
- Reconciliation
- Circuit breaker
- Pruning
- Event log
- Performance metrics
- State + tick loop
- React UI components

### Notes
- Uses `.js` (JSDoc typedefs) not `.ts` — keeps Vite/JSX compatibility without toolchain change.
- Named exports throughout.
- No new libraries, no framework change.

---

## [5.0.0] — Market-Realistic Alpha-Driven Engine

### Phase 1: LOB + Execution Realism
- Real limit order book with FIFO matching engine per market
- Queue position tracking, partial fills via depth consumption
- No random fill probability — fills only via matching engine
- Depth replenishment with regime-aware stress widening

### Phase 2: Market Impact + Liquidity
- Square-root impact model: sqrt(qty/ADV) × coefficient
- Adverse selection: mid price moves against aggressive fills
- Temporary impact decays over configurable ticks
- Dynamic spread widening under high-vol / low-liq stress

### Phase 3: Real Alpha Engine
- Orderflow imbalance signals from LOB bid/ask depth ratio
- Cointegration-aware stat arb with ADF-like stationarity check
- Multi-timeframe volatility-adjusted momentum (short/mid/long)
- NLP with latency penalty on confidence

### Phase 4: Portfolio Intelligence
- Rolling correlation matrix across all markets
- Correlated exposure constraint in pre-trade risk
- Volatility-targeted sizing: scale by vol-target / market-vol
- Kelly fraction capped by regime confidence level

### Phase 5: Smart Execution
- Adaptive limit pricing from LOB state (immediate/patient/passive)
- TWAP slice scheduling for large orders
- Cancel/replace on excessive limit-to-mid drift

### Phase 6: Event Sourcing
- Append-only structured event log (ORDER, FILL, NEWS, SIGNAL)
- Bounded to 2000 entries (trims to 1500)
- Full replay from events (deterministic)

### Phase 7: Performance Metrics
- Sharpe ratio (rolling, annualized)
- Win rate from realized attribution
- Average slippage (bps)
- Execution quality assessment
- Alpha contribution per signal source

### Infrastructure
- 52 deterministic tests, all passing
- Determinism verified: same seed + time = same output
- All V4.3.2 guarantees preserved (FSM, attribution, CB, recon, pruning)

---

## [4.3.2] — Correctness + Clarity Patch

### Fixed
- **Half-open CB cap was qty, not notional**: `cbHalfOpenMaxNotional=200` was compared directly against qty. Now converted to qty via `Math.floor(notional / sidePrice)`. At price 0.20, allows 1000 shares instead of wrongly capping at 200.
- **Half-open probe accounting used qty as notional**: `halfOpenNotional` accumulated `totalFilled` (qty) instead of `qty × price`. Now uses real fill notional.
- **Sizing used hardcoded initialEquity**: `processSigs` now takes live state and sizes from: live equity × DD scale, clamped by remaining gross-notional room, per-market qty room, per-category qty room, and half-open CB cap.
- **Poor-fill evaluation operator precedence bug**: `!TERMINAL || (TERMINAL && ...)` always fired for non-terminal. Replaced with clear booleans.
- **4 test fixture bugs**: slip-rejection rng, zero-PnL prices, empty positions in recon, decayed signal edge.

### Improved
- **Risk clarity**: `preTradeRisk` rewritten with explicit names: `requestedQty`, `allowedQty`, `sidePrice`, `additionalNotional`, `remainingNotionalCapacity`. 8 numbered checks in stable sequence.
- **Pruning clarity**: `collectProtectedOrderIds` with explicit seed + bounded transitive closure (max 50 iterations). `pruneOrderHistory` always returns flat array, defensive `Array.isArray`, respects both retention cap and min-terminal.
- **Attribution hardening**: `applyAttributionEvents` rejects arrays, nulls, non-finite rpnl/pct.

### Added
- 12 new tests (Tests 33–44): half-open notional cap, live-equity sizing, DD scale, notional room clamping, pruning shape/lineage, terminal immutability, probe recovery, duplicate fill idempotency, closing-only attribution, malformed attr handling.
- **115 total tests, all passing. Determinism verified.**

---

## [4.3.1] — Meta-Alpha Attribution Correctness

### Fixed
- **Attribution bug**: removed "most recent order in market" `.pop()` lookup that misattributed PnL to wrong signal source
- **Position-level delta bug**: attribution was computed as single market-level delta instead of per-fill
- **Missing fill lineage**: fills now carry `attr` field from originating order (fill→order→signal chain)
- **Partial close attribution**: only closing portion's realized PnL is attributed; opening remainder correctly ignored

### Added
- `applyAttributionEvents(metaPerf, attrEvents)` — pure, deterministic attribution function
- `attrEvents` output from `applyFills` — per-fill realized PnL attribution events
- `attr` field on fill structs — source lineage from originating order
- `meta:attr` event type in system event log
- 9 new attribution tests (Tests 24-32)

### Guarantees
- No unrealized PnL learning
- No fill-quality proxy learning
- Same fills + same attr = same metaPerf updates under replay
- `applyAttributionEvents` is pure: does not mutate inputs

---

## [4.3.0] — Correctness + Determinism + Lifecycle Hardening

### Fixed
- Terminal state immutability (FILLED/CANCELLED/REJECTED/REPLACED cannot transition)
- Order ID collisions with tick-local sequence counter
- Child-level fill key dedup in `advanceOrderFills`
- Circuit breaker `tripCB` mutation leak (now pure, returns new object)
- `recentRejects` was unbounded counter (now windowed array)
- Poor fill recorded before all children evaluated
- History pruning only protected one direction of lineage chain

### Added
- `makeOrderId` with deterministic sequence counter
- `orderSeq` persisted in state across ticks
- Transitive closure in `collectProtectedIds` for lineage protection
- `historyMinRetainTerminal` enforcement in pruning
- 23 deterministic tests

---

## [4.2.0] — Circuit Breaker + Risk + Exposure Consistency

### Fixed
- Poor fills tracked but never tripped circuit breaker
- Invalid market data was quarantine-only, didn't feed CB
- Slippage CB used `allFills.slice` (unbounded) instead of windowed array
- Exposure check mixed quantity and notional units
- Category caps not labeled as quantity-based

### Added
- Full 3-state CB FSM (closed/open/half_open)
- 6 trip triggers: drawdown, exposure, slippage, rejects, poor fills, invalid data
- Windowed event arrays for slippage, poor fills, invalid data
- Half-open probe with deterministic recovery criteria
- Auditable CB trigger log
