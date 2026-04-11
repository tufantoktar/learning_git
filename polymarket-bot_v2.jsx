import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const MONO = "'SF Mono', 'Fira Code', 'Cascadia Code', monospace";
const SANS = "'DM Sans', 'Segoe UI', sans-serif";

const C = {
  bg: "#0a0a0f", surface: "#12121a", surface2: "#1a1a26", border: "#252536",
  text: "#e8e8f0", dim: "#6b6b8a", accent: "#00e5a0", accentDim: "#00e5a033",
  red: "#ff4466", redDim: "#ff446633", yellow: "#ffc233", yellowDim: "#ffc23333",
  blue: "#3388ff", blueDim: "#3388ff33", purple: "#aa66ff", purpleDim: "#aa66ff33",
  cyan: "#00d4ff", cyanDim: "#00d4ff33",
};

const pill = (color, bg) => ({
  display: "inline-block", padding: "2px 8px", borderRadius: 4,
  fontSize: 11, fontFamily: MONO, color, background: bg, fontWeight: 600,
});

const card = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
  padding: 16, marginBottom: 12,
};

const genId = () => Math.random().toString(36).slice(2, 8);
const ts = () => new Date().toLocaleTimeString("en", { hour12: false });
const rnd = (a, b) => Math.random() * (b - a) + a;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- SIMULATED DATA GENERATORS ---
const NEWS_SOURCES = ["Reuters", "AP", "Bloomberg", "Polymarket Feed", "X/Twitter", "Decrypt", "CoinDesk", "WSJ"];
const MARKETS = [
  { id: "m1", q: "Will BTC hit $150k by Dec 2026?", yes: 0.42 },
  { id: "m2", q: "US recession in 2026?", yes: 0.28 },
  { id: "m3", q: "Trump wins 2028 GOP primary?", yes: 0.61 },
  { id: "m4", q: "Fed cuts rates by July 2026?", yes: 0.55 },
  { id: "m5", q: "AI model passes bar exam top 1%?", yes: 0.73 },
  { id: "m6", q: "SpaceX Starship orbital success?", yes: 0.67 },
  { id: "m7", q: "ETH flips BTC market cap?", yes: 0.08 },
  { id: "m8", q: "Ukraine ceasefire by 2026?", yes: 0.34 },
];

const HEADLINES = [
  "Fed signals potential rate adjustment in upcoming meeting",
  "BTC surges past key resistance on institutional inflows",
  "New polling data shifts prediction market sentiment",
  "SpaceX announces Starship test flight window",
  "Treasury yields move on inflation expectations",
  "AI lab announces breakthrough benchmark results",
  "Geopolitical tensions ease following diplomatic talks",
  "Crypto ETF sees record daily volume",
];

function genNews() {
  return {
    id: genId(), time: ts(),
    source: NEWS_SOURCES[Math.floor(Math.random() * NEWS_SOURCES.length)],
    headline: HEADLINES[Math.floor(Math.random() * HEADLINES.length)],
    sentiment: rnd(-1, 1),
    relevance: MARKETS[Math.floor(Math.random() * MARKETS.length)].id,
    impact: rnd(0, 1),
  };
}

function genSignal(markets) {
  const m = markets[Math.floor(Math.random() * markets.length)];
  const dir = Math.random() > 0.5 ? "BUY_YES" : "BUY_NO";
  return {
    id: genId(), time: ts(), market: m.id,
    direction: dir, confidence: rnd(0.4, 0.95),
    momentum: rnd(-0.1, 0.1), edge: rnd(0, 0.08),
    source: ["news_nlp", "momentum", "mean_revert", "vol_arb", "cross_arb"][Math.floor(Math.random() * 5)],
  };
}

