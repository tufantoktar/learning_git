// Market definitions, statistical-arb pairs, and news templates.
// Pure data. No logic.

export const MDEFS = [
  { id: "btc150k", q: "BTC $150k by Dec 2026?", init: 0.42, vol: 0.02, cat: "crypto", adv: 12000 },
  { id: "recession", q: "US recession 2026?", init: 0.28, vol: 0.015, cat: "macro", adv: 8500 },
  { id: "trump28", q: "Trump 2028 GOP primary?", init: 0.61, vol: 0.01, cat: "politics", adv: 22000 },
  { id: "fedcut", q: "Fed cuts by July 2026?", init: 0.55, vol: 0.018, cat: "macro", adv: 15000 },
  { id: "aibar", q: "AI passes bar top 1%?", init: 0.73, vol: 0.012, cat: "tech", adv: 5000 },
  { id: "starship", q: "Starship orbital?", init: 0.67, vol: 0.008, cat: "tech", adv: 7000 },
  { id: "ethflip", q: "ETH flips BTC mcap?", init: 0.08, vol: 0.025, cat: "crypto", adv: 2000 },
  { id: "ceasefire", q: "Ukraine ceasefire 2026?", init: 0.34, vol: 0.014, cat: "geopolitics", adv: 9500 },
];

export const PAIRS = [
  { a: "btc150k", b: "ethflip" }, { a: "recession", b: "fedcut" },
  { a: "btc150k", b: "fedcut" }, { a: "recession", b: "btc150k" },
];

export const NEWS = [
  { h: "Fed signals policy shift", m: ["fedcut", "recession"], imp: 0.7 },
  { h: "Bitcoin breaks key level", m: ["btc150k", "ethflip"], imp: 0.6 },
  { h: "Polling shifts outlook", m: ["trump28"], imp: 0.5 },
  { h: "Starship test update", m: ["starship"], imp: 0.4 },
  { h: "Treasury yields move", m: ["fedcut", "recession", "btc150k"], imp: 0.5 },
  { h: "AI benchmark result", m: ["aibar"], imp: 0.6 },
  { h: "Diplomatic progress", m: ["ceasefire"], imp: 0.55 },
  { h: "Ethereum shift", m: ["ethflip", "btc150k"], imp: 0.45 },
];
