# TEFAS Fund Analysis MVP

Daily TEFAS mutual fund analysis pipeline for collecting Turkish mutual fund prices, calculating deterministic performance and risk metrics, scoring funds, and producing Markdown/CSV reports.

This project is an analytical system only. It does not provide direct financial advice, portfolio advice, buy/sell instructions, or personalized recommendations. Signals such as `Strong Watch`, `Watch`, `Neutral`, `Risky`, and `Profit Taking Watch` are research labels based on historical data.

## Structure

```text
tefas_fund_analysis/
  config/
    config.example.json
  examples/
    daily_report.md
    daily_report.csv
  src/tefas_analysis/
    collectors/tefas_collector.py
    analysis/performance_engine.py
    analysis/risk_engine.py
    analysis/recommendation_engine.py
    database/models.py
    database/repository.py
    reports/daily_report.py
    notifications/telegram_bot.py
    extensions/interfaces.py
    config.py
    pipeline.py
    main.py
  tests/
    test_performance_engine.py
    test_risk_engine.py
    test_recommendation_engine.py
  .env.example
  main.py
  pyproject.toml
```

## Setup

Use Python 3.11 or newer.

```bash
cd tefas_fund_analysis
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

## Fund Selection Modes

### 1. Selected Funds Mode

Use this mode when you want to analyze only specific TEFAS fund codes.

```env
TEFAS_ANALYZE_ALL_FUNDS=false
TEFAS_FUND_CODES=AFT,MAC,TCD
```

### 2. All-Funds Scan Mode

Use this mode when you want the pipeline to scan all funds returned by the TEFAS history endpoint, score them, and rank them in the report.

```env
TEFAS_ANALYZE_ALL_FUNDS=true
```

You can also enable the same behavior with:

```env
TEFAS_FUND_CODES=ALL
```

For a quick smoke test, limit the scan first:

```env
TEFAS_ANALYZE_ALL_FUNDS=true
TEFAS_MAX_FUNDS=25
```

Then remove `TEFAS_MAX_FUNDS` or leave it empty for a full scan.

## Run The Daily Pipeline

```bash
python main.py --config config/config.example.json
```

The pipeline will:

1. Fetch TEFAS history for configured fund codes, or for all discovered funds when all-funds mode is enabled.
2. Store raw responses and normalized prices in SQLite.
3. Calculate returns, moving averages, momentum, volatility, max drawdown, and risk.
4. Combine metrics into a deterministic score and signal.
5. Write Markdown and CSV reports under `reports/output/`.
6. Optionally send a Telegram notification.

To analyze already-stored prices without collecting:

```bash
python main.py --skip-collect --as-of 2026-04-25
```

To run on a daily schedule:

```bash
python main.py --schedule
```

## Telegram Notifications

Set these in `.env`:

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_CHAT_ID=123456789
```

Notifications are optional and disabled by default.

## Tests

```bash
pytest
```

The unit tests cover deterministic performance, risk, and recommendation engine behavior.

## Scoring Summary

- Performance metrics use trading-day windows: 1 day, 5 days, 21 days, and 63 days.
- Moving averages use 7, 30, and 90 price observations by default.
- Volatility is annualized from daily returns with a 252-trading-day convention.
- Max drawdown is calculated from historical price peaks to troughs.
- Final scoring rewards momentum and return strength while penalizing higher risk.

Thresholds are config-driven in `config/config.example.json`.

## Data Source Notes

The MVP uses TEFAS historical price data from the TEFAS web endpoint configured as `collector.base_url`. TEFAS does not provide a formal public developer API contract for this endpoint, so the collector is isolated behind `collectors/tefas_collector.py` and can be replaced later without changing the analysis engines.

All-funds scan mode relies on the same TEFAS history endpoint returning multiple fund codes when `fonkod` is omitted. If TEFAS changes this web endpoint behavior, only the collector layer should need to be updated.

## Extension Points

`src/tefas_analysis/extensions/interfaces.py` defines interfaces for future global market data, news sentiment, X/Twitter sentiment, and AI commentary providers. They are intentionally not implemented in this MVP.

Future modules can enrich `FundAnalysisResult` objects before report generation while keeping the core TEFAS pipeline deterministic.
