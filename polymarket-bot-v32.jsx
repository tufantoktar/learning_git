import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
//  POLYMARKET BOT V3.2 — FULL PRODUCTION UPGRADE
//  New: Regime · MetaAlpha · AdvSlippage · ExecRouter · PortfolioRisk
//  Upgraded: CircuitBreaker(3-state) · PreTradeRisk(10) · SignalProcessor
// ═══════════════════════════════════════════════════════════════

const F="'JetBrains Mono','Fira Code',monospace",S="'DM Sans','Segoe UI',sans-serif";
const C={bg:"#060610",s1:"#0c0c18",s2:"#131322",s3:"#1a1a2e",bd:"#24243a",tx:"#e2e2f0",dm:"#5a5a7c",g:"#00e89a",gd:"#00e89a20",r:"#ff3355",rd:"#ff335520",y:"#ffb830",yd:"#ffb83020",b:"#2d8cf0",b2:"#2d8cf020",p:"#9966ff",pd:"#9966ff20",c:"#00ccee",cd:"#00ccee20",o:"#ff8844",od:"#ff884420"};
const px=(c,bg)=>({display:"inline-block",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:F,color:c,background:bg,fontWeight:600});
const crd={background:C.s1,border:`1px solid ${C.bd}`,borderRadius:8,padding:12,marginBottom:8};
const mc={background:C.s2,borderRadius:6,padding:"7px 10px"};
const uid=()=>Math.random().toString(36).slice(2,8);
const cl=(v,a,b)=>Math.max(a,Math.min(b,v));
const ft=t=>new Date(t).toLocaleTimeString("en",{hour12:false});
const fp=(v,d=1)=>(v*100).toFixed(d)+"%";
const fd=(v,d=0)=>"$"+Math.abs(v).toLocaleString(undefined,{maximumFractionDigits:d});
const mq=id=>MKTS.find(m=>m.id===id)?.q||id;

// ═══════════════════════════════════════════════════════════════
//  [NEW] EVENT SYSTEM — Typed topics
// ═══════════════════════════════════════════════════════════════
class EventBus{
  constructor(){this.subs={};this.log=[];this.m={emitted:0,errors:0};}
  on(e,fn){(this.subs[e]||(this.subs[e]=[])).push(fn);}
  emit(e,d){this.m.emitted++;const ts=Date.now();
    this.log.push({evt:e,ts,s:typeof d==="object"?JSON.stringify(d).slice(0,100):String(d)});
    if(this.log.length>300)this.log=this.log.slice(-200);
    (this.subs[e]||[]).forEach(fn=>{try{fn(d,ts)}catch(err){this.m.errors++;this.log.push({evt:"error",ts:Date.now(),s:`[${e}] ${err.message}`})}});
  }
}

// ═══════════════════════════════════════════════════════════════
//  [UPGRADED] CIRCUIT BREAKER — 3 states: Closed/Open/HalfOpen
// ═══════════════════════════════════════════════════════════════
class CB3{
  constructor(cfg){this.cfg=cfg;this.state="closed";this.reason=null;this.failCount=0;this.lastFail=0;this.hoCount=0;this.triggers=[];}
  get isOpen(){
    if(this.state==="open"&&Date.now()-this.lastFail>this.cfg.recoveryMs){this.state="half_open";this.hoCount=0;}
    return this.state==="open";
  }
  recordSuccess(){
    if(this.state==="half_open"){this.hoCount++;if(this.hoCount>=this.cfg.hoMax){this.state="closed";this.failCount=0;this.reason=null;}}
    else if(this.state==="closed")this.failCount=Math.max(0,this.failCount-1);
  }
  recordFailure(){this.failCount++;this.lastFail=Date.now();if(this.failCount>=this.cfg.threshold){this.trip(`Failure count ${this.failCount} >= ${this.cfg.threshold}`);}}
  checkRisk(rs){
    if(rs.currentDrawdown>this.cfg.maxDD)return this.trip(`DD ${fp(rs.currentDrawdown)} > ${fp(this.cfg.maxDD)}`);
    if(rs.grossExposure>this.cfg.maxExp)return this.trip(`Exposure ${fd(rs.grossExposure)} > ${fd(this.cfg.maxExp)}`);
    return !this.isOpen;
  }
  trip(reason){this.state="open";this.reason=reason;this.triggers.push({t:Date.now(),r:reason});return false;}
  reset(){this.state="closed";this.failCount=0;this.reason=null;}
}

// ═══════════════════════════════════════════════════════════════
//  SYSTEM MONITOR (with slippage accuracy tracking)
// ═══════════════════════════════════════════════════════════════
class SysMon{
  constructor(){this.lat=[];this.fills=[];this.sc={nlp:0,momentum:0,arb:0};this.rej=0;this.app=0;this.slipHist=[];}
  recLat(ms){this.lat.push(ms);if(this.lat.length>100)this.lat.shift();}
  recFill(f,t){this.fills.push(t>0?f/t:0);if(this.fills.length>50)this.fills.shift();}
  recSlip(est,act){this.slipHist.push({est,act});if(this.slipHist.length>200)this.slipHist.shift();}
  avgLat(){return this.lat.length?this.lat.reduce((a,b)=>a+b,0)/this.lat.length:0;}
  avgFill(){return this.fills.length?this.fills.reduce((a,b)=>a+b,0)/this.fills.length:0;}
  slipAccuracy(){
    if(this.slipHist.length<5)return{n:this.slipHist.length,mae:null,bias:null};
    const errs=this.slipHist.map(s=>s.act-s.est);
    const mae=errs.reduce((a,b)=>a+Math.abs(b),0)/errs.length;
    const bias=errs.reduce((a,b)=>a+b,0)/errs.length;
    return{n:this.slipHist.length,mae:+mae.toFixed(4),bias:+bias.toFixed(4)};
  }
}

// ═══════════════════════════════════════════════════════════════
//  MARKET DATA
// ═══════════════════════════════════════════════════════════════
const MKTS=[
  {id:"btc150k",q:"Will BTC hit $150k by Dec 2026?",yes:0.42,vol:0.02,cat:"crypto",adv:12000},
  {id:"recession",q:"US recession in 2026?",yes:0.28,vol:0.015,cat:"macro",adv:8500},
  {id:"trump28",q:"Trump wins 2028 GOP primary?",yes:0.61,vol:0.01,cat:"politics",adv:22000},
  {id:"fedcut",q:"Fed cuts rates by July 2026?",yes:0.55,vol:0.018,cat:"macro",adv:15000},
  {id:"aibar",q:"AI model passes bar exam top 1%?",yes:0.73,vol:0.012,cat:"tech",adv:5000},
  {id:"starship",q:"SpaceX Starship orbital?",yes:0.67,vol:0.008,cat:"tech",adv:7000},
  {id:"ethflip",q:"ETH flips BTC market cap?",yes:0.08,vol:0.025,cat:"crypto",adv:2000},
  {id:"ceasefire",q:"Ukraine ceasefire by 2026?",yes:0.34,vol:0.014,cat:"geopolitics",adv:9500},
];
const PAIRS=[
  {a:"btc150k",b:"ethflip",type:"inverse",label:"BTC ↔ ETH flip"},
  {a:"recession",b:"fedcut",type:"correlated",label:"Recession ↔ Fed cuts"},
  {a:"btc150k",b:"fedcut",type:"correlated",label:"BTC ↔ Fed cuts"},
  {a:"recession",b:"btc150k",type:"inverse",label:"Recession ↔ BTC"},
  {a:"trump28",b:"ceasefire",type:"weak",label:"Trump ↔ Ceasefire"},
];
const SRC_W={Reuters:1.0,Bloomberg:0.95,AP:0.9,Polymarket:0.7,"X/Twitter":0.5};

function advP(m){
  const mr=0.002*(0.5-m.yes),n=(Math.random()-0.5)*2*m.vol;
  const shock=Math.random()<0.005?(Math.random()-0.5)*0.08:0;
  const adv=Math.max(500,m.adv+(Math.random()-0.5)*200);
  return{...m,yes:+cl(m.yes+mr+n+shock,0.02,0.98).toFixed(4),prevYes:m.yes,adv:Math.floor(adv)};
}
function buildBook(mid,adv){
  const lf=cl(adv/20000,0.3,2);const bs=0.015/lf;
  const bids=[],asks=[];
  for(let i=1;i<=5;i++){const sz=Math.floor((80+Math.random()*300)*lf);bids.push({p:+cl(mid-bs*i/2,0.01,0.99).toFixed(3),sz});asks.push({p:+cl(mid+bs*i/2,0.01,0.99).toFixed(3),sz});}
  const spread=+(asks[0].p-bids[0].p).toFixed(4);
  return{bids,asks,spread,mid,bidDepth:bids.reduce((s,b)=>s+b.sz,0),askDepth:asks.reduce((s,a)=>s+a.sz,0),adv};
}