function genOrder(markets) {
  const m = markets[Math.floor(Math.random() * markets.length)];
  const side = Math.random() > 0.5 ? "YES" : "NO";
  const price = clamp(side === "YES" ? m.yes + rnd(-0.05, 0.05) : (1 - m.yes) + rnd(-0.05, 0.05), 0.01, 0.99);
  return {
    id: genId(), time: ts(), market: m.id, side,
    price: +price.toFixed(3), size: Math.floor(rnd(10, 500)),
    status: ["OPEN", "FILLED", "PARTIAL"][Math.floor(Math.random() * 3)],
    type: ["LIMIT", "MARKET", "MM_QUOTE"][Math.floor(Math.random() * 3)],
  };
}

// --- LINKED MARKETS (for cross-market arbitrage) ---
const LINKED_MARKETS = [
  { pair: ["m1", "m7"], relation: "inverse", label: "BTC $150k vs ETH flippening", rationale: "If BTC hits $150k, ETH flip becomes less likely" },
  { pair: ["m2", "m4"], relation: "correlated", label: "Recession vs Fed rate cuts", rationale: "Recession fears drive rate cut probability" },
  { pair: ["m3", "m8"], relation: "weak", label: "Trump primary vs Ukraine ceasefire", rationale: "GOP primary outcome may shift foreign policy" },
  { pair: ["m1", "m4"], relation: "correlated", label: "BTC $150k vs Fed cuts", rationale: "Rate cuts are bullish for risk assets" },
  { pair: ["m5", "m6"], relation: "independent", label: "AI bar exam vs SpaceX orbital", rationale: "No causal link — control pair" },
  { pair: ["m2", "m1"], relation: "inverse", label: "Recession vs BTC $150k", rationale: "Recession would suppress risk-on assets" },
];

function genArbSignal(markets) {
  const link = LINKED_MARKETS[Math.floor(Math.random() * LINKED_MARKETS.length)];
  const mA = markets.find(m => m.id === link.pair[0]);
  const mB = markets.find(m => m.id === link.pair[1]);
  if (!mA || !mB) return null;

  const impliedA = mA.yes;
  const impliedB = mB.yes;

  let expectedB, mismatch;
  if (link.relation === "correlated") {
    expectedB = impliedA * rnd(0.8, 1.1);
    mismatch = Math.abs(impliedB - expectedB);
  } else if (link.relation === "inverse") {
    expectedB = (1 - impliedA) * rnd(0.6, 0.9);
    mismatch = Math.abs(impliedB - expectedB);
  } else {
    expectedB = impliedB;
    mismatch = rnd(0, 0.03);
  }

  const arbScore = clamp(mismatch / 0.15, 0, 1);
  const actionable = arbScore > 0.4;
  const direction = impliedB > expectedB ? "SELL_B" : "BUY_B";

  return {
    id: genId(), time: ts(),
    marketA: mA.id, marketB: mB.id,
    impliedA: +impliedA.toFixed(3), impliedB: +impliedB.toFixed(3),
    expectedB: +clamp(expectedB, 0.01, 0.99).toFixed(3),
    mismatch: +mismatch.toFixed(4),
    arbScore: +arbScore.toFixed(3),
    relation: link.relation, label: link.label, rationale: link.rationale,
    actionable, direction,
  };
}

// --- BACKTEST ENGINE ---
function runBacktest(params) {
  const days = params.days || 90;
  const equity = [10000];
  const trades = [];
  let wins = 0, losses = 0, maxDD = 0, peak = 10000;
  for (let i = 1; i <= days; i++) {
    const dailyTrades = Math.floor(rnd(2, 8));
    let dailyPnl = 0;
    for (let t = 0; t < dailyTrades; t++) {
      const edge = rnd(-0.03, 0.05) * (params.aggression || 1);
      const size = Math.floor(rnd(50, 300) * (params.sizing || 1));
      const pnl = edge * size;
      dailyPnl += pnl;
      if (pnl > 0) wins++; else losses++;
      trades.push({ day: i, pnl: +pnl.toFixed(2), size });
    }
    const newEq = equity[equity.length - 1] + dailyPnl;
    equity.push(+newEq.toFixed(2));
    peak = Math.max(peak, newEq);
    const dd = (peak - newEq) / peak;
    maxDD = Math.max(maxDD, dd);
  }
  const totalReturn = (equity[equity.length - 1] - 10000) / 10000;
  const sharpe = totalReturn / (maxDD || 0.01) * Math.sqrt(252 / days);
  return {
    equity, trades, wins, losses, maxDD: +(maxDD * 100).toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    calmar: +(totalReturn / (maxDD || 0.01)).toFixed(2),
  };
}

