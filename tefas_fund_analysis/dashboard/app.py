from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.express as px
import streamlit as st


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "tefas_analysis.sqlite3"
PIPELINE_HINT = "Run the pipeline first: python main.py --all-funds --max-funds 25"

TABLE_COLUMNS = [
    "fund_code",
    "fund_title",
    "category",
    "signal",
    "final_score",
    "momentum_score",
    "risk_score",
    "monthly_return",
    "three_month_return",
    "money_flow_label",
    "money_flow_score",
    "analytical_tags",
]

NUMERIC_COLUMNS = [
    "final_score",
    "momentum_score",
    "risk_score",
    "daily_return",
    "weekly_return",
    "monthly_return",
    "three_month_return",
    "volatility_30",
    "volatility_90",
    "max_drawdown_90",
    "fund_size_latest",
    "investor_count_latest",
    "fund_size_change_1d",
    "fund_size_change_1w",
    "fund_size_change_1m",
    "investor_count_change_1w",
    "investor_count_change_1m",
    "estimated_net_flow_1d",
    "estimated_net_flow_1w",
    "estimated_net_flow_1m",
    "money_flow_score",
]

OPTIONAL_SCORE_COLUMNS = [
    "category",
    "explanation",
    "components",
    "analytical_tags",
]

OPTIONAL_METRIC_COLUMNS = [
    "category",
    "latest_price",
    "daily_return",
    "weekly_return",
    "monthly_return",
    "three_month_return",
    "moving_average_7",
    "moving_average_30",
    "moving_average_90",
    "momentum_score",
    "volatility_30",
    "volatility_90",
    "max_drawdown_90",
    "risk_score",
    "fund_size_latest",
    "investor_count_latest",
    "fund_size_change_1d",
    "fund_size_change_1w",
    "fund_size_change_1m",
    "investor_count_change_1w",
    "investor_count_change_1m",
    "estimated_net_flow_1d",
    "estimated_net_flow_1w",
    "estimated_net_flow_1m",
    "money_flow_score",
    "money_flow_label",
]


def main() -> None:
    st.set_page_config(
        page_title="TEFAS Fund Analysis Dashboard",
        layout="wide",
    )
    st.title("TEFAS Fund Analysis Dashboard")
    st.caption("Local analytical research view backed by the latest SQLite pipeline output.")

    if st.sidebar.button("Refresh data"):
        st.cache_data.clear()

    db_path = DEFAULT_DB_PATH
    if not db_path.exists():
        st.info(PIPELINE_HINT)
        st.stop()

    data = load_dashboard_data(str(db_path))
    for warning in data["warnings"]:
        st.warning(warning)

    funds = data["funds"]
    prices = data["prices"]
    latest_date = data["latest_date"]
    if funds.empty:
        st.info(PIPELINE_HINT)
        st.stop()

    filtered = apply_sidebar_filters(funds)
    render_kpis(filtered)
    render_charts(filtered)
    render_table(filtered)
    render_fund_detail(filtered, prices, latest_date)


@st.cache_data(show_spinner=False)
def load_dashboard_data(db_path: str) -> dict[str, Any]:
    warnings: list[str] = []
    conn = sqlite3.connect(db_path)
    try:
        tables = set(pd.read_sql_query(
            "SELECT name FROM sqlite_master WHERE type='table'",
            conn,
        )["name"].tolist())

        if "fund_scores" not in tables:
            warnings.append("SQLite schema is missing fund_scores. Run the pipeline again.")
            return _empty_payload(warnings)

        scores = _read_table(conn, "fund_scores", warnings)
        if scores.empty:
            return _empty_payload(warnings)

        scores = _ensure_columns(
            scores,
            ["fund_code", "date", "final_score", "signal"] + OPTIONAL_SCORE_COLUMNS,
            "fund_scores",
            warnings,
        )
        scores["date"] = pd.to_datetime(scores["date"], errors="coerce")
        scores = scores.dropna(subset=["fund_code", "date"])
        if scores.empty:
            return _empty_payload(warnings)

        latest_date = scores["date"].max()
        latest_scores = scores[scores["date"] == latest_date].copy()
        latest_scores = latest_scores.rename(columns={"category": "score_category"})

        metrics = _read_optional_table(conn, tables, "fund_metrics", warnings)
        metrics = _ensure_columns(
            metrics,
            ["fund_code", "date"] + OPTIONAL_METRIC_COLUMNS,
            "fund_metrics",
            warnings,
        )
        metrics["date"] = pd.to_datetime(metrics["date"], errors="coerce")
        latest_metrics = _latest_metrics(metrics, latest_date)
        latest_metrics = latest_metrics.rename(columns={"category": "metric_category"})

        funds = latest_scores.merge(
            latest_metrics,
            on="fund_code",
            how="left",
            suffixes=("_score", "_metric"),
        )
        funds["category"] = funds["metric_category"].combine_first(funds["score_category"])

        prices = _read_optional_table(conn, tables, "fund_prices", warnings)
        prices = _ensure_columns(
            prices,
            ["fund_code", "date", "price", "fund_title", "fund_size", "investor_count"],
            "fund_prices",
            warnings,
        )
        prices["date"] = pd.to_datetime(prices["date"], errors="coerce")
        funds = funds.merge(_latest_titles(prices), on="fund_code", how="left")

        funds = _normalize_funds(funds)
        prices = _normalize_prices(prices)
        return {
            "funds": funds,
            "prices": prices,
            "latest_date": latest_date.date().isoformat(),
            "warnings": warnings,
        }
    except Exception as exc:  # pragma: no cover - defensive UI fallback.
        warnings.append(f"Could not read SQLite dashboard data: {exc}")
        return _empty_payload(warnings)
    finally:
        conn.close()