// ═══════════════════════════════════════════════════════════════
//  PRICE HISTORY
// ═══════════════════════════════════════════════════════════════
class PH{
  constructor(sz=300){this.b=[];this.sz=sz;this.spreads=[];this.depths=[];}
  push(p,t,sp,dp){this.b.push({p,t});if(this.b.length>this.sz)this.b.shift();if(sp!=null){this.spreads.push(sp);if(this.spreads.length>this.sz)this.spreads.shift();}if(dp!=null){this.depths.push(dp);if(this.depths.length>this.sz)this.depths.shift();}}
  get len(){return this.b.length;}
  prices(n){return this.b.slice(-n).map(x=>x.p);}
  roc(n){if(this.b.length<n+1)return 0;const o=this.b[this.b.length-n-1].p,c=this.b[this.b.length-1].p;return o?((c-o)/o):0;}
  sma(n){const s=this.prices(n);return s.length?s.reduce((a,b)=>a+b,0)/s.length:0;}
  std(n){const s=this.prices(n);if(s.length<2)return 0;const m=s.reduce((a,b)=>a+b,0)/s.length;return Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/(s.length-1));}
  vol(n){const s=this.prices(n);if(s.length<3)return 0;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/(s[i-1]||1)));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(r.length-1));}
}

// ═══════════════════════════════════════════════════════════════
//  [NEW] REGIME DETECTOR — Hurst exponent + EWMA vol + Liq score
// ═══════════════════════════════════════════════════════════════
function detectRegime(hist){
  const prices=hist.prices(100);
  if(prices.length<30)return{trend:"neutral",vol:"low_vol",liq:"high_liq",confidence:0};

  // Hurst exponent (rescaled range)
  const returns=[];for(let i=1;i<prices.length;i++)returns.push(Math.log(prices[i]/(prices[i-1]||1)));
  const meanR=returns.reduce((a,b)=>a+b,0)/returns.length;
  const deviate=[];let cum=0;for(const r of returns){cum+=r-meanR;deviate.push(cum);}
  const R=Math.max(...deviate)-Math.min(...deviate);
  const stdR=Math.sqrt(returns.reduce((a,b)=>a+(b-meanR)**2,0)/(returns.length-1))||0.001;
  const hurst=Math.log((R/stdR)+0.001)/Math.log(returns.length);

  const trend=hurst>0.55?"trending":hurst<0.45?"mean_reverting":"neutral";

  // EWMA vol ratio (fast vs slow)
  const ewmaStd=(arr,span)=>{const a=2/(span+1);let w=0,wm=0,wv=0;for(let i=arr.length-1;i>=0;i--){const wi=Math.pow(1-a,arr.length-1-i);w+=wi;wm+=wi*arr[i];}wm/=w;for(let i=arr.length-1;i>=0;i--){const wi=Math.pow(1-a,arr.length-1-i);wv+=wi*(arr[i]-wm)**2;}return Math.sqrt(wv/w);};
  const fastVol=returns.length>=20?ewmaStd(returns,20):0;
  const slowVol=returns.length>=80?ewmaStd(returns,80):fastVol||0.001;
  const volRegime=(fastVol/(slowVol||0.001))>1.3?"high_vol":"low_vol";

  // Liquidity regime
  const sp=hist.spreads.slice(-20);const dp=hist.depths.slice(-20);
  const avgSp=sp.length?sp.reduce((a,b)=>a+b,0)/sp.length:0.05;
  const avgDp=dp.length?dp.reduce((a,b)=>a+b,0)/dp.length:1;
  const liqScore=avgDp/(avgSp+0.001);
  const liqRegime=liqScore>500?"high_liq":"low_liq";

  const confidence=+cl(prices.length/100,0,1).toFixed(2);
  return{trend,vol:volRegime,liq:liqRegime,confidence,hurst:+hurst.toFixed(3),fastVol:+fastVol.toFixed(5),slowVol:+slowVol.toFixed(5),liqScore:+liqScore.toFixed(1)};
}

// ═══════════════════════════════════════════════════════════════
//  [NEW] META-ALPHA — Dynamic weighting by regime + performance
// ═══════════════════════════════════════════════════════════════
class MetaAlpha{
  constructor(){this.perf={nlp:[],momentum:[],arb:[]};this.newsIntensity=0;}
  recordPnl(src,pnl){const b=this.perf[src];if(b){b.push(pnl);if(b.length>50)b.shift();}}
  setNewsIntensity(v){this.newsIntensity=v;}
  computeWeights(regime){
    // Base weights per trend regime
    const bases={trending:{nlp:0.3,momentum:0.5,arb:0.2},mean_reverting:{nlp:0.2,momentum:0.2,arb:0.6},neutral:{nlp:0.4,momentum:0.3,arb:0.3}};
    const base=bases[regime.trend]||bases.neutral;
    let w=[base.nlp,base.momentum,base.arb];
    // Performance scaling (Sharpe-based)
    ["nlp","momentum","arb"].forEach((src,i)=>{
      const p=this.perf[src];
      if(p.length>=10){const m=p.reduce((a,b)=>a+b,0)/p.length;const s=Math.sqrt(p.reduce((a,b)=>a+(b-m)**2,0)/(p.length-1))||0.001;const sh=m/s;w[i]*=Math.max(0.1,1+0.3*sh);}
    });
    // News intensity boost NLP
    if(this.newsIntensity>0.7)w[0]*=1.5;
    // High vol → boost momentum
    if(regime.vol==="high_vol")w[1]*=1.3;
    // Low liq → penalize arb
    if(regime.liq==="low_liq")w[2]*=0.5;
    // Normalize
    const total=w[0]+w[1]+w[2];
    return{nlp:+(w[0]/total).toFixed(3),momentum:+(w[1]/total).toFixed(3),arb:+(w[2]/total).toFixed(3)};
  }
}

// ═══════════════════════════════════════════════════════════════
//  [NEW] STALENESS GUARD — vol-adaptive thresholds
// ═══════════════════════════════════════════════════════════════
function checkStaleness(dataTs,mktVol,baseThreshMs=5000,volScale=2.0){
  const threshMs=baseThreshMs*(1+volScale*(mktVol||0));
  const ageMs=Date.now()-dataTs;
  return{fresh:ageMs<=threshMs,ageMs:Math.floor(ageMs),threshMs:Math.floor(threshMs)};
}

// ═══════════════════════════════════════════════════════════════
//  [NEW] ADVANCED SLIPPAGE MODEL — sqrt impact + online learning
// ═══════════════════════════════════════════════════════════════
class AdvSlippage{
  constructor(){this.alpha=0.1;this.lr=0.01;this.hist=[];}
  estimate(qty,bid,ask,mid,adv,vol,touchDepth){
    const halfSpread=(ask-bid)/2;const spreadBps=(halfSpread/mid)*10000;
    const participation=qty/(adv+0.0001);
    const impactBps=this.alpha*Math.sqrt(participation)*vol*10000;
    let adjImpact=impactBps;
    if(touchDepth>0){const dr=qty/touchDepth;if(dr>1)adjImpact*=(1+0.5*Math.log(dr));}
    const volBps=vol*10000*0.1;
    const totalBps=spreadBps+adjImpact;
    return{totalBps:+totalBps.toFixed(2),spreadBps:+spreadBps.toFixed(2),impactBps:+adjImpact.toFixed(2),volBps:+volBps.toFixed(2),confLow:+(totalBps*0.5).toFixed(2),confHigh:+(totalBps+volBps*2).toFixed(2),fillProb:+cl(1-totalBps/500,0.1,0.98).toFixed(3)};
  }
  recordActual(estBps,actBps){
    this.hist.push({est:estBps,act:actBps});if(this.hist.length>500)this.hist.shift();
    const err=actBps-estBps;this.alpha+=this.lr*err*0.01;this.alpha=cl(this.alpha,0.01,1.0);
  }
}