// --- MINI SPARKLINE ---
function Spark({ data, color = C.accent, w = 120, h = 32 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// --- TABS ---
const TABS = ["Dashboard", "News Engine", "Signals", "Arbitrage", "Market Making", "Risk", "Backtest"];

function TabBar({ active, set }) {
  return (
    <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
      {TABS.map(t => (
        <button key={t} onClick={() => set(t)} style={{
          padding: "10px 18px", background: active === t ? C.surface2 : "transparent",
          color: active === t ? C.accent : C.dim, border: "none", cursor: "pointer",
          fontFamily: MONO, fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
          borderBottom: active === t ? `2px solid ${C.accent}` : "2px solid transparent",
          transition: "all .15s",
        }}>{t}</button>
      ))}
    </div>
  );
}

// --- MAIN ---
export default function PolymarketBot() {
  const [tab, setTab] = useState("Dashboard");
  const [markets, setMarkets] = useState(MARKETS);
  const [news, setNews] = useState([]);
  const [signals, setSignals] = useState([]);
  const [orders, setOrders] = useState([]);
  const [running, setRunning] = useState(false);
  const [arbSignals, setArbSignals] = useState([]);
  const [btResult, setBtResult] = useState(null);
  const [btParams, setBtParams] = useState({ days: 90, aggression: 1, sizing: 1 });
  const [riskLimits, setRiskLimits] = useState({ maxPos: 2000, maxDD: 15, maxExposure: 5000 });
  const [eqHistory, setEqHistory] = useState([10000]);
  const intervalRef = useRef(null);

  const totalPnl = useMemo(() => orders.filter(o => o.status === "FILLED").reduce((s, o) => s + (Math.random() > 0.45 ? 1 : -1) * o.size * 0.03, 0), [orders]);
  const positions = useMemo(() => {
    const map = {};
    orders.filter(o => o.status === "FILLED").forEach(o => {
      if (!map[o.market]) map[o.market] = { yes: 0, no: 0 };
      map[o.market][o.side.toLowerCase()] += o.size;
    });
    return map;
  }, [orders]);

  const tick = useCallback(() => {
    setNews(prev => [genNews(), ...prev].slice(0, 50));
    if (Math.random() > 0.4) setSignals(prev => [genSignal(markets), ...prev].slice(0, 40));
    if (Math.random() > 0.3) {
      const ord = genOrder(markets);
      setOrders(prev => [ord, ...prev].slice(0, 60));
    }
    setMarkets(prev => prev.map(m => ({ ...m, yes: clamp(m.yes + rnd(-0.015, 0.015), 0.02, 0.98) })));
    if (Math.random() > 0.5) {
      const arb = genArbSignal(markets);
      if (arb) setArbSignals(prev => [arb, ...prev].slice(0, 30));
    }
    setEqHistory(prev => [...prev, prev[prev.length - 1] + rnd(-80, 120)].slice(-100));
  }, [markets]);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(tick, 1800);
      return () => clearInterval(intervalRef.current);
    } else {
      clearInterval(intervalRef.current);
    }
  }, [running, tick]);

  const mktName = (id) => markets.find(m => m.id === id)?.q || id;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: SANS, padding: 20 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, fontWeight: 900, color: C.bg, fontFamily: MONO,
          }}>P</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.5 }}>Polymarket Bot</div>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>NEWS · MOMENTUM · ARB · MM · RISK · BACKTEST</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={pill(running ? C.accent : C.red, running ? C.accentDim : C.redDim)}>
            {running ? "● LIVE" : "○ STOPPED"}
          </div>
          <button onClick={() => setRunning(r => !r)} style={{
            padding: "8px 20px", borderRadius: 6, border: "none", cursor: "pointer",
            background: running ? C.red : C.accent, color: C.bg,
            fontFamily: MONO, fontSize: 12, fontWeight: 700,
          }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>

      <TabBar active={tab} set={setTab} />

      {/* DASHBOARD */}
      {tab === "Dashboard" && (
        <div>
          {/* Stats Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
            {[
              { label: "Equity", val: `$${(eqHistory[eqHistory.length - 1] || 10000).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: C.accent },
              { label: "Session PnL", val: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? C.accent : C.red },
              { label: "Open Orders", val: orders.filter(o => o.status === "OPEN").length, color: C.yellow },
              { label: "Signals (1h)", val: signals.length, color: C.blue },
              { label: "Arb Opps", val: arbSignals.filter(a => a.actionable).length, color: C.cyan },
            ].map(s => (
              <div key={s.label} style={card}>
                <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: MONO }}>{s.val}</div>
              </div>
            ))}
          </div>
          {/* Equity Curve */}
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 8 }}>EQUITY CURVE</div>
            <Spark data={eqHistory} w={700} h={80} color={eqHistory[eqHistory.length - 1] >= 10000 ? C.accent : C.red} />
          </div>
          {/* Markets */}
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>TRACKED MARKETS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {markets.map(m => (
                <div key={m.id} style={{ background: C.surface2, borderRadius: 6, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 12, maxWidth: "70%" }}>{m.q}</div>
                  <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: m.yes > 0.5 ? C.accent : C.blue }}>
                    {(m.yes * 100).toFixed(1)}¢
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* NEWS ENGINE */}
      {tab === "News Engine" && (
        <div style={card}>
          <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>LIVE NEWS FEED — NLP SENTIMENT SCORING</div>
          {news.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>Start the bot to begin ingesting news...</div>}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {news.map(n => (
              <div key={n.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.border}`, alignItems: "center" }}>
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, minWidth: 60 }}>{n.time}</div>
                <div style={pill(C.text, C.surface2)}>{n.source}</div>
                <div style={{ flex: 1, fontSize: 13 }}>{n.headline}</div>
                <div style={pill(
                  n.sentiment > 0.2 ? C.accent : n.sentiment < -0.2 ? C.red : C.yellow,
                  n.sentiment > 0.2 ? C.accentDim : n.sentiment < -0.2 ? C.redDim : C.yellowDim,
                )}>{n.sentiment > 0 ? "+" : ""}{n.sentiment.toFixed(2)}</div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, minWidth: 30 }}>
                  IMP {(n.impact * 100).toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SIGNALS */}
      {tab === "Signals" && (
        <div style={card}>
          <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>MOMENTUM & EDGE SIGNALS</div>
          {signals.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>Start the bot to generate signals...</div>}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: MONO }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: "6px 8px" }}>TIME</th>
                  <th>MARKET</th>
                  <th>DIR</th>
                  <th>CONF</th>
                  <th>MOM</th>
                  <th>EDGE</th>
                  <th>SOURCE</th>
                </tr>
              </thead>
              <tbody>
                {signals.map(s => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}22` }}>
                    <td style={{ padding: "6px 8px", color: C.dim }}>{s.time}</td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mktName(s.market)}</td>
                    <td><span style={pill(s.direction === "BUY_YES" ? C.accent : C.red, s.direction === "BUY_YES" ? C.accentDim : C.redDim)}>{s.direction}</span></td>
                    <td style={{ color: s.confidence > 0.7 ? C.accent : C.yellow }}>{(s.confidence * 100).toFixed(0)}%</td>
                    <td style={{ color: s.momentum > 0 ? C.accent : C.red }}>{s.momentum > 0 ? "+" : ""}{(s.momentum * 100).toFixed(1)}%</td>
                    <td style={{ color: C.blue }}>{(s.edge * 100).toFixed(2)}%</td>
                    <td style={{ color: C.dim }}>{s.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MARKET MAKING */}
      {tab === "Arbitrage" && (
        <div>
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>CROSS-MARKET ARBITRAGE SCANNER</div>
            {arbSignals.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>Start the bot to scan for arbitrage opportunities...</div>}
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: MONO }}>
                <thead>
                  <tr style={{ color: C.dim, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ padding: "6px 8px" }}>TIME</th>
                    <th>PAIR</th>
                    <th>RELATION</th>
                    <th>IMPLIED</th>
                    <th>EXPECTED</th>
                    <th>MISMATCH</th>
                    <th>ARB SCORE</th>
                    <th>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {arbSignals.map(a => (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${C.border}22`, background: a.actionable ? `${C.cyan}08` : "transparent" }}>
                      <td style={{ padding: "6px 8px", color: C.dim }}>{a.time}</td>
                      <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{a.label}</td>
                      <td><span style={pill(
                        a.relation === "correlated" ? C.accent : a.relation === "inverse" ? C.red : C.dim,
                        a.relation === "correlated" ? C.accentDim : a.relation === "inverse" ? C.redDim : C.surface2,
                      )}>{a.relation}</span></td>
                      <td>{(a.impliedB * 100).toFixed(1)}¢</td>
                      <td>{(a.expectedB * 100).toFixed(1)}¢</td>
                      <td style={{ color: a.mismatch > 0.05 ? C.yellow : C.dim }}>{(a.mismatch * 100).toFixed(2)}%</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 50, height: 5, background: C.surface2, borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ width: `${a.arbScore * 100}%`, height: "100%", borderRadius: 3,
                              background: a.arbScore > 0.7 ? C.cyan : a.arbScore > 0.4 ? C.yellow : C.dim,
                            }} />
                          </div>
                          <span style={{ color: a.arbScore > 0.7 ? C.cyan : a.arbScore > 0.4 ? C.yellow : C.dim }}>{(a.arbScore * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td>{a.actionable
                        ? <span style={pill(C.cyan, C.cyanDim)}>{a.direction}</span>
                        : <span style={{ color: C.dim }}>—</span>
                      }</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* LINKED MARKET PAIRS */}
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>LINKED MARKET PAIRS — CORRELATION MAP</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {LINKED_MARKETS.map((lm, i) => {
                const mA = markets.find(m => m.id === lm.pair[0]);
                const mB = markets.find(m => m.id === lm.pair[1]);
                const latestArb = arbSignals.find(a => a.marketA === lm.pair[0] && a.marketB === lm.pair[1]);
                return (
                  <div key={i} style={{ background: C.surface2, borderRadius: 6, padding: "10px 14px",
                    borderLeft: `3px solid ${lm.relation === "correlated" ? C.accent : lm.relation === "inverse" ? C.red : C.dim}`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600 }}>{lm.label}</span>
                      <span style={pill(
                        lm.relation === "correlated" ? C.accent : lm.relation === "inverse" ? C.red : C.dim,
                        lm.relation === "correlated" ? C.accentDim : lm.relation === "inverse" ? C.redDim : C.surface,
                      )}>{lm.relation}</span>
                    </div>
                    <div style={{ fontSize: 10, color: C.dim, marginBottom: 6, fontStyle: "italic" }}>{lm.rationale}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11 }}>
                      <span>A: {mA ? (mA.yes * 100).toFixed(1) : "?"}¢</span>
                      <span>B: {mB ? (mB.yes * 100).toFixed(1) : "?"}¢</span>
                      {latestArb && <span style={{ color: latestArb.actionable ? C.cyan : C.dim }}>
                        arb: {(latestArb.arbScore * 100).toFixed(0)}%
                      </span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ARB CONFIG */}
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 8 }}>ARBITRAGE ENGINE PARAMETERS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {[
                { l: "Min Arb Score", v: "0.40" },
                { l: "Max Leg Spread", v: "5.0¢" },
                { l: "Correlation Window", v: "30d" },
                { l: "Max Pair Exposure", v: "$1,500" },
                { l: "Confidence Threshold", v: "70%" },
                { l: "Scan Interval", v: "3.6s" },
                { l: "Decay Half-Life", v: "4h" },
                { l: "Pair Limit", v: "6 active" },
              ].map(p => (
                <div key={p.l} style={{ background: C.surface2, borderRadius: 6, padding: "8px 12px" }}>
                  <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>{p.l}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: C.text, marginTop: 4 }}>{p.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MARKET MAKING (original) */}
      {tab === "Market Making" && (
        <div>
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>ORDER BOOK — MARKET MAKING ENGINE</div>
            {orders.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>Start the bot to see orders...</div>}
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: MONO }}>
                <thead>
                  <tr style={{ color: C.dim, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ padding: "6px 8px" }}>TIME</th>
                    <th>MARKET</th>
                    <th>TYPE</th>
                    <th>SIDE</th>
                    <th>PRICE</th>
                    <th>SIZE</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}22` }}>
                      <td style={{ padding: "6px 8px", color: C.dim }}>{o.time}</td>
                      <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mktName(o.market)}</td>
                      <td><span style={pill(o.type === "MM_QUOTE" ? C.purple : C.text, C.surface2)}>{o.type}</span></td>
                      <td style={{ color: o.side === "YES" ? C.accent : C.red }}>{o.side}</td>
                      <td>{(o.price * 100).toFixed(1)}¢</td>
                      <td>${o.size}</td>
                      <td><span style={pill(
                        o.status === "FILLED" ? C.accent : o.status === "OPEN" ? C.yellow : C.blue,
                        o.status === "FILLED" ? C.accentDim : o.status === "OPEN" ? C.yellowDim : C.blueDim,
                      )}>{o.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 8 }}>MM SPREAD PARAMETERS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {[{ l: "Bid Spread", v: "2.5%" }, { l: "Ask Spread", v: "2.5%" }, { l: "Quote Size", v: "$150" }, { l: "Refresh Rate", v: "1.8s" }, { l: "Inventory Skew", v: "0.3" }, { l: "Max Exposure", v: `$${riskLimits.maxExposure}` }].map(p => (
                <div key={p.l} style={{ background: C.surface2, borderRadius: 6, padding: "8px 12px" }}>
                  <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>{p.l}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: C.text, marginTop: 4 }}>{p.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* RISK */}
      {tab === "Risk" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>RISK LIMITS</div>
              {[
                { k: "maxPos", l: "Max Position", u: "$" },
                { k: "maxDD", l: "Max Drawdown", u: "%" },
                { k: "maxExposure", l: "Max Exposure", u: "$" },
              ].map(r => (
                <div key={r.k} style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 11, color: C.dim, fontFamily: MONO, display: "block", marginBottom: 4 }}>{r.l} ({r.u})</label>
                  <input type="number" value={riskLimits[r.k]}
                    onChange={e => setRiskLimits(prev => ({ ...prev, [r.k]: +e.target.value }))}
                    style={{
                      background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 4,
                      color: C.text, padding: "6px 10px", fontFamily: MONO, fontSize: 13, width: "100%",
                    }} />
                </div>
              ))}
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>POSITION EXPOSURE</div>
              {Object.keys(positions).length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>No positions yet</div>}
              {Object.entries(positions).map(([mid, pos]) => {
                const net = pos.yes - pos.no;
                const exposure = pos.yes + pos.no;
                const pct = (exposure / riskLimits.maxExposure) * 100;
                return (
                  <div key={mid} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mktName(mid)}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ flex: 1, height: 6, background: C.surface2, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pct > 80 ? C.red : pct > 50 ? C.yellow : C.accent, borderRadius: 3, transition: "width .3s" }} />
                      </div>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: net > 0 ? C.accent : C.red }}>
                        {net > 0 ? "+" : ""}{net} net
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={card}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 8 }}>RISK METRICS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {[
                { l: "VaR (95%)", v: `$${Math.floor(rnd(200, 600))}` },
                { l: "Sharpe (est)", v: rnd(0.5, 2.5).toFixed(2) },
                { l: "Win Rate", v: `${(rnd(48, 62)).toFixed(1)}%` },
                { l: "Avg Trade", v: `$${rnd(5, 25).toFixed(2)}` },
              ].map(m => (
                <div key={m.l} style={{ background: C.surface2, borderRadius: 6, padding: "10px 14px" }}>
                  <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>{m.l}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, color: C.text, marginTop: 4 }}>{m.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* BACKTEST */}
      {tab === "Backtest" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 12 }}>BACKTEST PARAMETERS</div>
              {[
                { k: "days", l: "Lookback Days", min: 10, max: 365, step: 1 },
                { k: "aggression", l: "Aggression", min: 0.1, max: 3, step: 0.1 },
                { k: "sizing", l: "Position Sizing", min: 0.1, max: 3, step: 0.1 },
              ].map(p => (
                <div key={p.k} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <label style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>{p.l}</label>
                    <span style={{ fontSize: 12, fontFamily: MONO, color: C.accent }}>{btParams[p.k]}</span>
                  </div>
                  <input type="range" min={p.min} max={p.max} step={p.step} value={btParams[p.k]}
                    onChange={e => setBtParams(prev => ({ ...prev, [p.k]: +e.target.value }))}
                    style={{ width: "100%", accentColor: C.accent }} />
                </div>
              ))}
              <button onClick={() => setBtResult(runBacktest(btParams))} style={{
                width: "100%", padding: "10px", borderRadius: 6, border: "none", cursor: "pointer",
                background: C.accent, color: C.bg, fontFamily: MONO, fontSize: 13, fontWeight: 700, marginTop: 8,
              }}>RUN BACKTEST</button>
            </div>
            <div style={card}>
              {!btResult ? (
                <div style={{ color: C.dim, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
                  Configure parameters and run a backtest
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 10 }}>BACKTEST RESULTS — {btParams.days} DAYS</div>
                  <Spark data={btResult.equity} w={500} h={100} color={btResult.totalReturn >= 0 ? C.accent : C.red} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 14 }}>
                    {[
                      { l: "Return", v: `${btResult.totalReturn}%`, c: btResult.totalReturn >= 0 ? C.accent : C.red },
                      { l: "Sharpe", v: btResult.sharpe, c: btResult.sharpe > 1 ? C.accent : C.yellow },
                      { l: "Max DD", v: `${btResult.maxDD}%`, c: btResult.maxDD < 10 ? C.accent : C.red },
                      { l: "Calmar", v: btResult.calmar, c: btResult.calmar > 1 ? C.accent : C.yellow },
                      { l: "Wins", v: btResult.wins, c: C.accent },
                      { l: "Losses", v: btResult.losses, c: C.red },
                      { l: "Win Rate", v: `${((btResult.wins / (btResult.wins + btResult.losses)) * 100).toFixed(1)}%`, c: C.blue },
                      { l: "Total Trades", v: btResult.wins + btResult.losses, c: C.text },
                    ].map(m => (
                      <div key={m.l} style={{ background: C.surface2, borderRadius: 6, padding: "8px 10px" }}>
                        <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>{m.l}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: m.c, marginTop: 2 }}>{m.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ textAlign: "center", padding: "20px 0 8px", fontSize: 10, color: C.dim, fontFamily: MONO }}>
        POLYMARKET BOT v0.2 — CROSS-MARKET ARB — SIMULATED DATA — NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
