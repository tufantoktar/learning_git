// Crypto Price Tracker — Vanilla JS + Chart.js + CoinGecko API
// No API key required. Rate limits apply. Use responsibly.

const DEFAULT_IDS = ["bitcoin","ethereum","solana","binancecoin","dogecoin"];
const STORAGE_KEYS = {
  WATCHLIST: "cpt.watchlist",
  FAVORITES: "cpt.favorites",
  LAST_UPDATED: "cpt.lastUpdated"
};

const state = {
  watchlist: loadJSON(STORAGE_KEYS.WATCHLIST, DEFAULT_IDS),
  favorites: new Set(loadJSON(STORAGE_KEYS.FAVORITES, [])),
  timer: null,
  chart: null,
  selectedId: null
};

const els = {
  tbody: document.getElementById("coins-body"),
  search: document.getElementById("search"),
  addBtn: document.getElementById("add-coin"),
  resetBtn: document.getElementById("reset-defaults"),
  lastUpdated: document.getElementById("last-updated"),
  chartTitle: document.getElementById("chart-title"),
  chartCanvas: document.getElementById("price-chart")
};

function loadJSON(key, fallback){
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}
function setUpdated(ts = new Date()){
  const s = `Last updated: ${ts.toLocaleString()}`;
  els.lastUpdated.textContent = s;
  localStorage.setItem(STORAGE_KEYS.LAST_UPDATED, ts.toISOString());
}
(function hydrateUpdated(){
  const iso = localStorage.getItem(STORAGE_KEYS.LAST_UPDATED);
  if(iso){ els.lastUpdated.textContent = `Last updated: ${new Date(iso).toLocaleString()}`; }
})();