// ═══════════════════════════════════════════════════════════════
//  [NEW] EXECUTION ROUTER — 6 strategies based on regime+size
// ═══════════════════════════════════════════════════════════════
function selectExecStrategy(orderSize,urgency,regime,adv){
  const part=orderSize/(adv+0.001);
  // Small + urgent → aggressive
  if(orderSize<500&&urgency>0.7)return{strategy:"aggressive",slices:1,intervalMs:0,maxPov:1.0};
  // Large in low liq → TWAP
  if(orderSize>2000&&regime.liq==="low_liq")return{strategy:"twap",slices:Math.max(3,Math.floor(part*20)),intervalMs:15000,maxPov:0.15};
  // High vol → POV
  if(regime.vol==="high_vol")return{strategy:"pov",slices:0,intervalMs:5000,maxPov:0.10};
  // Medium → VWAP
  if(orderSize>500)return{strategy:"vwap",slices:Math.max(2,Math.floor(part*10)),intervalMs:10000,maxPov:0.15};
  // Default → patient
  return{strategy:"patient",slices:1,intervalMs:0,maxPov:1.0};
}

// ═══════════════════════════════════════════════════════════════
//  NLP + MOMENTUM + ARB ALPHA (kept from V3.1, minor tweaks)
// ═══════════════════════════════════════════════════════════════
const NEWS_TPL=[
  {t:"Federal Reserve signals policy shift",mkts:["fedcut","recession"],imp:0.7},
  {t:"Bitcoin breaks key technical level",mkts:["btc150k","ethflip"],imp:0.6},
  {t:"New polling data shifts primary outlook",mkts:["trump28"],imp:0.5},
  {t:"SpaceX Starship test window announced",mkts:["starship"],imp:0.4},
  {t:"Treasury yields move on macro data",mkts:["fedcut","recession","btc150k"],imp:0.5},
  {t:"AI lab reports benchmark breakthrough",mkts:["aibar"],imp:0.6},
  {t:"Diplomatic progress on conflict",mkts:["ceasefire"],imp:0.55},
  {t:"Ethereum ecosystem shift underway",mkts:["ethflip","btc150k"],imp:0.45},
];

function genNews(markets){
  const tpl=NEWS_TPL[Math.floor(Math.random()*NEWS_TPL.length)];
  const rel=tpl.mkts.map(id=>markets.find(m=>m.id===id)).filter(Boolean);
  const avgMove=rel.reduce((s,m)=>s+(m.yes-(m.prevYes||m.yes)),0)/(rel.length||1);
  const rawSent=cl(avgMove*20+(Math.random()-0.5)*0.3,-1,1);
  const src=["Reuters","Bloomberg","AP","Polymarket","X/Twitter"][Math.floor(Math.random()*5)];
  const abs=Math.abs(rawSent);
  const ic=abs>0.55?"binary_catalyst":abs>0.2?"gradual_shift":"noise";
  const sw=SRC_W[src]||0.5;
  const latMs=Math.floor(Math.random()*5000);
  const latPen=cl(1-latMs/10000,0.5,1);
  const conf=+cl((0.5+abs*0.4)*sw*latPen,0,0.99).toFixed(3);
  return{id:uid(),time:Date.now(),source:src,headline:tpl.t,relatedMarkets:tpl.mkts,sentiment:+rawSent.toFixed(3),impactClass:ic,confidence:conf,baseImpact:tpl.imp,srcWeight:sw,latencyMs:latMs,latencyPenalty:+latPen.toFixed(3)};
}

function nlpAlpha(news,markets){
  if(news.impactClass!=="binary_catalyst"||news.confidence<0.55)return null;
  const sigs=[];const HL=180000;
  for(const mid of news.relatedMarkets){const mkt=markets.find(m=>m.id===mid);if(!mkt)continue;
    const edge=news.sentiment*news.baseImpact*news.confidence*news.srcWeight*0.04;
    if(Math.abs(edge)<0.006)continue;
    sigs.push({id:uid(),source:"nlp",time:Date.now(),conditionId:mid,direction:edge>0?"BUY_YES":"BUY_NO",edge:+Math.abs(edge).toFixed(4),confidence:news.confidence,fairValue:+cl(mkt.yes+edge,0.02,0.98).toFixed(4),currentPrice:mkt.yes,halfLife:HL,triggerEvent:news.id,expiresAt:Date.now()+HL*4,qualityScore:+(news.confidence*news.srcWeight*news.latencyPenalty).toFixed(3)});}
  return sigs.length?sigs:null;
}

function momentumAlpha(mid,hist,price){
  if(hist.len<25)return null;
  const r5=hist.roc(5),s10=hist.sma(10),s30=hist.sma(30),v=hist.vol(20);
  const trend=((price>s10?0.3:-0.3)+(price>s30?0.2:-0.2)+cl(r5*10,-0.5,0.5));
  const ext=(price-s30)/(v||0.01);const mr=ext>2?-0.4:ext<-2?0.4:0;
  const comp=trend+mr;const ac=Math.abs(comp);
  if(ac<0.15)return null;
  return{id:uid(),source:"momentum",time:Date.now(),conditionId:mid,direction:comp>0?"BUY_YES":"BUY_NO",edge:+(ac*0.05).toFixed(4),confidence:+cl(0.4+ac*0.3,0,0.95).toFixed(3),fairValue:+(price+comp*0.02).toFixed(4),currentPrice:price,halfLife:240000,expiresAt:Date.now()+300000,qualityScore:+(ac*cl(hist.len/100,0,1)).toFixed(3)};
}

function arbAlpha(markets,histories){
  const res=[];
  for(const pair of PAIRS){
    const mA=markets.find(m=>m.id===pair.a),mB=markets.find(m=>m.id===pair.b);
    if(!mA||!mB)continue;const hA=histories[pair.a],hB=histories[pair.b];if(!hA||!hB)continue;
    const pA=hA.prices(50),pB=hB.prices(50);if(pA.length<30||pB.length<30)continue;
    const n=Math.min(pA.length,pB.length);const a=pA.slice(-n),b=pB.slice(-n);
    const ma=a.reduce((s,v)=>s+v,0)/n,mb=b.reduce((s,v)=>s+v,0)/n;
    let cov=0,va=0,vb=0;for(let i=0;i<n;i++){cov+=(a[i]-ma)*(b[i]-mb);va+=(a[i]-ma)**2;vb+=(b[i]-mb)**2;}
    const corr=(va&&vb)?cov/Math.sqrt(va*vb):0;
    // Stability check
    const h=Math.floor(n/2);
    const c1=(()=>{const xa=a.slice(0,h),xb=b.slice(0,h);const hm=xa.length;if(hm<5)return 0;const ma2=xa.reduce((s,v)=>s+v,0)/hm,mb2=xb.reduce((s,v)=>s+v,0)/hm;let c2=0,va2=0,vb2=0;for(let i=0;i<hm;i++){c2+=(xa[i]-ma2)*(xb[i]-mb2);va2+=(xa[i]-ma2)**2;vb2+=(xb[i]-mb2)**2;}return(va2&&vb2)?c2/Math.sqrt(va2*vb2):0;})();
    const c2=(()=>{const xa=a.slice(h),xb=b.slice(h);const hm=xa.length;if(hm<5)return 0;const ma2=xa.reduce((s,v)=>s+v,0)/hm,mb2=xb.reduce((s,v)=>s+v,0)/hm;let c3=0,va2=0,vb2=0;for(let i=0;i<hm;i++){c3+=(xa[i]-ma2)*(xb[i]-mb2);va2+=(xa[i]-ma2)**2;vb2+=(xb[i]-mb2)**2;}return(va2&&vb2)?c3/Math.sqrt(va2*vb2):0;})();
    const stability=1-Math.abs(c1-c2);
    if(stability<0.5||Math.abs(corr)<0.25)continue;
    const corrConf=+(Math.abs(corr)*stability*cl(n/50,0,1)).toFixed(3);
    const stdA=hA.std(30),stdB=hB.std(30);const beta=stdA>0?corr*(stdB/stdA):0;
    const expB=mb+beta*(mA.yes-ma);const mismatch=mB.yes-expB;const msStd=hB.std(30)||0.01;const z=mismatch/msStd;
    if(Math.abs(z)<1.8)continue;
    const bkB=buildBook(mB.yes,mB.adv);if(bkB.spread>0.05)continue;if(bkB.bidDepth<50)continue;
    const netEdge=Math.abs(mismatch)-bkB.spread-0.004;
    if(netEdge<=0)continue;
    res.push({id:uid(),source:"arb",time:Date.now(),conditionId:mB.id,direction:mismatch>0?"BUY_NO":"BUY_YES",edge:+netEdge.toFixed(4),confidence:+cl(0.3+Math.abs(z)*0.12*corrConf,0,0.95).toFixed(3),fairValue:+cl(expB,0.02,0.98).toFixed(4),currentPrice:mB.yes,halfLife:600000,zScore:+z.toFixed(2),correlation:+corr.toFixed(3),corrConf,stability:+stability.toFixed(3),beta:+beta.toFixed(3),pairLabel:pair.label,expiresAt:Date.now()+600000,qualityScore:+(corrConf*cl(Math.abs(z)/3,0,1)).toFixed(3)});
  }
  return res.length?res:null;
}

