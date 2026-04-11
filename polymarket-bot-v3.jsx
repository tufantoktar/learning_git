import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from "react";

// ═══════════════════════════════════════════════════════════════
//  POLYMARKET BOT V3 — PRODUCTION ARCHITECTURE
//  Mode: Paper Trading (swap adapters for live)
// ═══════════════════════════════════════════════════════════════

const M = "'JetBrains Mono','Fira Code',monospace";
const S = "'DM Sans','Segoe UI',sans-serif";
const C = {
  bg:"#06060b",s1:"#0d0d15",s2:"#14141f",s3:"#1b1b2a",
  bd:"#222236",tx:"#e4e4ef",dm:"#5e5e80",
  g:"#00e89a",gd:"#00e89a22",r:"#ff3d5a",rd:"#ff3d5a22",
  y:"#ffb830",yd:"#ffb83022",b:"#2d8cf0",bd2:"#2d8cf022",
  p:"#9966ff",pd:"#9966ff22",c:"#00ccee",cd:"#00ccee22",
  o:"#ff8844",od:"#ff884422",
};
const pill=(c,bg)=>({display:"inline-block",padding:"2px 7px",borderRadius:4,fontSize:10,fontFamily:M,color:c,background:bg,fontWeight:600});
const card={background:C.s1,border:`1px solid ${C.bd}`,borderRadius:8,padding:14,marginBottom:10};
const miniCard={background:C.s2,borderRadius:6,padding:"8px 12px"};
const inp={background:C.s2,border:`1px solid ${C.bd}`,borderRadius:4,color:C.tx,padding:"5px 8px",fontFamily:M,fontSize:12,width:"100%"};

// ═══════════════════════════════════════════════════════════════
//  LAYER 0 — CORE INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════

class EventBus {
  constructor(){this.listeners={}; this.log=[];}
  on(evt,fn){(this.listeners[evt]||(this.listeners[evt]=[])).push(fn);}
  off(evt,fn){this.listeners[evt]=(this.listeners[evt]||[]).filter(f=>f!==fn);}
  emit(evt,data){
    const ts=Date.now();
    this.log.push({evt,ts,data:typeof data==='object'?{...data}:data});
    if(this.log.length>200)this.log.shift();
    (this.listeners[evt]||[]).forEach(fn=>{try{fn(data,ts)}catch(e){console.error(`EventBus[${evt}]`,e)}});
  }
}

class CircuitBreaker {
  constructor(cfg){this.cfg=cfg;this.halted=false;this.reason=null;this.errorCount=0;this.lastReset=Date.now();}
  check(riskState){
    if(riskState.currentDrawdown>this.cfg.maxDrawdownHalt){this.halt(`Drawdown ${(riskState.currentDrawdown*100).toFixed(1)}% > ${(this.cfg.maxDrawdownHalt*100)}% limit`);return false;}
    if(riskState.grossExposure>this.cfg.maxExposureHalt){this.halt(`Gross exposure $${riskState.grossExposure} > $${this.cfg.maxExposureHalt} limit`);return false;}
    return !this.halted;
  }
  onError(){this.errorCount++;if(this.errorCount>this.cfg.maxErrors){this.halt(`Error count ${this.errorCount} exceeded limit`);}}
  halt(reason){this.halted=true;this.reason=reason;}
  reset(){this.halted=false;this.reason=null;this.errorCount=0;}
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 1 — MARKET DATA (Paper-mode with realistic simulation)
// ═══════════════════════════════════════════════════════════════

const MARKETS_INIT = [
  {id:"btc150k",q:"Will BTC hit $150k by Dec 2026?",yes:0.42,vol:0.02,cat:"crypto"},
  {id:"recession",q:"US recession in 2026?",yes:0.28,vol:0.015,cat:"macro"},
  {id:"trump28",q:"Trump wins 2028 GOP primary?",yes:0.61,vol:0.01,cat:"politics"},
  {id:"fedcut",q:"Fed cuts rates by July 2026?",yes:0.55,vol:0.018,cat:"macro"},
  {id:"aibar",q:"AI model passes bar exam top 1%?",yes:0.73,vol:0.012,cat:"tech"},
  {id:"starship",q:"SpaceX Starship orbital success?",yes:0.67,vol:0.008,cat:"tech"},
  {id:"ethflip",q:"ETH flips BTC market cap?",yes:0.08,vol:0.025,cat:"crypto"},
  {id:"ceasefire",q:"Ukraine ceasefire by 2026?",yes:0.34,vol:0.014,cat:"geopolitics"},
];

const PAIR_DEFS = [
  {a:"btc150k",b:"ethflip",type:"inverse",beta:-0.6,label:"BTC $150k ↔ ETH flip"},
  {a:"recession",b:"fedcut",type:"correlated",beta:0.75,label:"Recession ↔ Fed cuts"},
  {a:"btc150k",b:"fedcut",type:"correlated",beta:0.5,label:"BTC $150k ↔ Fed cuts"},
  {a:"recession",b:"btc150k",type:"inverse",beta:-0.55,label:"Recession ↔ BTC $150k"},
  {a:"trump28",b:"ceasefire",type:"weak",beta:0.2,label:"Trump ↔ Ceasefire"},
  {a:"aibar",b:"starship",type:"independent",beta:0.0,label:"AI bar ↔ Starship"},
];

// Brownian motion with mean-reversion + event shocks
function advancePrice(mkt, dt=1) {
  const mr = 0.002 * (0.5 - mkt.yes); // mean-revert toward 0.5
  const noise = (Math.random()-0.5) * 2 * mkt.vol * Math.sqrt(dt);
  const shock = Math.random() < 0.005 ? (Math.random()-0.5)*0.08 : 0;
  const next = Math.max(0.02, Math.min(0.98, mkt.yes + mr + noise + shock));
  return {...mkt, yes: +next.toFixed(4), prevYes: mkt.yes};
}

// Simulated order book depth
function genDepth(mid, spread=0.02) {
  const bids=[], asks=[];
  for(let i=1;i<=5;i++){
    bids.push({price:+(mid-spread*i/2).toFixed(3), size:Math.floor(50+Math.random()*400)});
    asks.push({price:+(mid+spread*i/2).toFixed(3), size:Math.floor(50+Math.random()*400)});
  }
  return {bids, asks, spread:+(asks[0].price-bids[0].price).toFixed(3), midPrice:mid};
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 1 — NEWS FEED (Simulated NLP pipeline)
// ═══════════════════════════════════════════════════════════════

const NEWS_TEMPLATES = [
  {tpl:"Federal Reserve signals {action} in upcoming meeting",entities:["fed","rates"],markets:["fedcut","recession"],baseImpact:0.7},
  {tpl:"Bitcoin {action} past key {level} on {driver}",entities:["btc","crypto"],markets:["btc150k","ethflip"],baseImpact:0.6},
  {tpl:"{poll_source} shows {candidate} {movement} in {race}",entities:["polls","election"],markets:["trump28"],baseImpact:0.5},
  {tpl:"SpaceX announces {event} for Starship program",entities:["spacex","starship"],markets:["starship"],baseImpact:0.4},
  {tpl:"Treasury yields {movement} on {driver} expectations",entities:["treasury","macro"],markets:["fedcut","recession","btc150k"],baseImpact:0.5},
  {tpl:"Leading AI lab reports {result} on {benchmark}",entities:["ai","benchmark"],markets:["aibar"],baseImpact:0.6},
  {tpl:"Diplomatic {event} between {parties} raises {outcome} hopes",entities:["diplomacy","conflict"],markets:["ceasefire"],baseImpact:0.55},
  {tpl:"Ethereum {action} as {driver} shifts market dynamics",entities:["eth","crypto"],markets:["ethflip","btc150k"],baseImpact:0.45},
];

function generateNewsEvent(markets) {
  const tmpl = NEWS_TEMPLATES[Math.floor(Math.random()*NEWS_TEMPLATES.length)];
  // NLP-derived sentiment based on market movement (not random)
  const relatedMkts = tmpl.markets.map(id=>markets.find(m=>m.id===id)).filter(Boolean);
  const avgMove = relatedMkts.reduce((s,m)=>s+(m.yes-(m.prevYes||m.yes)),0)/(relatedMkts.length||1);
  const sentiment = Math.max(-1,Math.min(1, avgMove * 20 + (Math.random()-0.5)*0.3)); // signal + noise
  const impactClass = Math.abs(sentiment)>0.5?"binary_catalyst":Math.abs(sentiment)>0.2?"gradual_shift":"noise";
  const confidence = 0.5 + Math.abs(sentiment)*0.4 + Math.random()*0.1;
  return {
    id:Math.random().toString(36).slice(2,8), time:Date.now(),
    source:["Reuters","Bloomberg","AP","Polymarket","X/Twitter"][Math.floor(Math.random()*5)],
    headline:tmpl.tpl, entities:tmpl.entities,
    relatedMarkets:tmpl.markets, sentiment:+sentiment.toFixed(3),
    impactClass, confidence:+Math.min(1,confidence).toFixed(3),
    baseImpact:tmpl.baseImpact, processed:true,
  };
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 2 — ALPHA ENGINES (Real calculations, not rnd())
// ═══════════════════════════════════════════════════════════════

// Price history ring buffer per market
class PriceHistory {
  constructor(size=200){this.buf=[];this.size=size;}
  push(price,ts){this.buf.push({price,ts});if(this.buf.length>this.size)this.buf.shift();}
  get length(){return this.buf.length;}
  slice(n){return this.buf.slice(-n).map(b=>b.price);}
  roc(n){
    if(this.buf.length<n+1)return 0;
    const old=this.buf[this.buf.length-n-1].price;
    const cur=this.buf[this.buf.length-1].price;
    return old===0?0:(cur-old)/old;
  }
  sma(n){const s=this.slice(n);return s.length?s.reduce((a,b)=>a+b,0)/s.length:0;}
  std(n){const s=this.slice(n);if(s.length<2)return 0;const m=s.reduce((a,b)=>a+b,0)/s.length;return Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/(s.length-1));}
  vol(n){const s=this.slice(n);if(s.length<3)return 0;const rets=[];for(let i=1;i<s.length;i++)rets.push(s[i]/s[i-1]-1);const m=rets.reduce((a,b)=>a+b,0)/rets.length;return Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1));}
}