async function fetchMarkets(ids){
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency","usd");
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("price_change_percentage","24h");
  url.searchParams.set("per_page", ids.length.toString());
  url.searchParams.set("sparkline","false");

  const resp = await fetch(url, { headers: { "accept": "application/json" } });
  if(!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

function formatMoney(n){
  if(n === null || n === undefined) return "-";
  if(n >= 1e12) return `$${(n/1e12).toFixed(2)}T`;
  if(n >= 1e9)  return `$${(n/1e9).toFixed(2)}B`;
  if(n >= 1e6)  return `$${(n/1e6).toFixed(2)}M`;
  if(n >= 1e3)  return `$${(n/1e3).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined,{maximumFractionDigits:2})}`;
}

function pctClass(v){ return v >= 0 ? "good" : "bad"; }
function starChar(id){ return state.favorites.has(id) ? "★" : "☆"; }

function renderTable(rows){
  els.tbody.innerHTML = "";
  const favOrder = (a,b) => (state.favorites.has(b.id) - state.favorites.has(a.id)) || a.market_cap_rank - b.market_cap_rank;
  rows.sort(favOrder).forEach(row => {
    const tr = document.createElement("tr");

    const tdStar = document.createElement("td");
    tdStar.className = "star";
    tdStar.textContent = starChar(row.id);
    tdStar.title = "Toggle favorite";
    tdStar.addEventListener("click", () => toggleFavorite(row.id, tdStar));
    tr.appendChild(tdStar);

    const tdName = document.createElement("td");
    tdName.className = "coin-name";
    tdName.innerHTML = `<img src="${row.image}" alt="${row.symbol}"/><strong>${row.name}</strong> <span class="muted">(${row.symbol.toUpperCase()})</span>`;
    tdName.style.cursor = "pointer";
    tdName.addEventListener("click", () => selectCoin(row.id, row.name));
    tr.appendChild(tdName);

    const tdPrice = document.createElement("td");
    tdPrice.className = "price";
    tdPrice.textContent = `$${row.current_price?.toLocaleString(undefined,{maximumFractionDigits:8})}`;
    tr.appendChild(tdPrice);

    const tdChange = document.createElement("td");
    const ch = row.price_change_percentage_24h;
    tdChange.className = pctClass(ch);
    tdChange.textContent = ch == null ? "-" : `${ch.toFixed(2)}%`;
    tr.appendChild(tdChange);

    const tdMcap = document.createElement("td");
    tdMcap.textContent = formatMoney(row.market_cap);
    tr.appendChild(tdMcap);

    const tdVol = document.createElement("td");
    tdVol.textContent = formatMoney(row.total_volume);
    tr.appendChild(tdVol);

    els.tbody.appendChild(tr);
  });
}

async function refresh(){
  if(state.watchlist.length === 0){
    els.tbody.innerHTML = `<tr><td colspan="6" class="muted">Your watchlist is empty. Search a coin id (e.g. "bitcoin") and click Add.</td></tr>`;
    return;
  }
  try {
    const data = await fetchMarkets(state.watchlist);
    renderTable(data);
    setUpdated(new Date());
  } catch (err){
    console.error(err);
    els.tbody.innerHTML = `<tr><td colspan="6" class="bad">Failed to load data. ${err.message}</td></tr>`;
  }
}

function scheduleAutoRefresh(){
  if(state.timer) clearInterval(state.timer);
  state.timer = setInterval(refresh, 60 * 1000); // every minute
}

function ensureIdFormat(s){
  return s.trim().toLowerCase().replace(/\s+/g,"-");
}

function addCoinFromInput(){
  const raw = els.search.value;
  if(!raw) return;
  const id = ensureIdFormat(raw);
  if(state.watchlist.includes(id)){
    alert("Coin is already in your watchlist.");
    return;
  }
  state.watchlist.push(id);
  saveJSON(STORAGE_KEYS.WATCHLIST, state.watchlist);
  els.search.value = "";
  refresh();
}

function resetDefaults(){
  if(!confirm("Reset to default watchlist?")) return;
  state.watchlist = [...DEFAULT_IDS];
  saveJSON(STORAGE_KEYS.WATCHLIST, state.watchlist);
  refresh();
}

function toggleFavorite(id, cell){
  if(state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  saveJSON(STORAGE_KEYS.FAVORITES, [...state.favorites]);
  if(cell) cell.textContent = starChar(id);
  refresh();
}

async function selectCoin(id, name){
  state.selectedId = id;
  els.chartTitle.textContent = `7D Price — ${name}`;
  try {
    const hist = await fetchHistory(id, 7);
    drawChart(hist);
  } catch(err){
    console.error(err);
    els.chartTitle.textContent = `7D Price — ${name} (failed to load)`;
  }
}

async function fetchHistory(id, days){
  const url = new URL(`https://api.coingecko.com/api/v3/coins/${id}/market_chart`);
  url.searchParams.set("vs_currency","usd");
  url.searchParams.set("days", String(days));
  const resp = await fetch(url, { headers: { "accept": "application/json" } });
  if(!resp.ok) throw new Error(`History error ${resp.status}`);
  const json = await resp.json();
  return json.prices.map(([ts, price]) => ({ ts, price }));
}

function drawChart(points){
  const ctx = els.chartCanvas.getContext("2d");
  const labels = points.map(p => new Date(p.ts).toLocaleString());
  const data = points.map(p => p.price);
  if(state.chart){
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = data;
    state.chart.update();
    return;
  }
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Price (USD)",
          data,
          fill: false,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true },
        tooltip: { callbacks: {
          label: (ctx) => `$${ctx.parsed.y.toLocaleString(undefined,{maximumFractionDigits:8})}`
        } }
      },
      scales: {
        x: { display: true, ticks: { maxRotation: 0, autoSkip: true } },
        y: { display: true, ticks: { callback: v => `$${Number(v).toLocaleString()}` } }
      }
    }
  });
}

// Wire up events
els.addBtn.addEventListener("click", addCoinFromInput);
els.search.addEventListener("keydown", (e) => { if(e.key === "Enter") addCoinFromInput(); });
els.resetBtn.addEventListener("click", resetDefaults);

// Init
refresh();
scheduleAutoRefresh();