def apply_sidebar_filters(funds: pd.DataFrame) -> pd.DataFrame:
    st.sidebar.header("Filters")
    filtered = funds.copy()

    category = st.sidebar.multiselect("Category", _options(filtered, "category"))
    signal = st.sidebar.multiselect("Signal", _options(filtered, "signal"))
    money_flow = st.sidebar.multiselect("Money Flow Label", _options(filtered, "money_flow_label"))
    tag_options = sorted({tag for tags in filtered["analytical_tag_list"] for tag in tags})
    tags = st.sidebar.multiselect("Analytical Tags", tag_options)

    min_score = st.sidebar.slider("Minimum final_score", 0.0, 100.0, 0.0, 1.0)
    max_risk = st.sidebar.slider("Maximum risk_score", 0.0, 100.0, 100.0, 1.0)
    search = st.sidebar.text_input("Search fund_code or fund_title").strip().casefold()

    if category:
        filtered = filtered[filtered["category"].isin(category)]
    if signal:
        filtered = filtered[filtered["signal"].isin(signal)]
    if money_flow:
        filtered = filtered[filtered["money_flow_label"].isin(money_flow)]
    if tags:
        filtered = filtered[
            filtered["analytical_tag_list"].apply(lambda values: any(tag in values for tag in tags))
        ]

    filtered = filtered[
        filtered["final_score"].isna() | (filtered["final_score"] >= min_score)
    ]
    filtered = filtered[
        filtered["risk_score"].isna() | (filtered["risk_score"] <= max_risk)
    ]
    if search:
        haystack = (
            filtered["fund_code"].fillna("").str.casefold()
            + " "
            + filtered["fund_title"].fillna("").str.casefold()
        )
        filtered = filtered[haystack.str.contains(search, regex=False)]

    return filtered


def render_kpis(funds: pd.DataFrame) -> None:
    cols = st.columns(8)
    metrics = [
        ("Total funds analyzed", len(funds)),
        ("Average final score", _mean_score(funds, "final_score")),
        ("Strong Watch", _count_value(funds, "signal", "Strong Watch")),
        ("Watch", _count_value(funds, "signal", "Watch")),
        ("Risky", _count_value(funds, "signal", "Risky")),
        ("Strong Inflow", _count_value(funds, "money_flow_label", "STRONG_INFLOW")),
        ("Strong Outflow", _count_value(funds, "money_flow_label", "STRONG_OUTFLOW")),
        ("Overheated", _count_tag(funds, "OVERHEATED")),
    ]
    for column, (label, value) in zip(cols, metrics):
        column.metric(label, value)


