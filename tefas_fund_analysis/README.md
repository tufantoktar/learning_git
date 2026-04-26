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
    analysis/category_engine.py
    analysis/money_flow_engine.py
    analysis/tag_engine.py
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
TEFAS_SAVE_RAW_PAYLOAD=false
```

Then remove `TEFAS_MAX_FUNDS` or leave it empty for a full scan.

You can also override config and environment values for one run:

```bash
python main.py --all-funds --max-funds 25
```

## Phase 2A Category Classification

Phase 2A adds deterministic fund category classification and category-aware scoring. Categories are inferred from TEFAS metadata and fund-title keyword hints, then carried into Markdown and CSV reports.

Supported categories:

- `MONEY_MARKET`
- `EQUITY`
- `VARIABLE`
- `DEBT`
- `PRECIOUS_METALS`
- `FOREIGN_EQUITY`
- `PARTICIPATION`
- `FUND_BASKET`
- `UNKNOWN`

Category-aware scoring is enabled by default with `TEFAS_ENABLE_CATEGORY_SCORING=true`. When enabled, scoring profiles adjust momentum, return, and stability weights by category while keeping calculations deterministic. When disabled, categories are still classified and reported, but the generic Phase 1 scoring formula is used.

## Phase 2B Money Flow Analysis

Phase 2B adds deterministic money inflow/outflow approximation from TEFAS `fund_size`, `price`, and `investor_count` fields. Money flow analysis is approximate and for research only. It is not investment advice.

Estimated net flow is calculated per window as:

```text
fund_return = latest_price / previous_price - 1
expected_size_change_due_to_price = previous_fund_size * fund_return
estimated_net_flow = latest_fund_size - previous_fund_size - expected_size_change_due_to_price
```

The engine calculates 1D, 1W, and 1M estimated net flow using 1, 5, and 21 trading observations. A deterministic 0-100 money flow score is then produced from flow ratios and investor count trend. Labels are:

- `STRONG_INFLOW`
- `INFLOW`
- `NEUTRAL_FLOW`
- `OUTFLOW`
- `STRONG_OUTFLOW`
- `UNKNOWN_FLOW`

Money flow analysis is enabled by default with `TEFAS_ENABLE_MONEY_FLOW_ANALYSIS=true`. If TEFAS fund size data is missing, the pipeline keeps running and reports `UNKNOWN_FLOW` with a neutral score.

## Phase 2C Analytical Tags

Phase 2C adds deterministic analytical tags as additional research labels. Analytical tags are deterministic research labels. They are not investment advice.

Supported tags:

- `OVERHEATED`: very strong recent return plus high momentum and elevated risk or volatility.
- `COOLING_MOMENTUM`: positive longer trend with short-term weakness and, when available, price below the 7-observation moving average.
- `CONSISTENT_UPTREND`: positive weekly, monthly, and 3-month returns with acceptable category-aware risk.
- `HIGH_DRAWDOWN`: max drawdown is severe for the fund category.
- `LOW_LIQUIDITY`: available fund size or investor count is below configured liquidity thresholds.
- `RECOVERY_WATCH`: recent weekly/monthly returns are improving after a notable category-aware drawdown.

Analytical tags are enabled by default with `TEFAS_ENABLE_ANALYTICAL_TAGS=true`. Thresholds are deterministic and configurable under the `analytical_tags` section in `config/config.example.json`.

## Run The Daily Pipeline

```bash
python main.py --config config/config.example.json
```

The pipeline will:

1. Fetch TEFAS history for configured fund codes, or for all discovered funds when all-funds mode is enabled.
2. Store raw responses and normalized prices in SQLite.
3. Calculate returns, moving averages, momentum, volatility, max drawdown, risk, optional money flow metrics, and optional analytical tags.
4. Combine metrics into a deterministic score and signal.
5. Write Markdown and CSV reports under `reports/output/`.
6. Optionally send a Telegram notification.

To analyze already-stored prices without collecting:

```bash
python main.py --skip-collect --as-of 2026-04-25
```

To run an all-funds scan without changing `.env`:

```bash
python main.py --all-funds --max-funds 25
```

To classify categories but use generic Phase 1 scoring:

```bash
python main.py --all-funds --max-funds 25 --disable-category-scoring
```

To skip money flow approximation for a run:

```bash
python main.py --all-funds --max-funds 25 --disable-money-flow
```

To skip analytical tag generation for a run:

```bash
python main.py --all-funds --max-funds 25 --disable-analytical-tags
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

The unit tests cover deterministic performance, risk, money flow, analytical tags, recommendation, pipeline, and report behavior.

## Scoring Summary

- Performance metrics use trading-day windows: 1 day, 5 days, 21 days, and 63 days.
- Moving averages use 7, 30, and 90 price observations by default.
- Volatility is annualized from daily returns with a 252-trading-day convention.
- Max drawdown is calculated from historical price peaks to troughs.
- Final scoring rewards momentum and return strength while penalizing higher risk.
- Money flow can add a small score adjustment for inflow labels or subtract a small adjustment for outflow labels. It does not dominate performance and risk scoring.
- Analytical tags are reported as additional deterministic labels and do not change the final score in Phase 2C.

Thresholds are config-driven in `config/config.example.json`.

## Data Source Notes

The MVP uses TEFAS historical price data from the TEFAS web endpoint configured as `collector.base_url`. TEFAS does not provide a formal public developer API contract for this endpoint, so the collector is isolated behind `collectors/tefas_collector.py` and can be replaced later without changing the analysis engines.

All-funds scan mode relies on the same TEFAS history endpoint returning multiple fund codes when `fonkod` is omitted. If TEFAS changes this web endpoint behavior, only the collector layer should need to be updated.

Raw TEFAS payload storage is enabled by default with `TEFAS_SAVE_RAW_PAYLOAD=true`. For broad all-funds scans, set it to `false` if you only want normalized price rows stored.

Phase 2A, Phase 2B, and Phase 2C add category, money flow, and analytical tag columns to the local SQLite schema. If upgrading from an older version and SQLite schema errors occur, delete `data/tefas_analysis.sqlite3` and rerun the pipeline.

## Extension Points

`src/tefas_analysis/extensions/interfaces.py` defines interfaces for future global market data, news sentiment, X/Twitter sentiment, and AI commentary providers. They are intentionally not implemented in this MVP.

Future modules can enrich `FundAnalysisResult` objects before report generation while keeping the core TEFAS pipeline deterministic.