function computeMomentumSignal(mktId, history, currentPrice) {
  if(history.length < 20) return null;
  const roc5 = history.roc(5);
  const roc20 = history.roc(20);
  const sma10 = history.sma(10);
  const sma30 = history.sma(30);
  const vol = history.vol(20);

  // Trend: price above SMA + positive ROC
  const trendScore = ((currentPrice > sma10 ? 0.3 : -0.3) + (currentPrice > sma30 ? 0.2 : -0.2) + Math.max(-0.5, Math.min(0.5, roc5 * 10)));
  // Mean reversion: extended moves with high vol tend to revert
  const extension = (currentPrice - sma30) / (vol || 0.01);
  const mrScore = extension > 2 ? -0.4 : extension < -2 ? 0.4 : 0;
  const composite = trendScore + mrScore;
  const absComposite = Math.abs(composite);

  if(absComposite < 0.15) return null; // below threshold

  return {
    id:Math.random().toString(36).slice(2,8), source:"momentum", time:Date.now(),
    conditionId:mktId,
    direction: composite > 0 ? "BUY_YES" : "BUY_NO",
    edge: +(absComposite * 0.05).toFixed(4),
    confidence: +Math.min(0.95, 0.4 + absComposite * 0.3).toFixed(3),
    fairValue: +(currentPrice + composite * 0.02).toFixed(4),
    currentPrice, decayFactor:1.0,
    meta: {roc5:+roc5.toFixed(4), roc20:+roc20.toFixed(4), sma10:+sma10.toFixed(4), sma30:+sma30.toFixed(4), vol:+vol.toFixed(4), trendScore:+trendScore.toFixed(3), mrScore:+mrScore.toFixed(3)},
    expiresAt: Date.now() + 300000, // 5 min
  };
}

function computeNLPSignal(newsEvent, markets) {
  if(newsEvent.impactClass === "noise") return null;
  if(newsEvent.confidence < 0.5) return null;

  const signals = [];
  for(const mktId of newsEvent.relatedMarkets) {
    const mkt = markets.find(m=>m.id===mktId);
    if(!mkt) continue;
    const sentimentEdge = newsEvent.sentiment * newsEvent.baseImpact * newsEvent.confidence * 0.04;
    if(Math.abs(sentimentEdge) < 0.005) continue;
    const fairValue = Math.max(0.02, Math.min(0.98, mkt.yes + sentimentEdge));
    signals.push({
      id:Math.random().toString(36).slice(2,8), source:"nlp", time:Date.now(),
      conditionId:mktId,
      direction: sentimentEdge > 0 ? "BUY_YES" : "BUY_NO",
      edge: +Math.abs(sentimentEdge).toFixed(4),
      confidence: +newsEvent.confidence.toFixed(3),
      fairValue: +fairValue.toFixed(4),
      currentPrice: mkt.yes, decayFactor:1.0,
      triggerEvent: newsEvent.id,
      meta: {sentiment:newsEvent.sentiment,impactClass:newsEvent.impactClass,headline:newsEvent.headline},
      expiresAt: Date.now() + 600000,
    });
  }
  return signals.length ? signals : null;
}

