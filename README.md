# Crypto Price Tracker

A minimal **Vanilla JS** app that tracks crypto prices using **CoinGecko API** and renders a 7‑day price chart with **Chart.js**.

## ✨ Features
- Watchlist with default coins (BTC, ETH, SOL, BNB, DOGE)
- Add any coin by its CoinGecko ID (e.g. `bitcoin`, `pepe`, `worldcoin`)
- Favorites (★) saved to `localStorage`
- Auto refresh every minute
- 7‑day line chart for the selected coin
- No build step, no API keys

## 🗂️ Project Structure
```
crypto-price-tracker/
├─ index.html
├─ styles.css
├─ app.js
└─ README.md
```

## 🚀 Run Locally
Just open `index.html` in your browser — or use a static server:

```bash
# Python 3
python -m http.server 8080
# then open http://localhost:8080
```

## 🧩 Notes
- CoinGecko public endpoints have rate limits. If you add *many* coins, you might hit them.
- Search/add expects **CoinGecko coin IDs** (lowercase, hyphenated), not tickers. You can look them up on CoinGecko pages.

## 📄 License
MIT © 2025
