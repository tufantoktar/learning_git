// Shared JSDoc type definitions for Phase 1 modules.
// This file exports nothing at runtime; it exists so editors/IDEs can
// surface structural hints without requiring a TypeScript compiler.
// Only types actually used by extracted Phase 1 modules are declared here.

/**
 * Seeded PRNG. Each call returns a deterministic pseudo-random number in [0, 1).
 * @typedef {() => number} Rng
 */

/**
 * A single market snapshot.
 * @typedef {Object} Market
 * @property {string} id
 * @property {string} [q]          // question text
 * @property {number} yes          // current YES price in [0.02, 0.98]
 * @property {number} [prevYes]    // previous YES price
 * @property {number} [vol]        // per-tick volatility
 * @property {string} [cat]        // category (crypto, macro, ...)
 * @property {number} [adv]        // average daily volume (qty)
 * @property {number} [lastUpdate] // last update time (ms)
 */

/**
 * Per-market price/spread/depth history buffer (bounded ring).
 * @typedef {Object} History
 * @property {number[]} prices
 * @property {number[]} spreads
 * @property {number[]} depths
 * @property {number} [maxLen]
 */

/**
 * One price level inside the LOB. `orders` is the FIFO queue at that level.
 * @typedef {Object} LobLevel
 * @property {number} px
 * @property {number} qty
 * @property {{id: string, qty: number, ts: number}[]} orders
 */

/**
 * Limit order book snapshot for a single market.
 * @typedef {Object} Lob
 * @property {LobLevel[]} bids        // sorted descending by price
 * @property {LobLevel[]} asks        // sorted ascending by price
 * @property {number} bestBid
 * @property {number} bestAsk
 * @property {number} spread
 * @property {number} midPrice
 * @property {number} bidDepth        // sum of qty across all bid levels
 * @property {number} askDepth        // sum of qty across all ask levels
 * @property {number} lastTradePrice
 * @property {number} tradeCount
 * @property {number} volumeThisTick
 */

/**
 * Result of a single fill against the LOB.
 * @typedef {Object} Fill
 * @property {number} px
 * @property {number} qty
 * @property {number} levelIdx        // which book level was hit
 * @property {number} time
 */

/**
 * Return value of matchOrderAgainstLOB.
 * @typedef {Object} MatchResult
 * @property {Fill[]} fills
 * @property {number} remainingQty
 * @property {number} totalFilled
 * @property {number} avgPx
 * @property {Lob} updatedLob
 */

/**
 * Regime classification used by alpha weights and execution.
 * @typedef {Object} Regime
 * @property {"trending"|"mean_reverting"|"neutral"} trend
 * @property {"high_vol"|"low_vol"} vol
 * @property {"high_liq"|"low_liq"} liq
 * @property {number} confidence
 * @property {number} hurst
 */

/**
 * Meta-alpha performance buffer (realized returns attributed per source).
 * @typedef {Object} MetaPerf
 * @property {number[]} nlp
 * @property {number[]} momentum
 * @property {number[]} arb
 */

/**
 * Alpha weight vector summing to 1.
 * @typedef {Object} AlphaWeights
 * @property {number} nlp
 * @property {number} momentum
 * @property {number} arb
 */

/**
 * A news event used by NLP alpha.
 * @typedef {Object} NewsEvent
 * @property {string} id
 * @property {number} time
 * @property {string} source
 * @property {string} headline
 * @property {string[]} markets
 * @property {number} sentiment
 * @property {"binary_catalyst"|"gradual_shift"|"noise"} impactClass
 * @property {number} confidence
 * @property {number} baseImpact
 * @property {number} srcWeight
 * @property {number} latencyMs
 */

/**
 * An alpha signal produced by nlp/momentum/arb/orderflow.
 * @typedef {Object} Signal
 * @property {string} id
 * @property {"nlp"|"momentum"|"arb"} source
 * @property {number} time
 * @property {string} cid            // market id
 * @property {"BUY_YES"|"BUY_NO"} dir
 * @property {number} edge
 * @property {number} conf
 * @property {number} fv
 * @property {number} px
 * @property {number} hl             // half-life ms
 * @property {number} exp            // expiration time (ms)
 * @property {number} qs             // signal quality score
 * @property {number} [fr]           // freshness ratio (filled in by processSigs)
 * @property {number} [ee]           // effective edge (edge * fr)
 */

/**
 * A trade recommendation emitted by processSigs, consumed later by risk/execution.
 * @typedef {Object} Recommendation
 * @property {string} id
 * @property {number} time
 * @property {string} cid
 * @property {"BUY_YES"|"BUY_NO"} dir
 * @property {number} ce
 * @property {number} conf
 * @property {number} conc
 * @property {number} sz
 * @property {Object<string, number>} attr
 * @property {number} nSigs
 * @property {"immediate"|"patient"|"passive"} urg
 * @property {number} aq
 */

/**
 * Live state snapshot passed into processSigs for sizing.
 * @typedef {Object} LiveSizingState
 * @property {number} [equity]
 * @property {number} [currentDD]
 * @property {number} [grossExposure]
 * @property {Object<string, {yesQty: number, noQty: number}>} [positions]
 * @property {Object<string, Market>} [markets]
 * @property {"closed"|"half_open"|"open"} [cbState]
 */

export {};