// ═══════════════════════════════════════════════════════════════
//  [UPGRADED] SIGNAL PROCESSOR — concordance confidence w/ regime
// ═══════════════════════════════════════════════════════════════
function processSignals(rawSigs,metaWeights,regimeConf){
  const now=Date.now();
  // Filter expired + stale
  let sigs=rawSigs.filter(s=>s.expiresAt>now&&(now-s.time)/(s.expiresAt-s.time)<0.8);
  // Exponential decay
  sigs=sigs.map(s=>{const hl=s.halfLife||300000;const fresh=Math.pow(0.5,(now-s.time)/hl);return{...s,freshness:+fresh.toFixed(3),effectiveEdge:+(s.edge*fresh).toFixed(4)};});
  // Dedup (best per source:market)
  const best={};for(const s of sigs){const k=`${s.source}:${s.conditionId}`;if(!best[k]||s.effectiveEdge>best[k].effectiveEdge)best[k]=s;}
  sigs=Object.values(best).filter(s=>(s.qualityScore||0.5)>0.15);
  // Group by market → composite with MetaAlpha weights
  const byMkt={};for(const s of sigs){(byMkt[s.conditionId]||(byMkt[s.conditionId]=[])).push(s);}
  const recs=[];
  for(const [mid,msigs] of Object.entries(byMkt)){
    // Weighted composite using MetaAlpha weights
    let composite=0;
    for(const s of msigs){const w=metaWeights[s.source]||0.33;composite+=s.effectiveEdge*(s.direction==="BUY_YES"?1:-1)*s.confidence*w;}
    // Concordance
    const signs=msigs.map(s=>s.direction==="BUY_YES"?1:-1);
    const concordance=Math.abs(signs.reduce((a,b)=>a+b,0))/signs.length;
    // Confidence = 0.4*concordance + 0.3*alpha_strength + 0.15*source_count + 0.15*regime
    const srcCount=cl(msigs.length/3,0,1);
    const alphaStr=cl(Math.abs(composite)*2,0,1);
    const confidence=+cl(0.4*concordance+0.3*alphaStr+0.15*srcCount+0.15*regimeConf,0,0.95).toFixed(3);
    const dir=composite>=0?"BUY_YES":"BUY_NO";
    const adjEdge=Math.abs(composite)*(0.5+concordance*0.5);
    if(adjEdge<0.006)continue;
    // Half-Kelly with confidence
    const price=msigs[0].currentPrice||0.5;
    const odds=composite>0?price/(1-price+0.0001):(1-price)/(price+0.0001);
    const kellyRaw=(adjEdge*odds-(1-adjEdge))/(odds+0.0001);
    const kelly=cl(kellyRaw*0.5,0,0.25)*confidence;
    const sugSz=Math.floor(kelly*10000);
    if(sugSz<15)continue;
    const attr={};msigs.forEach(s=>{attr[s.source]=(attr[s.source]||0)+s.effectiveEdge*s.confidence;});
    const ta=Object.values(attr).reduce((s,v)=>s+Math.abs(v),0)||1;
    Object.keys(attr).forEach(k=>attr[k]=+((Math.abs(attr[k])/ta)*100).toFixed(1));
    recs.push({id:uid(),time:Date.now(),conditionId:mid,direction:dir,compositeEdge:+adjEdge.toFixed(4),compositeConfidence:confidence,concordance:+concordance.toFixed(2),suggestedSize:sugSz,attribution:attr,signals:msigs.length,urgency:adjEdge>0.025?"immediate":adjEdge>0.012?"patient":"passive",avgQuality:+(msigs.reduce((s,x)=>s+(x.qualityScore||0.5),0)/msigs.length).toFixed(3)});
  }
  return{filtered:sigs,recs};
}

// ═══════════════════════════════════════════════════════════════
//  [UPGRADED] PRE-TRADE RISK — 10 checks per spec
// ═══════════════════════════════════════════════════════════════
function preTradeRisk(rec,positions,cfg,riskState,regime,slipModel,cb){
  const ch=[];let ok=true,sz=rec.suggestedSize;
  const mkt=MKTS.find(m=>m.id===rec.conditionId);

  // 1. Staleness
  const stale=checkStaleness(rec.time,mkt?.vol||0.02);
  ch.push({n:"Staleness",s:stale.fresh?"pass":"blocked",d:`age ${stale.ageMs}ms / ${stale.threshMs}ms`});
  if(!stale.fresh)ok=false;

  // 2. Max position
  const ex=(positions[rec.conditionId]||{gross:0}).gross;
  if(ex+sz>cfg.maxPos){sz=Math.max(0,cfg.maxPos-ex);ch.push({n:"Max pos",s:sz>0?"adjusted":"blocked",d:`${fd(ex+rec.suggestedSize)}>${fd(cfg.maxPos)}`});if(!sz)ok=false;}
  else ch.push({n:"Max pos",s:"pass",d:`${fd(ex+sz)}`});

  // 3. Max exposure
  if(riskState.grossExposure+sz>cfg.maxExp){sz=Math.max(0,cfg.maxExp-riskState.grossExposure);ch.push({n:"Max exp",s:sz>0?"adjusted":"blocked",d:`>${fd(cfg.maxExp)}`});if(!sz)ok=false;}
  else ch.push({n:"Max exp",s:"pass",d:`${fd(riskState.grossExposure+sz)}`});

  // 4. Drawdown — dynamic sizing (convex ramp)
  const ddScale=riskState.currentDrawdown>=cfg.maxDD?0:1-Math.pow(riskState.currentDrawdown/cfg.maxDD,1.5);
  if(ddScale<1){sz=Math.floor(sz*ddScale);ch.push({n:"DD sizing",s:ddScale>0?"adjusted":"blocked",d:`scale=${ddScale.toFixed(2)}`});if(!sz)ok=false;}
  else ch.push({n:"DD sizing",s:"pass",d:`DD ${fp(riskState.currentDrawdown)}`});

  // 5. Slippage cost (bps)
  if(mkt){
    const bk=buildBook(mkt.yes,mkt.adv);
    const slip=slipModel.estimate(sz,bk.bids[0]?.p||mkt.yes-0.01,bk.asks[0]?.p||mkt.yes+0.01,mkt.yes,mkt.adv,mkt.vol,bk.bidDepth);
    if(slip.totalBps>50){ch.push({n:"Slip cost",s:"blocked",d:`${slip.totalBps}bps > 50bps max`});ok=false;}
    else ch.push({n:"Slip cost",s:"pass",d:`${slip.totalBps}bps`});
  }

  // 6. Liquidity ratio (ADV/size)
  const liqRatio=mkt?(mkt.adv/(sz+0.001)):999;
  if(liqRatio<3){ch.push({n:"Liquidity",s:"blocked",d:`ratio ${liqRatio.toFixed(1)}<3`});ok=false;}
  else ch.push({n:"Liquidity",s:"pass",d:`ratio ${liqRatio.toFixed(1)}`});

  // 7. Theme concentration
  const themeExp={};Object.entries(positions).forEach(([id,p])=>{const m=MKTS.find(x=>x.id===id);if(m)themeExp[m.cat]=(themeExp[m.cat]||0)+p.gross;});
  const cat=mkt?.cat||"other";const catExp=(themeExp[cat]||0)+sz;
  if(catExp>cfg.maxCat){sz=Math.max(0,cfg.maxCat-(themeExp[cat]||0));ch.push({n:"Theme",s:sz>0?"adjusted":"blocked",d:`${cat} ${fd(catExp)}>${fd(cfg.maxCat)}`});if(!sz)ok=false;}
  else ch.push({n:"Theme",s:"pass",d:`${cat} ${fd(catExp)}`});

  // 8. Concentration (single market ≤ 30% of book)
  const totalExp=riskState.grossExposure+sz;
  const conc=totalExp>0?(ex+sz)/totalExp:0;
  if(conc>0.30){ch.push({n:"Concentration",s:"adjusted",d:`${fp(conc)}>${fp(0.30)}`});sz=Math.floor(sz*0.7);}
  else ch.push({n:"Concentration",s:"pass",d:fp(conc)});

  // 9. Signal quality
  if((rec.avgQuality||0)<0.2){ch.push({n:"Sig quality",s:"blocked",d:`${rec.avgQuality}<0.2`});ok=false;}
  else ch.push({n:"Sig quality",s:"pass",d:`${rec.avgQuality}`});

  // 10. Circuit breaker
  if(cb.isOpen){ch.push({n:"CB",s:"blocked",d:cb.reason||"OPEN"});ok=false;}
  else ch.push({n:"CB",s:cb.state==="half_open"?"adjusted":"pass",d:cb.state});

  return{approved:ok&&sz>=15,adjustedSize:sz,checks:ch,originalSize:rec.suggestedSize};
}

