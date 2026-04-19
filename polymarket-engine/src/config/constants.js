// Source-weighting constants for NLP alpha.
// SRCS is derived from SRC_W (insertion order preserved) and is exported
// separately to avoid repeated Object.keys() calls at runtime.

export const SRC_W = { Reuters: 1.0, Bloomberg: 0.95, AP: 0.9, Polymarket: 0.7, "X/Twitter": 0.5 };
export const SRCS = Object.keys(SRC_W);