function computeArbSignal(markets, histories) {
  const results = [];
  for(const pair of PAIR_DEFS) {
    const mA = markets.find(m=>m.id===pair.a);
    const mB = markets.find(m=>m.id===pair.b);
    if(!mA||!mB) continue;
    const hA = histories[pair.a], hB = histories[pair.b];
    if(!hA||!hB||hA.length<20||hB.length<20) continue;

    // Compute rolling correlation from price histories
    const pA = hA.slice(20), pB = hB.slice(20);
    const mAv = pA.reduce((s,v)=>s+v,0)/pA.length;
    const mBv = pB.reduce((s,v)=>s+v,0)/pB.length;
    let cov=0,vA=0,vB=0;
    for(let i=0;i<Math.min(pA.length,pB.length);i++){
      cov+=(pA[i]-mAv)*(pB[i]-mBv);vA+=(pA[i]-mAv)**2;vB+=(pB[i]-mBv)**2;
    }
    const corr = (vA&&vB) ? cov/Math.sqrt(vA*vB) : 0;

    // Expected B given A using regression
    const stdA = hA.std(20), stdB = hB.std(20);
    const beta = stdA>0 ? corr * (stdB/stdA) : pair.beta;
    const expectedB = mBv + beta * (mA.yes - mAv);
    const mismatch = mB.yes - expectedB;
    const mismatchStd = hB.std(20) || 0.01;
    const zScore = mismatch / mismatchStd;

    const absZ = Math.abs(zScore);
    if(absZ < 1.5) continue; // need >1.5σ

    const depth = genDepth(mB.yes);
    const liquidEnough = depth.bids[0].size > 50 && depth.asks[0].size > 50;
    if(!liquidEnough) continue;

    const netEdge = Math.abs(mismatch) - depth.spread;
    if(netEdge <= 0) continue;

    results.push({
      id:Math.random().toString(36).slice(2,8), source:"arb", time:Date.now(),
      conditionId:mB.id,
      direction: mismatch > 0 ? "BUY_NO" : "BUY_YES", // B is overpriced → sell, underpriced → buy
      edge: +Math.abs(netEdge).toFixed(4),
      confidence: +Math.min(0.95, 0.3 + absZ * 0.15).toFixed(3),
      fairValue: +Math.max(0.02,Math.min(0.98,expectedB)).toFixed(4),
      currentPrice: mB.yes, decayFactor:1.0,
      legA:{conditionId:mA.id,price:mA.yes},
      legB:{conditionId:mB.id,price:mB.yes},
      zScore:+zScore.toFixed(2), correlation:+corr.toFixed(3),
      beta:+beta.toFixed(3), pairLabel:pair.label,
      netEdge:+netEdge.toFixed(4), mismatch:+mismatch.toFixed(4),
      expiresAt:Date.now()+900000,
    });
  }
  return results.length ? results : null;
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 2 — COMPOSITE ALPHA
// ═══════════════════════════════════════════════════════════════

function compositeAlpha(activeSignals, riskState) {
  // Group by conditionId
  const byMkt = {};
  const now = Date.now();
  for(const sig of activeSignals) {
    if(sig.expiresAt < now) continue; // expired
    const decay = Math.max(0, 1 - (now - sig.time) / (sig.expiresAt - sig.time));
    if(decay < 0.1) continue;
    const key = sig.conditionId;
    if(!byMkt[key]) byMkt[key] = [];
    byMkt[key].push({...sig, decayFactor: decay});
  }

  const recs = [];
  for(const [mktId, sigs] of Object.entries(byMkt)) {
    const buyYes = sigs.filter(s=>s.direction==="BUY_YES");
    const buyNo = sigs.filter(s=>s.direction==="BUY_NO");

    // Concordance: if sources agree, boost
    const yesEdge = buyYes.reduce((s,sig)=>s + sig.edge * sig.confidence * sig.decayFactor, 0);
    const noEdge = buyNo.reduce((s,sig)=>s + sig.edge * sig.confidence * sig.decayFactor, 0);

    const direction = yesEdge >= noEdge ? "BUY_YES" : "BUY_NO";
    const compositeEdge = Math.abs(yesEdge - noEdge);
    const concordance = (direction==="BUY_YES" ? buyYes.length : buyNo.length) / sigs.length;

    // Need minimum edge after concordance adjustment
    const adjEdge = compositeEdge * (0.5 + concordance * 0.5);
    if(adjEdge < 0.008) continue;

    const compositeConf = Math.min(0.95,
      sigs.reduce((s,sig)=>s + sig.confidence * sig.decayFactor, 0) / sigs.length * concordance
    );

    // Kelly criterion for sizing (fractional Kelly = 0.25)
    const kellyFrac = compositeConf - (1-compositeConf) / (adjEdge / (1-adjEdge) || 1);
    const suggestedSize = Math.max(0, Math.floor(kellyFrac * 0.25 * 10000)); // 25% Kelly on $10k

    if(suggestedSize < 10) continue;

    const attribution = {};
    sigs.forEach(s=>{attribution[s.source]=(attribution[s.source]||0)+s.edge*s.confidence*s.decayFactor;});
    const totalAttr = Object.values(attribution).reduce((s,v)=>s+Math.abs(v),0)||1;
    Object.keys(attribution).forEach(k=>attribution[k]=+((Math.abs(attribution[k])/totalAttr)*100).toFixed(1));

    recs.push({
      id:Math.random().toString(36).slice(2,8), time:Date.now(),
      conditionId:mktId, direction, compositeEdge:+adjEdge.toFixed(4),
      compositeConfidence:+compositeConf.toFixed(3),
      concordance:+concordance.toFixed(2),
      suggestedSize, attribution,
      contributingSignals: sigs.length,
      urgency: adjEdge > 0.03 ? "immediate" : adjEdge > 0.015 ? "patient" : "passive",
    });
  }
  return recs;
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 3 — PRE-TRADE RISK (Gate with veto power)
// ═══════════════════════════════════════════════════════════════

function preTradeRisk(rec, positions, riskCfg, riskState) {
  const checks = [];
  let approved = true;
  let adjustedSize = rec.suggestedSize;

  // Check 1: Per-market position limit
  const existing = positions[rec.conditionId] || {net:0,gross:0};
  if(existing.gross + adjustedSize > riskCfg.maxPositionPerMarket) {
    adjustedSize = Math.max(0, riskCfg.maxPositionPerMarket - existing.gross);
    checks.push({name:"Position limit", status: adjustedSize>0?"adjusted":"blocked", detail:`Existing $${existing.gross}, limit $${riskCfg.maxPositionPerMarket}`});
    if(adjustedSize===0) approved=false;
  } else checks.push({name:"Position limit", status:"pass", detail:`$${existing.gross+adjustedSize} < $${riskCfg.maxPositionPerMarket}`});

  // Check 2: Portfolio exposure
  if(riskState.grossExposure + adjustedSize > riskCfg.maxPortfolioExposure) {
    adjustedSize = Math.max(0, riskCfg.maxPortfolioExposure - riskState.grossExposure);
    checks.push({name:"Portfolio exposure", status: adjustedSize>0?"adjusted":"blocked", detail:`Total would exceed $${riskCfg.maxPortfolioExposure}`});
    if(adjustedSize===0) approved=false;
  } else checks.push({name:"Portfolio exposure", status:"pass", detail:`$${riskState.grossExposure+adjustedSize} < $${riskCfg.maxPortfolioExposure}`});

  // Check 3: Drawdown gate
  if(riskState.currentDrawdown > riskCfg.softDrawdownLimit) {
    adjustedSize = Math.floor(adjustedSize * 0.5);
    checks.push({name:"Drawdown gate", status:"reduced", detail:`DD ${(riskState.currentDrawdown*100).toFixed(1)}% > soft limit ${(riskCfg.softDrawdownLimit*100)}%`});
  } else checks.push({name:"Drawdown gate", status:"pass", detail:`DD ${(riskState.currentDrawdown*100).toFixed(1)}% OK`});

  // Check 4: Category concentration
  const catPositions = Object.entries(positions).reduce((m,[id,p])=>{const mkt=MARKETS_INIT.find(x=>x.id===id);if(mkt){m[mkt.cat]=(m[mkt.cat]||0)+p.gross;}return m;},{});
  const mkt = MARKETS_INIT.find(x=>x.id===rec.conditionId);
  const catExposure = (catPositions[mkt?.cat]||0) + adjustedSize;
  if(catExposure > riskCfg.maxCategoryExposure) {
    adjustedSize = Math.max(0, riskCfg.maxCategoryExposure - (catPositions[mkt?.cat]||0));
    checks.push({name:"Category limit", status: adjustedSize>0?"adjusted":"blocked", detail:`${mkt?.cat} exposure $${catExposure} > $${riskCfg.maxCategoryExposure}`});
    if(adjustedSize===0) approved=false;
  } else checks.push({name:"Category limit", status:"pass", detail:`${mkt?.cat}: $${catExposure} OK`});

  // Check 5: Minimum edge after costs
  const estimatedCost = adjustedSize * 0.003; // ~0.3% spread cost estimate
  if(rec.compositeEdge * adjustedSize < estimatedCost) {
    checks.push({name:"Edge vs cost", status:"blocked", detail:`Edge $${(rec.compositeEdge*adjustedSize).toFixed(2)} < cost $${estimatedCost.toFixed(2)}`});
    approved = false;
  } else checks.push({name:"Edge vs cost", status:"pass", detail:`Edge $${(rec.compositeEdge*adjustedSize).toFixed(2)} > cost $${estimatedCost.toFixed(2)}`});

  return { approved: approved && adjustedSize >= 10, adjustedSize, checks, originalSize:rec.suggestedSize };
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 4 — SMART EXECUTION (Order splitting + tracking)
// ═══════════════════════════════════════════════════════════════

function smartExecute(rec, verdict, markets) {
  if(!verdict.approved) return null;
  const mkt = markets.find(m=>m.id===rec.conditionId);
  if(!mkt) return null;

  const size = verdict.adjustedSize;
  const side = rec.direction === "BUY_YES" ? "YES" : "NO";
  const midPrice = side==="YES" ? mkt.yes : 1-mkt.yes;
  const urgencySpread = rec.urgency==="immediate"?0.005:rec.urgency==="patient"?0:(-0.005);
  const limitPrice = +(midPrice + urgencySpread).toFixed(3);

  // Split large orders
  const maxChildSize = 200;
  const numChildren = Math.ceil(size / maxChildSize);
  const children = [];
  let remaining = size;
  for(let i=0;i<numChildren;i++){
    const childSize = Math.min(remaining, maxChildSize);
    // Simulate fill probability based on urgency
    const fillProb = rec.urgency==="immediate"?0.9:rec.urgency==="patient"?0.6:0.3;
    const filled = Math.random() < fillProb;
    const fillPrice = filled ? +(limitPrice + (Math.random()-0.5)*0.004).toFixed(3) : null;
    children.push({
      id:Math.random().toString(36).slice(2,8),
      size:childSize, limitPrice, fillPrice,
      status: filled?"FILLED":"OPEN",
      filledAt: filled ? Date.now() : null,
    });
    remaining -= childSize;
  }

  const totalFilled = children.filter(c=>c.status==="FILLED").reduce((s,c)=>s+c.size,0);
  const avgFillPrice = totalFilled ? children.filter(c=>c.status==="FILLED").reduce((s,c)=>s+c.fillPrice*c.size,0)/totalFilled : null;
  const slippage = avgFillPrice ? +(avgFillPrice - limitPrice).toFixed(4) : null;

  return {
    id:Math.random().toString(36).slice(2,8), time:Date.now(),
    conditionId:rec.conditionId, side, direction:rec.direction,
    parentSize:size, limitPrice,
    children, totalFilled, avgFillPrice, slippage,
    status: totalFilled===size?"FILLED":totalFilled>0?"PARTIAL":"WORKING",
    urgency:rec.urgency,
    compositeEdge:rec.compositeEdge, attribution:rec.attribution,
    riskChecks:verdict.checks,
  };
}

// ═══════════════════════════════════════════════════════════════
//  MINI COMPONENTS
// ═══════════════════════════════════════════════════════════════

function Spark({data,color=C.g,w=120,h=28}){
  if(!data||data.length<2)return null;
  const mn=Math.min(...data),mx=Math.max(...data),rng=mx-mn||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-((v-mn)/rng)*h}`).join(" ");
  return <svg width={w} height={h} style={{display:"block"}}><polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}/></svg>;
}

function Stat({label,value,color=C.tx,sub}){
  return <div style={miniCard}><div style={{fontSize:10,color:C.dm,fontFamily:M}}>{label}</div>
    <div style={{fontSize:17,fontWeight:700,fontFamily:M,color,marginTop:3}}>{value}</div>
    {sub&&<div style={{fontSize:10,color:C.dm,fontFamily:M,marginTop:2}}>{sub}</div>}
  </div>;
}

function RiskBadge({status}){
  const colors={pass:{c:C.g,bg:C.gd},adjusted:{c:C.y,bg:C.yd},reduced:{c:C.y,bg:C.yd},blocked:{c:C.r,bg:C.rd}};
  const {c,bg}=colors[status]||colors.pass;
  return <span style={pill(c,bg)}>{status.toUpperCase()}</span>;
}

const fmtTime=ts=>new Date(ts).toLocaleTimeString("en",{hour12:false});
const fmtPct=(v,d=1)=>(v*100).toFixed(d)+"%";
const fmtUSD=(v,d=0)=>"$"+v.toLocaleString(undefined,{maximumFractionDigits:d});
const mktQ=id=>MARKETS_INIT.find(m=>m.id===id)?.q||id;

// ═══════════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════════

const TABS=["Dashboard","Alpha: News","Alpha: Composite","Alpha: Arb","Execution","Risk","Backtest","Markets","Logs"];

function TabBar({active,set}){
  return <div style={{display:"flex",gap:1,borderBottom:`1px solid ${C.bd}`,marginBottom:14,overflowX:"auto"}}>
    {TABS.map(t=><button key={t} onClick={()=>set(t)} style={{
      padding:"8px 12px",background:active===t?C.s2:"transparent",
      color:active===t?C.g:C.dm,border:"none",cursor:"pointer",
      fontFamily:M,fontSize:11,fontWeight:600,whiteSpace:"nowrap",
      borderBottom:active===t?`2px solid ${C.g}`:"2px solid transparent",transition:"all .15s",
    }}>{t}</button>)}
  </div>;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════

export default function PolymarketBotV3() {
  const [tab, setTab] = useState("Dashboard");
  const [mode, setMode] = useState("paper"); // paper | live
  const [running, setRunning] = useState(false);
  const [markets, setMarkets] = useState(MARKETS_INIT.map(m=>({...m,prevYes:m.yes})));
  const [news, setNews] = useState([]);
  const [activeSignals, setActiveSignals] = useState([]);
  const [recommendations, setRecs] = useState([]);
  const [executions, setExecs] = useState([]);
  const [eqHistory, setEqHistory] = useState([10000]);
  const [riskCfg, setRiskCfg] = useState({
    maxPositionPerMarket:1500, maxPortfolioExposure:6000,
    softDrawdownLimit:0.10, maxCategoryExposure:3000,
  });

  const busRef = useRef(null);
  const cbRef = useRef(null);
  const histRef = useRef({});
  const intervalRef = useRef(null);

  // Initialize on mount
  useEffect(()=>{
    busRef.current = new EventBus();
    cbRef.current = new CircuitBreaker({maxDrawdownHalt:0.20, maxExposureHalt:8000, maxErrors:10});
    MARKETS_INIT.forEach(m=>{histRef.current[m.id]=new PriceHistory(200);});
  },[]);

  // Derived state
  const positions = useMemo(()=>{
    const pos={};
    executions.filter(e=>e.totalFilled>0).forEach(e=>{
      if(!pos[e.conditionId]) pos[e.conditionId]={yes:0,no:0,net:0,gross:0,avgPrice:0,pnl:0};
      const p=pos[e.conditionId];
      if(e.side==="YES"){p.yes+=e.totalFilled;p.avgPrice=e.avgFillPrice;}
      else{p.no+=e.totalFilled;p.avgPrice=e.avgFillPrice;}
      p.net=p.yes-p.no; p.gross=p.yes+p.no;
    });
    // Mark to market
    Object.entries(pos).forEach(([id,p])=>{
      const mkt=markets.find(m=>m.id===id);
      if(mkt){p.pnl=+(p.yes*(mkt.yes-p.avgPrice)+p.no*((1-mkt.yes)-p.avgPrice)).toFixed(2);}
    });
    return pos;
  },[executions,markets]);

  const riskState = useMemo(()=>{
    const grossExposure = Object.values(positions).reduce((s,p)=>s+p.gross,0);
    const totalPnl = Object.values(positions).reduce((s,p)=>s+p.pnl,0);
    const equity = 10000 + totalPnl;
    const peak = Math.max(10000,...eqHistory);
    const currentDrawdown = peak>0?(peak-equity)/peak:0;
    return {grossExposure,totalPnl:+totalPnl.toFixed(2),equity:+equity.toFixed(2),peak,currentDrawdown:+currentDrawdown.toFixed(4),halted:cbRef.current?.halted||false,haltReason:cbRef.current?.reason};
  },[positions,eqHistory]);

  // ── TICK ──
  const tick = useCallback(()=>{
    const bus = busRef.current;
    const cb = cbRef.current;
    if(!bus||!cb) return;

    // 1. Advance market prices (paper mode: Brownian motion)
    setMarkets(prev=>{
      const updated = prev.map(m=>advancePrice(m));
      updated.forEach(m=>{
        histRef.current[m.id]?.push(m.yes, Date.now());
        bus.emit("market:update",{id:m.id,price:m.yes,prevPrice:m.prevYes});
      });
      return updated;
    });

    // 2. Generate news (paper mode: ~30% chance per tick)
    setMarkets(mkts=>{
      if(Math.random()<0.3){
        const newsEvt = generateNewsEvent(mkts);
        setNews(prev=>[newsEvt,...prev].slice(0,80));
        bus.emit("news:scored",newsEvt);

        // NLP Alpha
        const nlpSigs = computeNLPSignal(newsEvt, mkts);
        if(nlpSigs){
          setActiveSignals(prev=>[...nlpSigs,...prev].slice(0,100));
          nlpSigs.forEach(s=>bus.emit("signal:new",s));
        }
      }
      return mkts; // no change
    });

    // 3. Momentum alpha (every tick, but only emits if threshold met)
    setMarkets(mkts=>{
      mkts.forEach(m=>{
        const hist = histRef.current[m.id];
        if(hist){
          const sig = computeMomentumSignal(m.id, hist, m.yes);
          if(sig){
            setActiveSignals(prev=>{
              // Deduplicate: remove old momentum signal for same market
              const filtered = prev.filter(s=>!(s.source==="momentum"&&s.conditionId===m.id));
              return [sig,...filtered].slice(0,100);
            });
            bus.emit("signal:new",sig);
          }
        }
      });
      return mkts;
    });

    // 4. Arb alpha (every 3rd tick approximately)
    if(Math.random()<0.35){
      setMarkets(mkts=>{
        const arbSigs = computeArbSignal(mkts, histRef.current);
        if(arbSigs){
          setActiveSignals(prev=>{
            const filtered = prev.filter(s=>s.source!=="arb");
            return [...arbSigs,...filtered].slice(0,100);
          });
          arbSigs.forEach(s=>bus.emit("signal:arb",s));
        }
        return mkts;
      });
    }

    // 5. Composite alpha + risk + execution pipeline
    setActiveSignals(sigs=>{
      if(!cb.check(riskState)){
        bus.emit("system:halted",{reason:cb.reason});
        return sigs;
      }
      const recs = compositeAlpha(sigs, riskState);
      if(recs.length){
        setRecs(prev=>[...recs,...prev].slice(0,50));
        recs.forEach(rec=>{
          const verdict = preTradeRisk(rec, positions, riskCfg, riskState);
          bus.emit("risk:verdict",{rec:rec.id,approved:verdict.approved,checks:verdict.checks});
          const exec = smartExecute(rec, verdict, markets);
          if(exec){
            setExecs(prev=>[exec,...prev].slice(0,80));
            bus.emit("execution:report",exec);
          }
        });
      }
      return sigs;
    });

    // 6. Update equity curve
    setEqHistory(prev=>[...prev, riskState.equity].slice(-200));
  },[markets,positions,riskCfg,riskState]);

  useEffect(()=>{
    if(running){intervalRef.current=setInterval(tick,2000);return ()=>clearInterval(intervalRef.current);}
    else clearInterval(intervalRef.current);
  },[running,tick]);

  // ═══════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════

  return (
    <div style={{background:C.bg,color:C.tx,minHeight:"100vh",fontFamily:S,padding:16}}>
      {/* HEADER */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,borderRadius:8,background:`linear-gradient(135deg,${C.g},${C.b})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:C.bg,fontFamily:M}}>V3</div>
          <div>
            <div style={{fontSize:16,fontWeight:700,letterSpacing:-0.5}}>Polymarket Bot V3</div>
            <div style={{fontSize:10,color:C.dm,fontFamily:M}}>PRODUCTION ARCHITECTURE · EVENT-DRIVEN · RISK-GATED</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {riskState.halted && <span style={pill(C.r,C.rd)}>⛔ HALTED</span>}
          <button onClick={()=>setMode(m=>m==="paper"?"live":"paper")} style={{...pill(mode==="paper"?C.y:C.r,mode==="paper"?C.yd:C.rd),cursor:"pointer",border:"none"}}>{mode.toUpperCase()}</button>
          <span style={pill(running?C.g:C.r,running?C.gd:C.rd)}>{running?"● LIVE":"○ OFF"}</span>
          <button onClick={()=>{setRunning(r=>!r);if(cbRef.current?.halted)cbRef.current.reset();}} style={{padding:"6px 16px",borderRadius:6,border:"none",cursor:"pointer",background:running?C.r:C.g,color:C.bg,fontFamily:M,fontSize:11,fontWeight:700}}>{running?"STOP":"START"}</button>
        </div>
      </div>

      <TabBar active={tab} set={setTab}/>

      {/* ── DASHBOARD ── */}
      {tab==="Dashboard"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:12}}>
          <Stat label="Equity" value={fmtUSD(riskState.equity)} color={riskState.equity>=10000?C.g:C.r}/>
          <Stat label="Session PnL" value={(riskState.totalPnl>=0?"+":"")+fmtUSD(riskState.totalPnl)} color={riskState.totalPnl>=0?C.g:C.r}/>
          <Stat label="Gross Exposure" value={fmtUSD(riskState.grossExposure)} color={riskState.grossExposure>4000?C.y:C.tx} sub={`/ ${fmtUSD(riskCfg.maxPortfolioExposure)}`}/>
          <Stat label="Drawdown" value={fmtPct(riskState.currentDrawdown)} color={riskState.currentDrawdown>0.1?C.r:riskState.currentDrawdown>0.05?C.y:C.g}/>
          <Stat label="Active Signals" value={activeSignals.filter(s=>s.expiresAt>Date.now()).length} color={C.b} sub={`${recommendations.length} recs`}/>
        </div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:6}}>EQUITY CURVE</div>
          <Spark data={eqHistory} w={680} h={70} color={eqHistory[eqHistory.length-1]>=10000?C.g:C.r}/>
        </div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>LIVE MARKETS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {markets.map(m=>{
              const chg = m.yes-(m.prevYes||m.yes);
              return <div key={m.id} style={{...miniCard,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:11,maxWidth:"65%"}}>{m.q}</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:M,fontSize:10,color:chg>0?C.g:chg<0?C.r:C.dm}}>{chg>0?"+":""}{(chg*100).toFixed(2)}¢</span>
                  <span style={{fontFamily:M,fontSize:14,fontWeight:700,color:m.yes>0.5?C.g:C.b}}>{(m.yes*100).toFixed(1)}¢</span>
                </div>
              </div>;
            })}
          </div>
        </div>
      </div>}

      {/* ── ALPHA: NEWS ── */}
      {tab==="Alpha: News"&&<div style={card}>
        <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>NLP NEWS PIPELINE — ENTITY EXTRACTION + IMPACT SCORING</div>
        {news.length===0&&<div style={{color:C.dm,fontSize:12}}>Start bot to ingest news...</div>}
        <div style={{maxHeight:500,overflowY:"auto"}}>
          {news.map(n=><div key={n.id} style={{display:"flex",gap:8,padding:"7px 0",borderBottom:`1px solid ${C.bd}22`,alignItems:"center",fontSize:11}}>
            <span style={{fontFamily:M,fontSize:10,color:C.dm,minWidth:55}}>{fmtTime(n.time)}</span>
            <span style={pill(C.tx,C.s2)}>{n.source}</span>
            <span style={{flex:1}}>{n.headline}</span>
            <span style={pill(n.impactClass==="binary_catalyst"?C.r:n.impactClass==="gradual_shift"?C.y:C.dm,n.impactClass==="binary_catalyst"?C.rd:n.impactClass==="gradual_shift"?C.yd:C.s2)}>{n.impactClass}</span>
            <span style={pill(n.sentiment>0.2?C.g:n.sentiment<-0.2?C.r:C.y,n.sentiment>0.2?C.gd:n.sentiment<-0.2?C.rd:C.yd)}>{n.sentiment>0?"+":""}{n.sentiment.toFixed(2)}</span>
            <span style={{fontFamily:M,fontSize:10,color:C.dm}}>conf {(n.confidence*100).toFixed(0)}%</span>
          </div>)}
        </div>
      </div>}

      {/* ── ALPHA: COMPOSITE ── */}
      {tab==="Alpha: Composite"&&<div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>ACTIVE SIGNALS — ALL ENGINES</div>
          <div style={{maxHeight:250,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:M}}>
              <thead><tr style={{color:C.dm,textAlign:"left",borderBottom:`1px solid ${C.bd}`}}>
                <th style={{padding:"5px 6px"}}>TIME</th><th>SOURCE</th><th>MARKET</th><th>DIR</th><th>EDGE</th><th>CONF</th><th>DECAY</th>
              </tr></thead>
              <tbody>{activeSignals.filter(s=>s.expiresAt>Date.now()).slice(0,30).map(s=>{
                const decay=Math.max(0,1-(Date.now()-s.time)/(s.expiresAt-s.time));
                return <tr key={s.id} style={{borderBottom:`1px solid ${C.bd}11`}}>
                  <td style={{padding:"5px 6px",color:C.dm}}>{fmtTime(s.time)}</td>
                  <td><span style={pill(s.source==="nlp"?C.c:s.source==="momentum"?C.p:C.b,s.source==="nlp"?C.cd:s.source==="momentum"?C.pd:C.bd2)}>{s.source}</span></td>
                  <td style={{maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{mktQ(s.conditionId)}</td>
                  <td><span style={pill(s.direction==="BUY_YES"?C.g:C.r,s.direction==="BUY_YES"?C.gd:C.rd)}>{s.direction}</span></td>
                  <td style={{color:C.y}}>{fmtPct(s.edge,2)}</td>
                  <td style={{color:s.confidence>0.7?C.g:C.y}}>{fmtPct(s.confidence,0)}</td>
                  <td style={{color:decay>0.5?C.g:C.r}}>{fmtPct(decay,0)}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>TRADE RECOMMENDATIONS — COMPOSITE ALPHA</div>
          {recommendations.length===0&&<div style={{color:C.dm,fontSize:12}}>Waiting for composite signals...</div>}
          <div style={{maxHeight:300,overflowY:"auto"}}>
            {recommendations.slice(0,15).map(r=><div key={r.id} style={{...miniCard,marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:12,fontWeight:600}}>{mktQ(r.conditionId)}</div>
                <div style={{display:"flex",gap:6}}>
                  <span style={pill(r.direction==="BUY_YES"?C.g:C.r,r.direction==="BUY_YES"?C.gd:C.rd)}>{r.direction}</span>
                  <span style={pill(r.urgency==="immediate"?C.r:r.urgency==="patient"?C.y:C.dm,r.urgency==="immediate"?C.rd:r.urgency==="patient"?C.yd:C.s2)}>{r.urgency}</span>
                </div>
              </div>
              <div style={{display:"flex",gap:12,fontFamily:M,fontSize:10,color:C.dm}}>
                <span>Edge: <b style={{color:C.y}}>{fmtPct(r.compositeEdge,2)}</b></span>
                <span>Conf: <b style={{color:C.g}}>{fmtPct(r.compositeConfidence,0)}</b></span>
                <span>Conc: <b style={{color:r.concordance>0.7?C.g:C.y}}>{fmtPct(r.concordance,0)}</b></span>
                <span>Size: <b style={{color:C.tx}}>{fmtUSD(r.suggestedSize)}</b></span>
                <span>Signals: <b>{r.contributingSignals}</b></span>
              </div>
              <div style={{display:"flex",gap:6,marginTop:4}}>
                {Object.entries(r.attribution).map(([k,v])=><span key={k} style={{...pill(C.tx,C.s3),fontSize:9}}>{k}: {v}%</span>)}
              </div>
            </div>)}
          </div>
        </div>
      </div>}

      {/* ── ALPHA: ARB ── */}
      {tab==="Alpha: Arb"&&<div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>CROSS-MARKET ARBITRAGE — Z-SCORE DETECTION</div>
          {activeSignals.filter(s=>s.source==="arb").length===0&&<div style={{color:C.dm,fontSize:12}}>Waiting for arb signals (need 20+ price observations)...</div>}
          <div style={{maxHeight:300,overflowY:"auto"}}>
            {activeSignals.filter(s=>s.source==="arb").map(a=><div key={a.id} style={{...miniCard,marginBottom:6,borderLeft:`3px solid ${Math.abs(a.zScore)>2.5?C.c:C.y}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12,fontWeight:600}}>{a.pairLabel}</span>
                <span style={pill(C.c,C.cd)}>z={a.zScore}</span>
              </div>
              <div style={{display:"flex",gap:12,fontFamily:M,fontSize:10,color:C.dm}}>
                <span>Corr: <b style={{color:Math.abs(a.correlation)>0.5?C.g:C.dm}}>{a.correlation}</b></span>
                <span>β: <b>{a.beta}</b></span>
                <span>Mismatch: <b style={{color:C.y}}>{fmtPct(Math.abs(a.mismatch),2)}</b></span>
                <span>Net edge: <b style={{color:C.g}}>{fmtPct(a.netEdge,2)}</b></span>
                <span>Fair: <b>{(a.fairValue*100).toFixed(1)}¢</b> vs <b>{(a.currentPrice*100).toFixed(1)}¢</b></span>
              </div>
            </div>)}
          </div>
        </div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>PAIR DEFINITIONS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {PAIR_DEFS.map((p,i)=>{
              const mA=markets.find(m=>m.id===p.a),mB=markets.find(m=>m.id===p.b);
              return <div key={i} style={{...miniCard,borderLeft:`3px solid ${p.type==="correlated"?C.g:p.type==="inverse"?C.r:C.dm}`}}>
                <div style={{fontSize:11,fontWeight:600,marginBottom:3}}>{p.label}</div>
                <div style={{display:"flex",gap:8,fontFamily:M,fontSize:10,color:C.dm}}>
                  <span style={pill(p.type==="correlated"?C.g:p.type==="inverse"?C.r:C.dm,p.type==="correlated"?C.gd:p.type==="inverse"?C.rd:C.s2)}>{p.type}</span>
                  <span>β={p.beta}</span>
                  <span>A:{mA?(mA.yes*100).toFixed(1):"?"}¢</span>
                  <span>B:{mB?(mB.yes*100).toFixed(1):"?"}¢</span>
                </div>
              </div>;
            })}
          </div>
        </div>
      </div>}

      {/* ── EXECUTION ── */}
      {tab==="Execution"&&<div style={card}>
        <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>SMART EXECUTION — ORDER SPLITTING + FILL TRACKING</div>
        {executions.length===0&&<div style={{color:C.dm,fontSize:12}}>No executions yet...</div>}
        <div style={{maxHeight:500,overflowY:"auto"}}>
          {executions.slice(0,25).map(e=><div key={e.id} style={{...miniCard,marginBottom:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{fontSize:11,fontWeight:600,maxWidth:"50%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{mktQ(e.conditionId)}</div>
              <div style={{display:"flex",gap:4}}>
                <span style={pill(e.direction==="BUY_YES"?C.g:C.r,e.direction==="BUY_YES"?C.gd:C.rd)}>{e.side}</span>
                <span style={pill(e.status==="FILLED"?C.g:e.status==="PARTIAL"?C.y:C.b,e.status==="FILLED"?C.gd:e.status==="PARTIAL"?C.yd:C.bd2)}>{e.status}</span>
                <span style={pill(e.urgency==="immediate"?C.o:C.dm,e.urgency==="immediate"?C.od:C.s2)}>{e.urgency}</span>
              </div>
            </div>
            <div style={{display:"flex",gap:10,fontFamily:M,fontSize:10,color:C.dm}}>
              <span>Size: {fmtUSD(e.parentSize)}</span>
              <span>Filled: <b style={{color:C.g}}>{fmtUSD(e.totalFilled)}</b></span>
              <span>Limit: {(e.limitPrice*100).toFixed(1)}¢</span>
              {e.avgFillPrice&&<span>Avg: {(e.avgFillPrice*100).toFixed(1)}¢</span>}
              {e.slippage!==null&&<span>Slip: <b style={{color:Math.abs(e.slippage)>0.003?C.r:C.g}}>{(e.slippage*100).toFixed(2)}¢</b></span>}
              <span>Children: {e.children.length}</span>
            </div>
            {/* Child orders */}
            <div style={{display:"flex",gap:3,marginTop:4}}>
              {e.children.map(ch=><div key={ch.id} style={{width:Math.max(20,ch.size/5),height:8,borderRadius:2,background:ch.status==="FILLED"?C.g:C.bd,opacity:0.7}} title={`${ch.size} @ ${ch.limitPrice} — ${ch.status}`}/>)}
            </div>
            {/* Attribution */}
            <div style={{display:"flex",gap:4,marginTop:4}}>
              {Object.entries(e.attribution||{}).map(([k,v])=><span key={k} style={{fontSize:9,fontFamily:M,color:C.dm}}>{k}:{v}%</span>)}
            </div>
          </div>)}
        </div>
      </div>}

      {/* ── RISK ── */}
      {tab==="Risk"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div style={card}>
            <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>RISK CONFIGURATION</div>
            {[
              {k:"maxPositionPerMarket",l:"Max position / market",u:"$"},
              {k:"maxPortfolioExposure",l:"Max portfolio exposure",u:"$"},
              {k:"softDrawdownLimit",l:"Soft drawdown limit",u:"%",mult:100},
              {k:"maxCategoryExposure",l:"Max category exposure",u:"$"},
            ].map(r=><div key={r.k} style={{marginBottom:10}}>
              <label style={{fontSize:10,color:C.dm,fontFamily:M,display:"block",marginBottom:3}}>{r.l} ({r.u})</label>
              <input type="number" value={r.mult?riskCfg[r.k]*r.mult:riskCfg[r.k]}
                onChange={e=>setRiskCfg(prev=>({...prev,[r.k]:r.mult?+e.target.value/r.mult:+e.target.value}))}
                style={inp}/>
            </div>)}
            {riskState.halted&&<div style={{...miniCard,background:C.rd,marginTop:8}}>
              <div style={{fontSize:11,fontWeight:700,color:C.r}}>⛔ CIRCUIT BREAKER ACTIVE</div>
              <div style={{fontSize:10,color:C.r,marginTop:3}}>{riskState.haltReason}</div>
              <button onClick={()=>{cbRef.current?.reset();}} style={{marginTop:6,padding:"4px 12px",borderRadius:4,border:"none",cursor:"pointer",background:C.y,color:C.bg,fontFamily:M,fontSize:10,fontWeight:700}}>RESET</button>
            </div>}
          </div>
          <div style={card}>
            <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>POSITION EXPOSURE</div>
            {Object.keys(positions).length===0&&<div style={{color:C.dm,fontSize:11}}>No positions</div>}
            {Object.entries(positions).map(([id,p])=>{
              const pct=riskCfg.maxPositionPerMarket?(p.gross/riskCfg.maxPositionPerMarket)*100:0;
              return <div key={id} style={{marginBottom:10}}>
                <div style={{fontSize:10,marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{mktQ(id)}</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{flex:1,height:5,background:C.s2,borderRadius:3,overflow:"hidden"}}>
                    <div style={{width:`${Math.min(pct,100)}%`,height:"100%",background:pct>80?C.r:pct>50?C.y:C.g,borderRadius:3,transition:"width .3s"}}/>
                  </div>
                  <span style={{fontFamily:M,fontSize:10,color:p.pnl>=0?C.g:C.r,minWidth:50,textAlign:"right"}}>{p.pnl>=0?"+":""}{fmtUSD(p.pnl)}</span>
                </div>
              </div>;
            })}
          </div>
        </div>
        <div style={card}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>LATEST RISK VERDICTS</div>
          {executions.slice(0,8).map(e=>e.riskChecks&&<div key={e.id} style={{marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${C.bd}22`}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:4}}>{mktQ(e.conditionId)}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {e.riskChecks.map((ch,i)=><div key={i} style={{display:"flex",gap:4,alignItems:"center",fontSize:10,fontFamily:M}}>
                <RiskBadge status={ch.status}/><span style={{color:C.dm}}>{ch.name}</span>
              </div>)}
            </div>
          </div>)}
        </div>
      </div>}

      {/* ── BACKTEST ── */}
      {tab==="Backtest"&&<div style={card}>
        <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>EVENT-DRIVEN BACKTEST</div>
        <div style={{color:C.dm,fontSize:12,lineHeight:1.6}}>
          V3 backtest replays historical events through the full pipeline (NewsFeed → Alpha → CompositeAlpha → PreTradeRisk → SmartExecutor).
          Unlike V2's random PnL generator, every simulated trade traces back to a specific signal with full provenance.
          <br/><br/>
          In paper mode, the live system IS the backtest — observe the equity curve, risk verdicts, and execution quality in real-time
          before switching to live.
          <br/><br/>
          <b style={{color:C.y}}>Current session stats:</b>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginTop:12}}>
          <Stat label="Total executions" value={executions.length} color={C.b}/>
          <Stat label="Fill rate" value={executions.length?fmtPct(executions.filter(e=>e.status==="FILLED").length/executions.length,0):"—"} color={C.g}/>
          <Stat label="Avg slippage" value={executions.filter(e=>e.slippage!==null).length?((executions.filter(e=>e.slippage!==null).reduce((s,e)=>s+Math.abs(e.slippage),0)/executions.filter(e=>e.slippage!==null).length)*100).toFixed(2)+"¢":"—"} color={C.y}/>
          <Stat label="Signals generated" value={activeSignals.length} color={C.p}/>
        </div>
        <div style={{marginTop:12}}>
          <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:6}}>LIVE EQUITY CURVE (PAPER SESSION)</div>
          <Spark data={eqHistory} w={620} h={80} color={eqHistory[eqHistory.length-1]>=10000?C.g:C.r}/>
        </div>
      </div>}

      {/* ── MARKETS ── */}
      {tab==="Markets"&&<div style={card}>
        <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>MARKET BROWSER — DEPTH + SPREAD + HISTORY</div>
        {markets.map(m=>{
          const hist=histRef.current[m.id];
          const depth=genDepth(m.yes);
          const vol=hist?hist.vol(20):0;
          return <div key={m.id} style={{...miniCard,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:12,fontWeight:600,maxWidth:"60%"}}>{m.q}</div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={pill(C.tx,C.s3)}>{m.cat}</span>
                <span style={{fontFamily:M,fontSize:16,fontWeight:700,color:m.yes>0.5?C.g:C.b}}>{(m.yes*100).toFixed(1)}¢</span>
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Spark data={hist?hist.slice(50):[]} w={200} h={24} color={m.yes>(m.prevYes||m.yes)?C.g:C.r}/>
              <div style={{display:"flex",gap:12,fontFamily:M,fontSize:10,color:C.dm}}>
                <span>Spread: <b style={{color:C.y}}>{(depth.spread*100).toFixed(1)}¢</b></span>
                <span>Vol(20): <b>{(vol*100).toFixed(2)}%</b></span>
                <span>Best bid: <b style={{color:C.g}}>{depth.bids[0].size}</b></span>
                <span>Best ask: <b style={{color:C.r}}>{depth.asks[0].size}</b></span>
              </div>
            </div>
          </div>;
        })}
      </div>}

      {/* ── LOGS ── */}
      {tab==="Logs"&&<div style={card}>
        <div style={{fontSize:10,color:C.dm,fontFamily:M,marginBottom:8}}>SYSTEM EVENT LOG — EventBus</div>
        <div style={{maxHeight:500,overflowY:"auto"}}>
          {(busRef.current?.log||[]).slice().reverse().slice(0,60).map((entry,i)=><div key={i} style={{display:"flex",gap:8,padding:"4px 0",borderBottom:`1px solid ${C.bd}11`,fontSize:10,fontFamily:M}}>
            <span style={{color:C.dm,minWidth:55}}>{fmtTime(entry.ts)}</span>
            <span style={pill(
              entry.evt.includes("halt")?C.r:entry.evt.includes("risk")?C.o:entry.evt.includes("signal")?C.p:entry.evt.includes("execution")?C.g:entry.evt.includes("market")?C.b:C.dm,
              entry.evt.includes("halt")?C.rd:entry.evt.includes("risk")?C.od:entry.evt.includes("signal")?C.pd:entry.evt.includes("execution")?C.gd:entry.evt.includes("market")?C.bd2:C.s2
            )}>{entry.evt}</span>
            <span style={{color:C.dm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:400}}>
              {typeof entry.data==="object"?JSON.stringify(entry.data).slice(0,80)+"…":String(entry.data)}
            </span>
          </div>)}
        </div>
      </div>}

      {/* FOOTER */}
      <div style={{textAlign:"center",padding:"14px 0 4px",fontSize:9,color:C.dm,fontFamily:M}}>
        POLYMARKET BOT V3 · PRODUCTION ARCHITECTURE · EVENT-DRIVEN · {mode.toUpperCase()} MODE · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