// ═══════════════════════════════════════════════════════════════
//  SMART EXECUTION (uses ExecRouter + AdvSlippage)
// ═══════════════════════════════════════════════════════════════
function smartExecute(rec,verdict,markets,regime,slipModel,monitor){
  if(!verdict.approved)return null;
  const mkt=markets.find(m=>m.id===rec.conditionId);if(!mkt)return null;
  const sz=verdict.adjustedSize;const side=rec.direction==="BUY_YES"?"YES":"NO";
  const mid=side==="YES"?mkt.yes:1-mkt.yes;
  const bk=buildBook(mkt.yes,mkt.adv);const t0=Date.now();

  // Pre-trade slippage estimate
  const slipEst=slipModel.estimate(sz,bk.bids[0]?.p||mid-0.01,bk.asks[0]?.p||mid+0.01,mid,mkt.adv,mkt.vol,bk.bidDepth);

  // Execution router selects strategy
  const execP=selectExecStrategy(sz,rec.urgency==="immediate"?0.9:rec.urgency==="patient"?0.5:0.2,regime,mkt.adv);
  const spreadAdj=execP.strategy==="aggressive"?bk.spread*0.6:execP.strategy==="patient"?-bk.spread*0.3:0;
  const limit=+cl(mid+spreadAdj,0.01,0.99).toFixed(3);
  const maxChild=execP.strategy==="twap"||execP.strategy==="vwap"?Math.max(50,Math.floor(sz/(execP.slices||3))):execP.strategy==="aggressive"?sz:200;
  const nCh=Math.ceil(sz/maxChild);const children=[];let rem=sz,filled=0,cost=0;
  for(let i=0;i<nCh;i++){
    const chSz=Math.min(rem,maxChild);
    const fr=execP.strategy==="aggressive"?0.92:execP.strategy==="twap"?0.8:execP.strategy==="vwap"?0.78:execP.strategy==="pov"?0.72:execP.strategy==="patient"?0.6:0.35;
    const ok=Math.random()<fr;const fp2=ok?+(limit+(Math.random()-0.5)*bk.spread*0.3).toFixed(3):null;
    children.push({id:uid(),sz:chSz,limit,fp:fp2,status:ok?"FILLED":"OPEN"});
    if(ok){filled+=chSz;cost+=fp2*chSz;}rem-=chSz;
  }
  const avgFP=filled?+(cost/filled).toFixed(4):null;
  const actSlip=avgFP?+Math.abs(avgFP-limit).toFixed(4):null;
  const latMs=Date.now()-t0;

  // Slippage feedback
  if(actSlip!==null){const actBps=(actSlip/mid)*10000;slipModel.recordActual(slipEst.totalBps,actBps);if(monitor)monitor.recSlip(slipEst.totalBps,actBps);}
  if(monitor){monitor.recLat(latMs);monitor.recFill(filled,sz);}

  // Partial fill handling
  let partialAction=null;
  if(filled>0&&filled<sz){
    if(filled/sz<0.5)partialAction={action:"UNWIND",reason:`<50% filled (${filled}/${sz}), unwinding`};
    else partialAction={action:"RETRY",reason:`${filled}/${sz} filled, retrying at ${+(limit+bk.spread*0.3).toFixed(3)}`};
  }

  return{id:uid(),time:Date.now(),conditionId:rec.conditionId,side,direction:rec.direction,parentSize:sz,limit,strategy:execP.strategy,children,totalFilled:filled,avgFP,actualSlip:actSlip,slipEst:slipEst.totalBps,slipFeedback:actSlip!==null?{est:slipEst.totalBps,act:+((actSlip/mid)*10000).toFixed(2),ok:actSlip<=slipEst.totalBps/10000*1.5}:null,status:filled===sz?"FILLED":filled>0?"PARTIAL":"WORKING",urgency:rec.urgency,compositeEdge:rec.compositeEdge,attribution:rec.attribution,riskChecks:verdict.checks,latMs,partialAction,fillRate:+(filled/sz).toFixed(2)};
}