def render_charts(funds: pd.DataFrame) -> None:
    st.subheader("Charts")
    if funds.empty:
        st.info("No funds match the selected filters.")
        return

    left, right = st.columns(2)
    if funds["final_score"].notna().any():
        top = funds.sort_values("final_score", ascending=False).head(10)
        fig = px.bar(
            top,
            x="final_score",
            y="fund_code",
            orientation="h",
            hover_data=["fund_title", "category", "signal"],
            title="Top 10 funds by final_score",
        )
        fig.update_layout(yaxis={"categoryorder": "total ascending"})
        left.plotly_chart(fig, use_container_width=True)

    category_counts = _value_counts_frame(funds, "category", "category")
    if not category_counts.empty:
        right.plotly_chart(
            px.bar(category_counts, x="category", y="count", title="Category distribution"),
            use_container_width=True,
        )

    left, right = st.columns(2)
    signal_counts = _value_counts_frame(funds, "signal", "signal")
    if not signal_counts.empty:
        left.plotly_chart(
            px.bar(signal_counts, x="signal", y="count", title="Signal distribution"),
            use_container_width=True,
        )

    if funds[["risk_score", "monthly_return"]].notna().any(axis=None):
        right.plotly_chart(
            px.scatter(
                funds,
                x="risk_score",
                y="monthly_return",
                color="category",
                hover_name="fund_code",
                hover_data=["fund_title", "signal", "final_score"],
                title="Risk vs 1M return",
            ),
            use_container_width=True,
        )

    left, right = st.columns(2)
    if funds["money_flow_score"].notna().any():
        flow = funds.sort_values("money_flow_score", ascending=False).head(10)
        left.plotly_chart(
            px.bar(
                flow,
                x="money_flow_score",
                y="fund_code",
                color="money_flow_label",
                orientation="h",
                title="Money flow score",
            ),
            use_container_width=True,
        )

    tag_counts = _tag_counts_frame(funds)
    if not tag_counts.empty:
        right.plotly_chart(
            px.bar(tag_counts, x="tag", y="count", title="Analytical tag counts"),
            use_container_width=True,
        )


def render_table(funds: pd.DataFrame) -> None:
    st.subheader("Funds")
    table = funds[[column for column in TABLE_COLUMNS if column in funds.columns]].copy()
    table = table.sort_values("final_score", ascending=False, na_position="last")
    st.dataframe(table, use_container_width=True, hide_index=True)


def render_fund_detail(
    funds: pd.DataFrame,
    prices: pd.DataFrame,
    latest_date: str | None,
) -> None:
    st.subheader("Fund Detail")
    if funds.empty:
        st.info("Select filters that include at least one fund.")
        return

    options = funds.sort_values("fund_code")["fund_code"].tolist()
    label_lookup = {
        row.fund_code: f"{row.fund_code} - {row.fund_title}" if row.fund_title else row.fund_code
        for row in funds.itertuples()
    }
    selected = st.selectbox(
        "Select a fund",
        options,
        format_func=lambda code: label_lookup.get(code, code),
    )
    selected_row = funds[funds["fund_code"] == selected].iloc[0]
    st.caption(f"Latest analysis date: {latest_date or 'n/a'}")

    history = prices[prices["fund_code"] == selected].sort_values("date")
    if not history.empty and history["price"].notna().any():
        st.plotly_chart(
            px.line(history, x="date", y="price", title=f"{selected} price history"),
            use_container_width=True,
        )
    else:
        st.info("No price history available for the selected fund.")

    detail_cols = [
        "fund_code",
        "fund_title",
        "category",
        "signal",
        "final_score",
        "momentum_score",
        "risk_score",
        "monthly_return",
        "three_month_return",
        "volatility_30",
        "max_drawdown_90",
    ]
    st.write("Latest metrics")
    st.dataframe(
        selected_row[[column for column in detail_cols if column in funds.columns]].to_frame("value"),
        use_container_width=True,
    )

    flow_cols = [
        "money_flow_label",
        "money_flow_score",
        "fund_size_latest",
        "investor_count_latest",
        "estimated_net_flow_1d",
        "estimated_net_flow_1w",
        "estimated_net_flow_1m",
        "investor_count_change_1w",
        "investor_count_change_1m",
    ]
    has_flow_label = bool(str(selected_row.get("money_flow_label", "")).strip())
    has_flow_values = selected_row[[column for column in flow_cols if column != "money_flow_label"]].notna().any()
    if has_flow_label or has_flow_values:
        st.write("Money flow details")
        st.dataframe(selected_row[flow_cols].to_frame("value"), use_container_width=True)

    tags = selected_row["analytical_tag_list"]
    if tags:
        st.write("Analytical tags")
        st.write(", ".join(tags))


def _read_table(conn: sqlite3.Connection, table_name: str, warnings: list[str]) -> pd.DataFrame:
    try:
        return pd.read_sql_query(f'SELECT * FROM "{table_name}"', conn)
    except Exception as exc:
        warnings.append(f"Could not read {table_name}: {exc}")
        return pd.DataFrame()


def _read_optional_table(
    conn: sqlite3.Connection,
    tables: set[str],
    table_name: str,
    warnings: list[str],
) -> pd.DataFrame:
    if table_name not in tables:
        warnings.append(f"SQLite schema is missing optional table {table_name}.")
        return pd.DataFrame()
    return _read_table(conn, table_name, warnings)


def _ensure_columns(
    frame: pd.DataFrame,
    columns: list[str],
    table_name: str,
    warnings: list[str],
) -> pd.DataFrame:
    frame = frame.copy()
    missing = [column for column in columns if column not in frame.columns]
    if missing:
        warnings.append(
            f"SQLite schema is missing columns in {table_name}: {', '.join(missing)}. "
            "Older databases may need to be recreated."
        )
    for column in missing:
        frame[column] = pd.NA
    return frame


def _latest_metrics(metrics: pd.DataFrame, latest_date: pd.Timestamp) -> pd.DataFrame:
    metrics = metrics.dropna(subset=["fund_code"]).copy()
    if metrics.empty:
        return metrics
    exact = metrics[metrics["date"] == latest_date].copy()
    if not exact.empty:
        return exact
    metrics = metrics.sort_values(["fund_code", "date"])
    return metrics.drop_duplicates("fund_code", keep="last")


def _latest_titles(prices: pd.DataFrame) -> pd.DataFrame:
    if prices.empty:
        return pd.DataFrame({"fund_code": [], "fund_title": []})
    titles = prices.dropna(subset=["fund_code"]).sort_values(["fund_code", "date"])
    titles = titles.drop_duplicates("fund_code", keep="last")
    return titles[["fund_code", "fund_title"]]


def _normalize_funds(funds: pd.DataFrame) -> pd.DataFrame:
    funds = funds.copy()
    for column in NUMERIC_COLUMNS:
        if column not in funds.columns:
            funds[column] = pd.NA
        funds[column] = pd.to_numeric(funds[column], errors="coerce")

    for column in ["fund_code", "fund_title", "category", "signal", "money_flow_label"]:
        if column not in funds.columns:
            funds[column] = ""
        funds[column] = funds[column].fillna("").astype(str)

    funds["analytical_tag_list"] = funds["analytical_tags"].apply(_parse_tags)
    funds["analytical_tags"] = funds["analytical_tag_list"].apply(lambda tags: "|".join(tags))
    return funds


def _normalize_prices(prices: pd.DataFrame) -> pd.DataFrame:
    prices = prices.copy()
    if "price" not in prices.columns:
        prices["price"] = pd.NA
    prices["price"] = pd.to_numeric(prices["price"], errors="coerce")
    if "date" in prices.columns:
        prices["date"] = pd.to_datetime(prices["date"], errors="coerce")
    return prices


def _parse_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if value is None or pd.isna(value):
        return []
    text = str(value).strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item) for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    separator = "|" if "|" in text else ","
    return [part.strip() for part in text.split(separator) if part.strip()]


def _options(frame: pd.DataFrame, column: str) -> list[str]:
    if column not in frame.columns:
        return []
    return sorted(value for value in frame[column].dropna().astype(str).unique() if value)


def _mean_score(frame: pd.DataFrame, column: str) -> str:
    if column not in frame.columns or frame[column].dropna().empty:
        return "n/a"
    return f"{frame[column].mean():.2f}"


def _count_value(frame: pd.DataFrame, column: str, value: str) -> int:
    if column not in frame.columns:
        return 0
    return int((frame[column] == value).sum())


def _count_tag(frame: pd.DataFrame, tag: str) -> int:
    if "analytical_tag_list" not in frame.columns:
        return 0
    return int(frame["analytical_tag_list"].apply(lambda tags: tag in tags).sum())


def _value_counts_frame(frame: pd.DataFrame, column: str, label: str) -> pd.DataFrame:
    if column not in frame.columns:
        return pd.DataFrame(columns=[label, "count"])
    counts = frame[column].replace("", pd.NA).dropna().value_counts()
    return counts.rename_axis(label).reset_index(name="count")


def _tag_counts_frame(frame: pd.DataFrame) -> pd.DataFrame:
    if "analytical_tag_list" not in frame.columns:
        return pd.DataFrame(columns=["tag", "count"])
    tags = [tag for values in frame["analytical_tag_list"] for tag in values]
    if not tags:
        return pd.DataFrame(columns=["tag", "count"])
    return pd.Series(tags).value_counts().rename_axis("tag").reset_index(name="count")


def _empty_payload(warnings: list[str]) -> dict[str, Any]:
    return {
        "funds": pd.DataFrame(),
        "prices": pd.DataFrame(),
        "latest_date": None,
        "warnings": warnings,
    }


if __name__ == "__main__":
    main()