// ═══════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ═══════════════════════════════════════════════════════════════
function Spark({data,color=C.g,w=120,h=24}){if(!data||data.length<2)return null;const mn=Math.min(...data),mx=Math.max(...data),rn=mx-mn||1;return<svg width={w} height={h} style={{display:"block"}}><polyline points={data.map((v,i)=>`${(i/(data.length-1))*w},${h-((v-mn)/rn)*h}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5}/></svg>;}
function St({l,v,c=C.tx,s}){return<div style={mc}><div style={{fontSize:9,color:C.dm,fontFamily:F}}>{l}</div><div style={{fontSize:14,fontWeight:700,fontFamily:F,color:c,marginTop:2}}>{v}</div>{s&&<div style={{fontSize:8,color:C.dm,fontFamily:F,marginTop:1}}>{s}</div>}</div>;}
function RB({s}){const m={pass:{c:C.g,b:C.gd},adjusted:{c:C.y,b:C.yd},reduced:{c:C.y,b:C.yd},blocked:{c:C.r,b:C.rd}};const x=m[s]||m.pass;return<span style={px(x.c,x.b)}>{(s||"").toUpperCase()}</span>;}

const TABS=["Dashboard","Regime","Alpha","Arb","Execution","Risk","Markets","System"];
function TabBar({a,set}){return<div style={{display:"flex",gap:1,borderBottom:`1px solid ${C.bd}`,marginBottom:10,overflowX:"auto"}}>{TABS.map(t=><button key={t} onClick={()=>set(t)} style={{padding:"6px 10px",background:a===t?C.s2:"transparent",color:a===t?C.g:C.dm,border:"none",cursor:"pointer",fontFamily:F,fontSize:10,fontWeight:600,whiteSpace:"nowrap",borderBottom:a===t?`2px solid ${C.g}`:"2px solid transparent",transition:"all .12s"}}>{t}</button>)}</div>;}

// ═══════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════
export default function V32(){
  const[tab,setTab]=useState("Dashboard");
  const[mode,setMode]=useState("paper");
  const[running,setRunning]=useState(false);
  const[markets,setMarkets]=useState(MKTS.map(m=>({...m,prevYes:m.yes})));
  const[news,setNews]=useState([]);
  const[signals,setSignals]=useState([]);
  const[recs,setRecs]=useState([]);
  const[execs,setExecs]=useState([]);
  const[eqH,setEqH]=useState([10000]);
  const[regime,setRegime]=useState({trend:"neutral",vol:"low_vol",liq:"high_liq",confidence:0,hurst:0.5,liqScore:0});
  const[alphaWeights,setAlphaWeights]=useState({nlp:0.33,momentum:0.33,arb:0.33});
  const[cfg]=useState({maxPos:1500,maxExp:6000,maxDD:0.15,maxCat:3000});

  const busR=useRef(null),cbR=useRef(null),histR=useRef({}),monR=useRef(null),metaR=useRef(null),slipR=useRef(null),intR=useRef(null);

  useEffect(()=>{
    busR.current=new EventBus();
    cbR.current=new CB3({maxDD:0.20,maxExp:8000,threshold:5,recoveryMs:60000,hoMax:2});
    monR.current=new SysMon();
    metaR.current=new MetaAlpha();
    slipR.current=new AdvSlippage();
    MKTS.forEach(m=>{histR.current[m.id]=new PH(300);});
  },[]);

  const positions=useMemo(()=>{
    const p={};
    execs.filter(e=>e.totalFilled>0).forEach(e=>{
      if(!p[e.conditionId])p[e.conditionId]={yes:0,no:0,net:0,gross:0,avgPx:0,pnl:0};
      const pos=p[e.conditionId];
      if(e.side==="YES"){pos.yes+=e.totalFilled;pos.avgPx=e.avgFP||0;}
      else{pos.no+=e.totalFilled;pos.avgPx=e.avgFP||0;}
      pos.net=pos.yes-pos.no;pos.gross=pos.yes+pos.no;
    });
    Object.entries(p).forEach(([id,pos])=>{const m=markets.find(x=>x.id===id);if(m)pos.pnl=+(pos.yes*(m.yes-pos.avgPx)+pos.no*((1-m.yes)-pos.avgPx)).toFixed(2);});
    return p;
  },[execs,markets]);

  const riskState=useMemo(()=>{
    const ge=Object.values(positions).reduce((s,p)=>s+p.gross,0);
    const tp=Object.values(positions).reduce((s,p)=>s+p.pnl,0);
    const eq=10000+tp;const pk=Math.max(10000,...eqH);const dd=pk>0?(pk-eq)/pk:0;
    return{grossExposure:ge,totalPnl:+tp.toFixed(2),equity:+eq.toFixed(2),peak:pk,currentDrawdown:+dd.toFixed(4),halted:cbR.current?.isOpen||false,haltReason:cbR.current?.reason};
  },[positions,eqH]);

  const tick=useCallback(()=>{
    const bus=busR.current,cb=cbR.current,mon=monR.current,meta=metaR.current,slip=slipR.current;
    if(!bus||!cb)return;

    // 1. Price advance + history
    setMarkets(prev=>{
      const upd=prev.map(m=>advP(m));
      upd.forEach(m=>{
        const bk=buildBook(m.yes,m.adv);
        histR.current[m.id]?.push(m.yes,Date.now(),bk.spread,bk.bidDepth);
        bus.emit("market:tick",{id:m.id,p:m.yes});
      });
      return upd;
    });

    // 2. Regime detection (global, using first liquid market as proxy)
    const mainHist=histR.current["btc150k"]||histR.current[MKTS[0].id];
    if(mainHist&&mainHist.len>30){
      const r=detectRegime(mainHist);
      setRegime(r);
      // MetaAlpha weights from regime
      if(meta){const w=meta.computeWeights(r);setAlphaWeights(w);bus.emit("regime:update",{...r,weights:w});}
    }

    // 3. News → NLP alpha
    setMarkets(mk=>{
      if(Math.random()<0.3){
        const nev=genNews(mk);setNews(prev=>[nev,...prev].slice(0,60));
        bus.emit("news:event",{id:nev.id,ic:nev.impactClass});
        if(meta)meta.setNewsIntensity(nev.impactClass==="binary_catalyst"?0.9:nev.impactClass==="gradual_shift"?0.5:0.1);
        const nlpSigs=nlpAlpha(nev,mk);
        if(nlpSigs){mon.sc.nlp+=nlpSigs.length;setSignals(prev=>[...nlpSigs,...prev].slice(0,80));}
      }
      return mk;
    });

    // 4. Momentum alpha
    setMarkets(mk=>{mk.forEach(m=>{const h=histR.current[m.id];if(h){const sig=momentumAlpha(m.id,h,m.yes);if(sig){mon.sc.momentum++;setSignals(prev=>{const f=prev.filter(s=>!(s.source==="momentum"&&s.conditionId===m.id));return[sig,...f].slice(0,80);});}}});return mk;});

    // 5. Arb alpha
    if(Math.random()<0.35){
      setMarkets(mk=>{const arbs=arbAlpha(mk,histR.current);if(arbs){mon.sc.arb+=arbs.length;setSignals(prev=>{const f=prev.filter(s=>s.source!=="arb");return[...arbs,...f].slice(0,80);});}return mk;});
    }

    // 6. Signal processing → Risk → Execution pipeline
    setSignals(sigs=>{
      if(!cb.checkRisk(riskState)){bus.emit("system:halt",{reason:cb.reason});return sigs;}
      const{filtered,recs:newRecs}=processSignals(sigs,alphaWeights,regime.confidence);
      if(newRecs.length){
        setRecs(prev=>[...newRecs,...prev].slice(0,40));
        newRecs.forEach(rec=>{
          const verdict=preTradeRisk(rec,positions,cfg,riskState,regime,slip,cb);
          bus.emit("risk:verdict",{id:rec.id,ok:verdict.approved});
          if(verdict.approved)mon.app++;else mon.rej++;
          const exec=smartExecute(rec,verdict,markets,regime,slip,mon);
          if(exec){
            setExecs(prev=>[exec,...prev].slice(0,60));
            bus.emit("exec:report",{id:exec.id,status:exec.status,strat:exec.strategy});
            if(exec.partialAction)bus.emit("exec:partial",{id:exec.id,action:exec.partialAction.action});
            // Record PnL for MetaAlpha performance tracking
            if(exec.totalFilled>0&&exec.attribution&&meta){
              Object.entries(exec.attribution).forEach(([src,pct])=>{meta.recordPnl(src,(Math.random()-0.48)*exec.totalFilled*0.01);});}
            cb.recordSuccess();
          }
        });
      }
      return filtered;
    });

    setEqH(prev=>[...prev,riskState.equity].slice(-200));
  },[markets,positions,cfg,riskState,regime,alphaWeights]);

  useEffect(()=>{if(running){intR.current=setInterval(tick,2000);return()=>clearInterval(intR.current);}else clearInterval(intR.current);},[running,tick]);

  const mon=monR.current;const slipAcc=mon?.slipAccuracy()||{};

  return(
    <div style={{background:C.bg,color:C.tx,minHeight:"100vh",fontFamily:S,padding:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${C.g},${C.c})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:900,color:C.bg,fontFamily:F}}>3.2</div>
          <div><div style={{fontSize:14,fontWeight:700}}>Polymarket V3.2</div>
            <div style={{fontSize:8,color:C.dm,fontFamily:F}}>REGIME·META-ALPHA·ADV-SLIP·EXEC-ROUTER·10-CHECK-RISK</div></div>
        </div>
        <div style={{display:"flex",gap:5,alignItems:"center"}}>
          {riskState.halted&&<span style={px(C.r,C.rd)}>HALTED</span>}
          <span style={px(regime.trend==="trending"?C.g:regime.trend==="mean_reverting"?C.p:C.dm,regime.trend==="trending"?C.gd:regime.trend==="mean_reverting"?C.pd:C.s2)}>{regime.trend}</span>
          <span style={px(cbR.current?.state==="closed"?C.g:cbR.current?.state==="half_open"?C.y:C.r,cbR.current?.state==="closed"?C.gd:cbR.current?.state==="half_open"?C.yd:C.rd)}>CB:{cbR.current?.state||"?"}</span>
          <button onClick={()=>setMode(m=>m==="paper"?"live":"paper")} style={{...px(mode==="paper"?C.y:C.r,mode==="paper"?C.yd:C.rd),cursor:"pointer",border:"none",padding:"3px 8px"}}>{mode.toUpperCase()}</button>
          <button onClick={()=>{setRunning(r=>!r);if(cbR.current?.state==="open")cbR.current.reset();}} style={{padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",background:running?C.r:C.g,color:C.bg,fontFamily:F,fontSize:10,fontWeight:700}}>{running?"STOP":"START"}</button>
        </div>
      </div>
      <TabBar a={tab} set={setTab}/>

      {tab==="Dashboard"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginBottom:8}}>
          <St l="Equity" v={fd(riskState.equity)} c={riskState.equity>=10000?C.g:C.r}/>
          <St l="PnL" v={(riskState.totalPnl>=0?"+":"")+fd(riskState.totalPnl)} c={riskState.totalPnl>=0?C.g:C.r}/>
          <St l="Exposure" v={fd(riskState.grossExposure)} c={riskState.grossExposure>4000?C.y:C.tx} s={`/${fd(cfg.maxExp)}`}/>
          <St l="Drawdown" v={fp(riskState.currentDrawdown)} c={riskState.currentDrawdown>0.1?C.r:riskState.currentDrawdown>0.05?C.y:C.g}/>
          <St l="Fill Rate" v={mon?fp(mon.avgFill()):"—"} c={C.b}/>
          <St l="Signals" v={signals.length} c={C.p} s={`${recs.length} recs`}/>
        </div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>EQUITY CURVE</div><Spark data={eqH} w={650} h={55} color={eqH[eqH.length-1]>=10000?C.g:C.r}/></div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:5}}>MARKETS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
            {markets.map(m=>{const ch=m.yes-(m.prevYes||m.yes);return<div key={m.id} style={{...mc,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:10,maxWidth:"50%"}}>{m.q}</div>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontFamily:F,fontSize:8,color:ch>0?C.g:ch<0?C.r:C.dm}}>{ch>0?"+":""}{(ch*100).toFixed(2)}¢</span>
                <span style={{fontFamily:F,fontSize:12,fontWeight:700,color:m.yes>0.5?C.g:C.b}}>{(m.yes*100).toFixed(1)}¢</span>
              </div></div>;})}
          </div>
        </div>
      </div>}

      {tab==="Regime"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:8}}>
          <St l="Trend regime" v={regime.trend} c={regime.trend==="trending"?C.g:regime.trend==="mean_reverting"?C.p:C.dm}/>
          <St l="Vol regime" v={regime.vol} c={regime.vol==="high_vol"?C.r:C.g}/>
          <St l="Liq regime" v={regime.liq} c={regime.liq==="low_liq"?C.r:C.g}/>
          <St l="Confidence" v={regime.confidence} c={regime.confidence>0.7?C.g:C.y}/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={crd}>
            <div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>REGIME INDICATORS</div>
            {[{l:"Hurst exponent",v:regime.hurst,c:regime.hurst>0.55?C.g:regime.hurst<0.45?C.p:C.dm,d:"H>0.55=trend, H<0.45=MR"},
              {l:"Fast EWMA vol",v:regime.fastVol||"—",c:C.y},{l:"Slow EWMA vol",v:regime.slowVol||"—",c:C.dm},
              {l:"Liquidity score",v:regime.liqScore||"—",c:C.b,d:"spread-adj depth"},
            ].map((r,i)=><div key={i} style={{...mc,marginBottom:4,display:"flex",justifyContent:"space-between"}}>
              <div><div style={{fontSize:9,color:C.dm}}>{r.l}</div>{r.d&&<div style={{fontSize:8,color:C.dm}}>{r.d}</div>}</div>
              <div style={{fontFamily:F,fontSize:14,fontWeight:700,color:r.c}}>{r.v}</div>
            </div>)}
          </div>
          <div style={crd}>
            <div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>META-ALPHA WEIGHTS (regime-adaptive)</div>
            {Object.entries(alphaWeights).map(([k,v])=><div key={k} style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
                <span>{k}</span><span style={{fontFamily:F,fontWeight:700,color:v>0.4?C.g:C.dm}}>{fp(v,0)}</span>
              </div>
              <div style={{height:5,background:C.s2,borderRadius:3,overflow:"hidden"}}>
                <div style={{width:`${v*100}%`,height:"100%",background:k==="nlp"?C.c:k==="momentum"?C.p:C.b,borderRadius:3}}/>
              </div>
            </div>)}
            <div style={{fontSize:8,color:C.dm,marginTop:8,fontFamily:F}}>
              Weights adapt to: regime type, alpha Sharpe, news intensity, vol level, liquidity
            </div>
          </div>
        </div>
      </div>}

      {tab==="Alpha"&&<div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>NLP NEWS — CATALYST GATE + SOURCE WEIGHTING</div>
          {!news.length&&<div style={{color:C.dm,fontSize:10}}>Start bot...</div>}
          <div style={{maxHeight:200,overflowY:"auto"}}>{news.slice(0,20).map(n=><div key={n.id} style={{display:"flex",gap:5,padding:"4px 0",borderBottom:`1px solid ${C.bd}10`,fontSize:9,alignItems:"center"}}>
            <span style={{fontFamily:F,fontSize:8,color:C.dm,minWidth:44}}>{ft(n.time)}</span>
            <span style={px(C.tx,C.s2)}>{n.source}</span>
            <span style={{flex:1}}>{n.headline}</span>
            <span style={px(n.impactClass==="binary_catalyst"?C.r:n.impactClass==="gradual_shift"?C.y:C.dm,n.impactClass==="binary_catalyst"?C.rd:n.impactClass==="gradual_shift"?C.yd:C.s2)}>{n.impactClass==="binary_catalyst"?"CAT":n.impactClass==="gradual_shift"?"SHIFT":"NOISE"}</span>
            <span style={{fontFamily:F,fontSize:8,color:C.dm}}>{n.latencyMs}ms</span>
          </div>)}</div>
        </div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>FILTERED SIGNALS — QUALITY + FRESHNESS + DEDUP</div>
          <div style={{maxHeight:200,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:F}}>
              <thead><tr style={{color:C.dm,textAlign:"left",borderBottom:`1px solid ${C.bd}`}}><th style={{padding:"3px 4px"}}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FRESH</th><th>QUAL</th></tr></thead>
              <tbody>{signals.slice(0,20).map(s=><tr key={s.id} style={{borderBottom:`1px solid ${C.bd}08`}}>
                <td style={{padding:"3px 4px"}}><span style={px(s.source==="nlp"?C.c:s.source==="momentum"?C.p:C.b,s.source==="nlp"?C.cd:s.source==="momentum"?C.pd:C.b2)}>{s.source}</span></td>
                <td style={{maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{mq(s.conditionId)}</td>
                <td><span style={px(s.direction==="BUY_YES"?C.g:C.r,s.direction==="BUY_YES"?C.gd:C.rd)}>{s.direction==="BUY_YES"?"YES":"NO"}</span></td>
                <td style={{color:C.y}}>{s.effectiveEdge?fp(s.effectiveEdge,2):fp(s.edge,2)}</td>
                <td style={{color:(s.freshness||1)>0.5?C.g:C.r}}>{s.freshness?fp(s.freshness,0):"—"}</td>
                <td style={{color:(s.qualityScore||0)>0.4?C.g:C.y}}>{(s.qualityScore||0).toFixed(2)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>TRADE RECS — COMPOSITE + CONCORDANCE + KELLY</div>
          {recs.slice(0,8).map(r=><div key={r.id} style={{...mc,marginBottom:4}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
              <span style={{fontSize:10,fontWeight:600}}>{mq(r.conditionId)}</span>
              <div style={{display:"flex",gap:3}}>
                <span style={px(r.direction==="BUY_YES"?C.g:C.r,r.direction==="BUY_YES"?C.gd:C.rd)}>{r.direction}</span>
                <span style={px(r.urgency==="immediate"?C.r:r.urgency==="patient"?C.y:C.dm,r.urgency==="immediate"?C.rd:r.urgency==="patient"?C.yd:C.s2)}>{r.urgency}</span>
              </div>
            </div>
            <div style={{display:"flex",gap:6,fontFamily:F,fontSize:8,color:C.dm,flexWrap:"wrap"}}>
              <span>Edge:<b style={{color:C.y}}>{fp(r.compositeEdge,2)}</b></span>
              <span>Conf:<b style={{color:C.g}}>{fp(r.compositeConfidence,0)}</b></span>
              <span>Conc:<b>{r.concordance}</b></span>
              <span>Size:<b style={{color:C.tx}}>{fd(r.suggestedSize)}</b></span>
              {Object.entries(r.attribution).map(([k,v])=><span key={k} style={px(C.tx,C.s3)}>{k}:{v}%</span>)}
            </div>
          </div>)}
        </div>
      </div>}

      {tab==="Arb"&&<div style={crd}>
        <div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>ARB — Z-SCORE + CORR VALIDATION + STABILITY CHECK</div>
        {signals.filter(s=>s.source==="arb").length===0&&<div style={{color:C.dm,fontSize:10}}>Need 30+ observations...</div>}
        {signals.filter(s=>s.source==="arb").map(a=><div key={a.id} style={{...mc,marginBottom:4,borderLeft:`3px solid ${Math.abs(a.zScore)>2.5?C.c:C.y}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
            <span style={{fontSize:10,fontWeight:600}}>{a.pairLabel}</span>
            <span style={px(C.c,C.cd)}>z={a.zScore}</span>
          </div>
          <div style={{display:"flex",gap:6,fontFamily:F,fontSize:8,color:C.dm,flexWrap:"wrap"}}>
            <span>Corr:<b style={{color:Math.abs(a.correlation)>0.5?C.g:C.dm}}>{a.correlation}</b></span>
            <span>Stab:<b style={{color:a.stability>0.7?C.g:C.y}}>{a.stability}</b></span>
            <span>CorrConf:<b>{a.corrConf}</b></span>
            <span>Net edge:<b style={{color:C.g}}>{fp(a.edge,2)}</b></span>
            <span>Fair:<b>{(a.fairValue*100).toFixed(1)}¢</b> vs <b>{(a.currentPrice*100).toFixed(1)}¢</b></span>
          </div>
        </div>)}
      </div>}

      {tab==="Execution"&&<div style={crd}>
        <div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>EXECUTION — 6 STRATEGIES · SQRT SLIPPAGE · PARTIAL FILL</div>
        {!execs.length&&<div style={{color:C.dm,fontSize:10}}>No executions...</div>}
        <div style={{maxHeight:450,overflowY:"auto"}}>
          {execs.slice(0,15).map(e=><div key={e.id} style={{...mc,marginBottom:4}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
              <span style={{fontSize:9,fontWeight:600,maxWidth:"45%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{mq(e.conditionId)}</span>
              <div style={{display:"flex",gap:2}}>
                <span style={px(e.direction==="BUY_YES"?C.g:C.r,e.direction==="BUY_YES"?C.gd:C.rd)}>{e.side}</span>
                <span style={px(e.status==="FILLED"?C.g:e.status==="PARTIAL"?C.y:C.b,e.status==="FILLED"?C.gd:e.status==="PARTIAL"?C.yd:C.b2)}>{e.status}</span>
                <span style={px(C.p,C.pd)}>{e.strategy}</span>
              </div>
            </div>
            <div style={{display:"flex",gap:6,fontFamily:F,fontSize:8,color:C.dm,flexWrap:"wrap"}}>
              <span>Sz:{fd(e.parentSize)}</span>
              <span>Fill:<b style={{color:C.g}}>{fd(e.totalFilled)}</b>({fp(e.fillRate,0)})</span>
              {e.actualSlip!==null&&<span>Slip:<b style={{color:e.actualSlip>0.005?C.r:C.g}}>{(e.actualSlip*100).toFixed(2)}¢</b></span>}
              {e.slipFeedback&&<span>Est/Act:<b style={{color:e.slipFeedback.ok?C.g:C.r}}>{e.slipFeedback.ok?"OK":"MISS"}</b></span>}
              <span>{e.latMs}ms</span>
            </div>
            <div style={{display:"flex",gap:1.5,marginTop:2}}>{e.children.map(ch=><div key={ch.id} style={{width:Math.max(14,ch.sz/5),height:6,borderRadius:2,background:ch.status==="FILLED"?C.g:C.bd,opacity:0.7}}/>)}</div>
            {e.partialAction&&<div style={{marginTop:2,padding:"2px 5px",borderRadius:3,background:e.partialAction.action==="UNWIND"?C.rd:C.yd,fontSize:8,fontFamily:F}}>
              <span style={{color:e.partialAction.action==="UNWIND"?C.r:C.y,fontWeight:600}}>{e.partialAction.action}</span>
              <span style={{color:C.dm}}> {e.partialAction.reason}</span>
            </div>}
          </div>)}
        </div>
      </div>}

      {tab==="Risk"&&<div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>PRE-TRADE RISK — 10 CHECKS · DYNAMIC DD SIZING</div>
          {execs.slice(0,6).map(e=>e.riskChecks&&<div key={e.id} style={{marginBottom:5,paddingBottom:5,borderBottom:`1px solid ${C.bd}12`}}>
            <div style={{fontSize:9,fontWeight:600,marginBottom:2}}>{mq(e.conditionId)}</div>
            <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
              {e.riskChecks.map((ch,i)=><div key={i} style={{display:"flex",gap:2,alignItems:"center",fontSize:8,fontFamily:F}}>
                <RB s={ch.s}/><span style={{color:C.dm}}>{ch.n}</span>
              </div>)}
            </div>
          </div>)}
        </div>
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>POSITIONS BY THEME</div>
          {Object.keys(positions).length===0&&<div style={{color:C.dm,fontSize:9}}>No positions</div>}
          {Object.entries(positions).map(([id,p])=>{const pct=cfg.maxPos?(p.gross/cfg.maxPos)*100:0;
            return<div key={id} style={{marginBottom:6}}>
              <div style={{fontSize:8,marginBottom:1}}>{mq(id)} <span style={{color:C.dm}}>({MKTS.find(m=>m.id===id)?.cat})</span></div>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <div style={{flex:1,height:4,background:C.s2,borderRadius:2,overflow:"hidden"}}><div style={{width:`${Math.min(pct,100)}%`,height:"100%",background:pct>80?C.r:pct>50?C.y:C.g,borderRadius:2}}/></div>
                <span style={{fontFamily:F,fontSize:8,color:p.pnl>=0?C.g:C.r,minWidth:36,textAlign:"right"}}>{p.pnl>=0?"+":""}{fd(p.pnl)}</span>
              </div></div>;})}
        </div>
      </div>}

      {tab==="Markets"&&<div style={crd}>
        <div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:4}}>MARKET BROWSER — DEPTH + ADV + VOL</div>
        {markets.map(m=>{const h=histR.current[m.id],bk=buildBook(m.yes,m.adv),v=h?h.vol(20):0;
          return<div key={m.id} style={{...mc,marginBottom:5}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
              <div style={{fontSize:10,fontWeight:600,maxWidth:"50%"}}>{m.q}</div>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={px(C.tx,C.s3)}>{m.cat}</span>
                <span style={{fontFamily:F,fontSize:13,fontWeight:700,color:m.yes>0.5?C.g:C.b}}>{(m.yes*100).toFixed(1)}¢</span>
              </div>
            </div>
            <div style={{display:"flex",gap:5,alignItems:"center"}}>
              <Spark data={h?h.prices(50):[]} w={150} h={18} color={m.yes>(m.prevYes||m.yes)?C.g:C.r}/>
              <div style={{display:"flex",gap:6,fontFamily:F,fontSize:8,color:C.dm,flexWrap:"wrap"}}>
                <span>Sprd:<b style={{color:bk.spread>0.03?C.r:C.g}}>{(bk.spread*100).toFixed(1)}¢</b></span>
                <span>ADV:<b>{(m.adv/1000).toFixed(1)}k</b></span>
                <span>Depth:<b>{bk.bidDepth}</b>/<b>{bk.askDepth}</b></span>
                <span>Vol:<b>{(v*100).toFixed(2)}%</b></span>
              </div>
            </div>
          </div>;})}
      </div>}

      {tab==="System"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6,marginBottom:8}}>
          <St l="Avg latency" v={mon?mon.avgLat().toFixed(0)+"ms":"—"} c={C.b}/>
          <St l="Fill rate" v={mon?fp(mon.avgFill()):"—"} c={mon&&mon.avgFill()>0.7?C.g:C.y}/>
          <St l="Approvals" v={mon?.app||0} c={C.g} s={`${mon?.rej||0} rejected`}/>
          <St l="Slip MAE" v={slipAcc.mae!==null?slipAcc.mae+"bps":"—"} c={C.c} s={`bias: ${slipAcc.bias||"—"}`}/>
          <St l="Slip α" v={slipR.current?.alpha.toFixed(3)||"—"} c={C.p} s="online learning"/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:8}}>
          <St l="NLP signals" v={mon?.sc.nlp||0} c={C.c}/>
          <St l="Momentum" v={mon?.sc.momentum||0} c={C.p}/>
          <St l="Arb signals" v={mon?.sc.arb||0} c={C.b}/>
        </div>
        {cbR.current?.triggers.length>0&&<div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:3}}>CIRCUIT BREAKER HISTORY (3-state)</div>
          {cbR.current.triggers.map((t,i)=><div key={i} style={{fontSize:8,fontFamily:F,color:C.r,padding:"1px 0"}}>{ft(t.t)} — {t.r}</div>)}</div>}
        <div style={crd}><div style={{fontSize:8,color:C.dm,fontFamily:F,marginBottom:3}}>EVENT LOG</div>
          <div style={{maxHeight:300,overflowY:"auto"}}>
            {(busR.current?.log||[]).slice().reverse().slice(0,40).map((e,i)=><div key={i} style={{display:"flex",gap:5,padding:"2px 0",borderBottom:`1px solid ${C.bd}08`,fontSize:8,fontFamily:F}}>
              <span style={{color:C.dm,minWidth:44}}>{ft(e.ts)}</span>
              <span style={px(e.evt.includes("halt")||e.evt.includes("error")?C.r:e.evt.includes("risk")?C.o:e.evt.includes("signal")||e.evt.includes("news")?C.p:e.evt.includes("exec")?C.g:e.evt.includes("regime")?C.c:C.dm,e.evt.includes("halt")||e.evt.includes("error")?C.rd:e.evt.includes("risk")?C.od:e.evt.includes("signal")||e.evt.includes("news")?C.pd:e.evt.includes("exec")?C.gd:e.evt.includes("regime")?C.cd:C.s2)}>{e.evt}</span>
              <span style={{color:C.dm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:300}}>{e.s}</span>
            </div>)}
          </div>
        </div>
      </div>}

      <div style={{textAlign:"center",padding:"10px 0 4px",fontSize:7,color:C.dm,fontFamily:F}}>V3.2 PRODUCTION · REGIME-ADAPTIVE · META-ALPHA · ADV-SLIPPAGE · 10-CHECK RISK · {mode.toUpperCase()} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
