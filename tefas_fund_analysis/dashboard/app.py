"""TEFAS Fon Analiz Paneli - Türkçe, TEFAS benzeri tablo öncelikli arayüz.

Bu dashboard yalnızca analitik araştırma amaçlıdır; yatırım tavsiyesi içermez.
Skor mantığı, pipeline ve rapor üretimi DEĞİŞTİRİLMEDİ. Sadece görüntüleme katmanı.
"""

from __future__ import annotations

import io
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import plotly.express as px
import streamlit as st


# ---------------------------------------------------------------------------
# Sabitler / Ayarlar
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "tefas_analysis.sqlite3"
DB_PATH_ENV = "TEFAS_DASHBOARD_DB_PATH"

PIPELINE_HINT_TR = (
    "Veri bulunamadı. Önce pipeline çalıştırın:\n\n"
    "```\n"
    "python main.py --collector-source csv "
    "--csv-path data/input/tefas_history.csv --all-funds --report-language tr\n"
    "```"
)

RESEARCH_WARNING_TR = (
    "Bu ekran analitik araştırma amaçlıdır; yatırım tavsiyesi değildir."
)

# Türkçe görüntüleme eşleştirmeleri (iç değerler İngilizce kalır).
CATEGORY_TR: dict[str, str] = {
    "MONEY_MARKET": "Para Piyasası",
    "EQUITY": "Hisse Senedi",
    "VARIABLE": "Değişken",
    "DEBT": "Borçlanma Araçları",
    "PRECIOUS_METALS": "Kıymetli Madenler",
    "FOREIGN_EQUITY": "Yabancı Hisse",
    "PARTICIPATION": "Katılım",
    "FUND_BASKET": "Fon Sepeti",
    "UNKNOWN": "Bilinmiyor",
}

SIGNAL_TR: dict[str, str] = {
    "Strong Watch": "Güçlü İzleme",
    "Watch": "İzleme",
    "Neutral": "Nötr",
    "Risky": "Riskli",
    "Profit Taking Watch": "Kâr Realizasyonu İzleme",
}

MONEY_FLOW_TR: dict[str, str] = {
    "STRONG_INFLOW": "Güçlü Para Girişi",
    "INFLOW": "Para Girişi",
    "NEUTRAL_FLOW": "Nötr Para Akışı",
    "OUTFLOW": "Para Çıkışı",
    "STRONG_OUTFLOW": "Güçlü Para Çıkışı",
    "UNKNOWN_FLOW": "Bilinmeyen Para Akışı",
}

TAG_TR: dict[str, str] = {
    "OVERHEATED": "Aşırı Isınmış",
    "COOLING_MOMENTUM": "Momentum Kaybı",
    "CONSISTENT_UPTREND": "İstikrarlı Yükseliş",
    "HIGH_DRAWDOWN": "Yüksek Düşüş",
    "LOW_LIQUIDITY": "Düşük Likidite",
    "RECOVERY_WATCH": "Toparlanma İzleme",
}

# Ana karşılaştırma tablosu sütunları: (iç_anahtar, türkçe_başlık, biçim_tipi)
# biçim_tipi: 'percent', 'score', 'category', 'signal', 'money_flow', 'tags', 'text'
TABLE_COLUMN_SPECS: list[tuple[str, str, str]] = [
    ("fund_code", "Fon Kodu", "text"),
    ("fund_title", "Fon Adı", "text"),
    ("category", "Kategori", "category"),
    ("signal", "Sinyal", "signal"),
    ("final_score", "Skor", "score"),
    ("momentum_score", "Momentum", "score"),
    ("risk_score", "Risk", "score"),
    ("daily_return", "Günlük Getiri", "percent"),
    ("weekly_return", "Haftalık Getiri", "percent"),
    ("monthly_return", "1A Getiri", "percent"),
    ("three_month_return", "3A Getiri", "percent"),
    ("volatility_30", "30G Volatilite", "percent"),
    ("max_drawdown_90", "90G Maksimum Düşüş", "percent"),
    ("money_flow_label", "Para Akışı", "money_flow"),
    ("money_flow_score", "Para Akışı Skoru", "score"),
    ("analytical_tags", "Analitik Etiketler", "tags"),
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

OPTIONAL_SCORE_COLUMNS = ["category", "explanation", "components", "analytical_tags"]
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


# ---------------------------------------------------------------------------
# Görüntüleme yardımcıları
# ---------------------------------------------------------------------------

def display_category(value: Any) -> str:
    """Kategori iç kodunu Türkçe görüntüye çevir."""
    if value is None or _is_nan(value):
        return "-"
    text = str(value).strip()
    if not text:
        return "-"
    return CATEGORY_TR.get(text, text)


def display_signal(value: Any) -> str:
    if value is None or _is_nan(value):
        return "-"
    text = str(value).strip()
    if not text:
        return "-"
    return SIGNAL_TR.get(text, text)


def display_money_flow(value: Any) -> str:
    if value is None or _is_nan(value):
        return "-"
    text = str(value).strip()
    if not text:
        return "-"
    return MONEY_FLOW_TR.get(text, text)


def display_tags(value: Any) -> str:
    tags = normalize_tags(value)
    if not tags:
        return "-"
    return ", ".join(TAG_TR.get(tag, tag) for tag in tags)


def format_percent(value: Any, decimals: int = 2) -> str:
    """Ondalık oranı yüzde olarak biçimlendir (0.0123 -> '1.23%')."""
    if value is None or _is_nan(value):
        return "-"
    try:
        return f"{float(value) * 100:.{decimals}f}%"
    except (TypeError, ValueError):
        return "-"


def format_score(value: Any, decimals: int = 2) -> str:
    if value is None or _is_nan(value):
        return "-"
    try:
        return f"{float(value):.{decimals}f}"
    except (TypeError, ValueError):
        return "-"


def normalize_tags(value: Any) -> list[str]:
    """Etiket alanını standart bir liste haline getir."""
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if value is None or _is_nan(value):
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


def _is_nan(value: Any) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def build_display_table(df: pd.DataFrame) -> pd.DataFrame:
    """Türkçe başlıklı, biçimlendirilmiş ana karşılaştırma tablosunu üret."""
    if df.empty:
        return pd.DataFrame(columns=[label for _, label, _ in TABLE_COLUMN_SPECS])

    rows: dict[str, list[Any]] = {label: [] for _, label, _ in TABLE_COLUMN_SPECS}
    for _, row in df.iterrows():
        for src, label, kind in TABLE_COLUMN_SPECS:
            value = row.get(src) if src in df.columns else None
            if kind == "percent":
                rows[label].append(format_percent(value))
            elif kind == "score":
                rows[label].append(format_score(value))
            elif kind == "category":
                rows[label].append(display_category(value))
            elif kind == "signal":
                rows[label].append(display_signal(value))
            elif kind == "money_flow":
                rows[label].append(display_money_flow(value))
            elif kind == "tags":
                rows[label].append(display_tags(value))
            else:  # text
                if value is None or _is_nan(value) or str(value).strip() == "":
                    rows[label].append("-")
                else:
                    rows[label].append(str(value))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Veri yükleme (mevcut SQLite şeması korunarak)
# ---------------------------------------------------------------------------

def _resolve_db_path() -> Path:
    env_path = os.getenv(DB_PATH_ENV)
    if env_path:
        return Path(env_path).expanduser()
    return DEFAULT_DB_PATH


@st.cache_data(show_spinner=False)
def load_dashboard_data(db_path: str) -> dict[str, Any]:
    warnings: list[str] = []
    if not Path(db_path).exists():
        return _empty_payload(warnings)
    conn = sqlite3.connect(db_path)
    try:
        tables = set(pd.read_sql_query(
            "SELECT name FROM sqlite_master WHERE type='table'",
            conn,
        )["name"].tolist())

        if "fund_scores" not in tables:
            warnings.append(
                "SQLite şeması fund_scores tablosunu içermiyor. Pipeline'ı tekrar çalıştırın."
            )
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
    except Exception as exc:  # pragma: no cover - savunmacı UI fallback
        warnings.append(f"SQLite verisi okunamadı: {exc}")
        return _empty_payload(warnings)
    finally:
        conn.close()


def _read_table(conn: sqlite3.Connection, table_name: str, warnings: list[str]) -> pd.DataFrame:
    try:
        return pd.read_sql_query(f'SELECT * FROM "{table_name}"', conn)
    except Exception as exc:
        warnings.append(f"{table_name} okunamadı: {exc}")
        return pd.DataFrame()


def _read_optional_table(
    conn: sqlite3.Connection,
    tables: set[str],
    table_name: str,
    warnings: list[str],
) -> pd.DataFrame:
    if table_name not in tables:
        warnings.append(f"SQLite şeması opsiyonel {table_name} tablosunu içermiyor.")
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
            f"{table_name} tablosunda eksik sütunlar: {', '.join(missing)}. "
            "Eski veritabanları yeniden oluşturulmalı olabilir."
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
    if prices.empty or "fund_code" not in prices.columns:
        return pd.DataFrame({"fund_code": [], "fund_title": []})
    titles = prices.dropna(subset=["fund_code"]).sort_values(["fund_code", "date"])
    titles = titles.drop_duplicates("fund_code", keep="last")
    keep = [column for column in ["fund_code", "fund_title"] if column in titles.columns]
    return titles[keep]


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

    funds["analytical_tag_list"] = funds["analytical_tags"].apply(normalize_tags)
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


def _empty_payload(warnings: list[str]) -> dict[str, Any]:
    return {
        "funds": pd.DataFrame(),
        "prices": pd.DataFrame(),
        "latest_date": None,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Filtreler
# ---------------------------------------------------------------------------

def _options_with_labels(values: Iterable[str], mapping: dict[str, str]) -> list[tuple[str, str]]:
    """Benzersiz iç değerleri Türkçe etiketleriyle (value, label) listele."""
    seen: list[str] = []
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.append(text)
    seen.sort(key=lambda v: mapping.get(v, v))
    return [(value, mapping.get(value, value)) for value in seen]


def render_filter_panel(funds: pd.DataFrame) -> dict[str, Any]:
    """Filtre panelini çiz ve filtre değerlerini sözlük olarak döndür."""
    st.markdown("### Filtreler")
    f: dict[str, Any] = {}

    # Üst satır: arama
    f["search"] = st.text_input("Fon kodu veya fon adı ara", "").strip().casefold()

    # Multiselect'ler: 4 sütun
    c1, c2, c3, c4 = st.columns(4)
    cat_opts = _options_with_labels(funds.get("category", pd.Series(dtype=str)), CATEGORY_TR)
    f["category"] = c1.multiselect(
        "Kategori",
        options=[v for v, _ in cat_opts],
        format_func=lambda v: CATEGORY_TR.get(v, v),
    )
    sig_opts = _options_with_labels(funds.get("signal", pd.Series(dtype=str)), SIGNAL_TR)
    f["signal"] = c2.multiselect(
        "Sinyal",
        options=[v for v, _ in sig_opts],
        format_func=lambda v: SIGNAL_TR.get(v, v),
    )
    flow_opts = _options_with_labels(funds.get("money_flow_label", pd.Series(dtype=str)), MONEY_FLOW_TR)
    f["money_flow"] = c3.multiselect(
        "Para Akışı",
        options=[v for v, _ in flow_opts],
        format_func=lambda v: MONEY_FLOW_TR.get(v, v),
    )
    if "analytical_tag_list" in funds.columns:
        all_tags = sorted({tag for tags in funds["analytical_tag_list"] for tag in tags})
    else:
        all_tags = []
    f["tags"] = c4.multiselect(
        "Analitik Etiketler",
        options=all_tags,
        format_func=lambda v: TAG_TR.get(v, v),
    )

    # Slider'lar: 3 sütun, iki sıra
    s1, s2, s3 = st.columns(3)
    f["min_score"] = s1.slider("Minimum Skor", 0.0, 100.0, 0.0, 1.0)
    f["max_risk"] = s2.slider("Maksimum Risk", 0.0, 100.0, 100.0, 1.0)
    f["min_max_drawdown_neg"] = s3.slider(
        "Maksimum Düşüş (mutlak %, üst sınır)", 0.0, 100.0, 100.0, 1.0,
        help="Örn. 30 seçilirse |max_drawdown_90| ≤ 30% olan fonlar gelir."
    )
    s4, s5, _ = st.columns(3)
    f["min_monthly_return"] = s4.slider(
        "Minimum 1A Getiri (%)", -100.0, 200.0, -100.0, 1.0
    )
    f["min_three_month_return"] = s5.slider(
        "Minimum 3A Getiri (%)", -100.0, 500.0, -100.0, 1.0
    )

    # Checkbox'lar
    cb1, cb2, cb3 = st.columns(3)
    f["only_inflow"] = cb1.checkbox("Sadece para girişi olan fonlar", value=False)
    f["only_outflow"] = cb1.checkbox("Sadece para çıkışı olan fonlar", value=False)
    f["only_overheated"] = cb2.checkbox("Sadece aşırı ısınmış fonlar", value=False)
    f["only_cooling"] = cb2.checkbox("Sadece momentum kaybı olan fonlar", value=False)
    f["hide_unknown_category"] = cb3.checkbox("Bilinmeyen kategorileri gizle", value=False)
    f["hide_unknown_money_flow"] = cb3.checkbox("Bilinmeyen para akışını gizle", value=False)

    return f


def apply_filters(df: pd.DataFrame, filter_values: dict[str, Any]) -> pd.DataFrame:
    """Tüm filtreleri kombinasyonel olarak uygula."""
    if df.empty:
        return df
    f = filter_values
    out = df.copy()

    if f.get("search"):
        haystack = (
            out["fund_code"].fillna("").str.casefold()
            + " "
            + out["fund_title"].fillna("").str.casefold()
        )
        out = out[haystack.str.contains(f["search"], regex=False)]

    if f.get("category"):
        out = out[out["category"].isin(f["category"])]
    if f.get("signal"):
        out = out[out["signal"].isin(f["signal"])]
    if f.get("money_flow"):
        out = out[out["money_flow_label"].isin(f["money_flow"])]
    if f.get("tags"):
        wanted = set(f["tags"])
        out = out[out["analytical_tag_list"].apply(
            lambda values: bool(wanted.intersection(values))
        )]

    out = out[out["final_score"].isna() | (out["final_score"] >= f.get("min_score", 0.0))]
    out = out[out["risk_score"].isna() | (out["risk_score"] <= f.get("max_risk", 100.0))]

    # Ondalık oranlar (örn. 0.05 = %5) ile karşılaştırırken, slider yüzde cinsinden.
    min_monthly = f.get("min_monthly_return", -100.0) / 100.0
    out = out[out["monthly_return"].isna() | (out["monthly_return"] >= min_monthly)]
    min_three = f.get("min_three_month_return", -100.0) / 100.0
    out = out[out["three_month_return"].isna() | (out["three_month_return"] >= min_three)]

    max_dd_pct = f.get("min_max_drawdown_neg", 100.0) / 100.0  # mutlak değer üst sınırı
    out = out[
        out["max_drawdown_90"].isna()
        | (out["max_drawdown_90"].abs() <= max_dd_pct)
    ]

    inflow_set = {"INFLOW", "STRONG_INFLOW"}
    outflow_set = {"OUTFLOW", "STRONG_OUTFLOW"}
    if f.get("only_inflow"):
        out = out[out["money_flow_label"].isin(inflow_set)]
    if f.get("only_outflow"):
        out = out[out["money_flow_label"].isin(outflow_set)]
    if f.get("only_overheated"):
        out = out[out["analytical_tag_list"].apply(lambda v: "OVERHEATED" in v)]
    if f.get("only_cooling"):
        out = out[out["analytical_tag_list"].apply(lambda v: "COOLING_MOMENTUM" in v)]
    if f.get("hide_unknown_category"):
        out = out[(out["category"] != "") & (out["category"] != "UNKNOWN")]
    if f.get("hide_unknown_money_flow"):
        out = out[(out["money_flow_label"] != "") & (out["money_flow_label"] != "UNKNOWN_FLOW")]

    return out


# ---------------------------------------------------------------------------
# KPI'lar
# ---------------------------------------------------------------------------

def _count_value(frame: pd.DataFrame, column: str, value: str) -> int:
    if column not in frame.columns:
        return 0
    return int((frame[column] == value).sum())


def _count_in_set(frame: pd.DataFrame, column: str, values: set[str]) -> int:
    if column not in frame.columns:
        return 0
    return int(frame[column].isin(values).sum())


def _count_tag(frame: pd.DataFrame, tag: str) -> int:
    if "analytical_tag_list" not in frame.columns:
        return 0
    return int(frame["analytical_tag_list"].apply(lambda tags: tag in tags).sum())


def _mean_score(frame: pd.DataFrame) -> str:
    if "final_score" not in frame.columns or frame["final_score"].dropna().empty:
        return "-"
    return f"{frame['final_score'].mean():.2f}"


def render_kpis(funds: pd.DataFrame) -> None:
    cols = st.columns(8)
    watch_count = _count_in_set(funds, "signal", {"Watch", "Strong Watch"})
    metrics = [
        ("Analiz Edilen Fon", str(len(funds))),
        ("Ortalama Skor", _mean_score(funds)),
        ("İzleme / Güçlü İzleme", str(watch_count)),
        ("Riskli Fon", str(_count_value(funds, "signal", "Risky"))),
        ("Güçlü Para Girişi", str(_count_value(funds, "money_flow_label", "STRONG_INFLOW"))),
        ("Güçlü Para Çıkışı", str(_count_value(funds, "money_flow_label", "STRONG_OUTFLOW"))),
        ("Aşırı Isınmış", str(_count_tag(funds, "OVERHEATED"))),
        ("Momentum Kaybı", str(_count_tag(funds, "COOLING_MOMENTUM"))),
    ]
    for column, (label, value) in zip(cols, metrics):
        column.metric(label, value)


# ---------------------------------------------------------------------------
# Tablo render + export
# ---------------------------------------------------------------------------

def render_main_table(funds: pd.DataFrame) -> pd.DataFrame:
    """Ana karşılaştırma tablosunu çiz ve görüntülenen tabloyu döndür."""
    sorted_df = funds.sort_values("final_score", ascending=False, na_position="last")
    display = build_display_table(sorted_df)
    st.dataframe(display, use_container_width=True, hide_index=True)
    return display


def to_excel_bytes(df: pd.DataFrame) -> bytes | None:
    """openpyxl varsa DataFrame'i .xlsx baytlarına çevir; yoksa None döner."""
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        return None
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Fonlar")
    return buffer.getvalue()


def render_export_buttons(display: pd.DataFrame) -> None:
    if display.empty:
        return
    csv_bytes = display.to_csv(index=False).encode("utf-8-sig")
    c1, c2 = st.columns(2)
    c1.download_button(
        "Filtrelenmiş tabloyu CSV indir",
        data=csv_bytes,
        file_name="tefas_filtreli_fonlar.csv",
        mime="text/csv",
        use_container_width=True,
    )
    excel_bytes = to_excel_bytes(display)
    if excel_bytes is not None:
        c2.download_button(
            "Filtrelenmiş tabloyu Excel indir",
            data=excel_bytes,
            file_name="tefas_filtreli_fonlar.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
        )
    else:
        c2.info("Excel dışa aktarımı için `openpyxl` paketi yüklü değil.")


# ---------------------------------------------------------------------------
# Grafikler (ikincil; tablonun altında)
# ---------------------------------------------------------------------------

def _value_counts_frame(frame: pd.DataFrame, column: str, label_mapping: dict[str, str] | None = None) -> pd.DataFrame:
    if column not in frame.columns:
        return pd.DataFrame(columns=["label", "count"])
    counts = frame[column].replace("", pd.NA).dropna().value_counts()
    if counts.empty:
        return pd.DataFrame(columns=["label", "count"])
    df = counts.rename_axis("value").reset_index(name="count")
    if label_mapping is not None:
        df["label"] = df["value"].map(lambda v: label_mapping.get(v, v))
    else:
        df["label"] = df["value"]
    return df[["label", "count"]]


def _tag_counts_frame(frame: pd.DataFrame) -> pd.DataFrame:
    if "analytical_tag_list" not in frame.columns:
        return pd.DataFrame(columns=["label", "count"])
    tags = [tag for values in frame["analytical_tag_list"] for tag in values]
    if not tags:
        return pd.DataFrame(columns=["label", "count"])
    series = pd.Series(tags).value_counts().rename_axis("value").reset_index(name="count")
    series["label"] = series["value"].map(lambda v: TAG_TR.get(v, v))
    return series[["label", "count"]]


def render_secondary_charts(funds: pd.DataFrame) -> None:
    st.markdown("### Grafikler")
    if funds.empty:
        st.info("Seçili filtrelere uyan fon bulunamadı.")
        return

    left, right = st.columns(2)
    if funds["final_score"].notna().any():
        top = funds.sort_values("final_score", ascending=False).head(10)
        fig = px.bar(
            top,
            x="final_score",
            y="fund_code",
            orientation="h",
            hover_data=["fund_title"],
            title="Skora göre ilk 10 fon",
        )
        fig.update_layout(yaxis={"categoryorder": "total ascending"})
        left.plotly_chart(fig, use_container_width=True)

    cat_counts = _value_counts_frame(funds, "category", CATEGORY_TR)
    if not cat_counts.empty:
        right.plotly_chart(
            px.bar(cat_counts, x="label", y="count", title="Kategori dağılımı"),
            use_container_width=True,
        )

    left, right = st.columns(2)
    sig_counts = _value_counts_frame(funds, "signal", SIGNAL_TR)
    if not sig_counts.empty:
        left.plotly_chart(
            px.bar(sig_counts, x="label", y="count", title="Sinyal dağılımı"),
            use_container_width=True,
        )

    if funds[["risk_score", "monthly_return"]].notna().any(axis=None):
        scatter_df = funds.copy()
        scatter_df["category_tr"] = scatter_df["category"].map(lambda v: CATEGORY_TR.get(v, v) if v else "-")
        right.plotly_chart(
            px.scatter(
                scatter_df,
                x="risk_score",
                y="monthly_return",
                color="category_tr",
                hover_name="fund_code",
                hover_data=["fund_title", "signal", "final_score"],
                title="Risk vs 1A Getiri",
                labels={"category_tr": "Kategori"},
            ),
            use_container_width=True,
        )

    left, right = st.columns(2)
    if funds["money_flow_score"].notna().any():
        flow = funds.sort_values("money_flow_score", ascending=False).head(10).copy()
        flow["money_flow_tr"] = flow["money_flow_label"].map(lambda v: MONEY_FLOW_TR.get(v, v))
        left.plotly_chart(
            px.bar(
                flow,
                x="money_flow_score",
                y="fund_code",
                color="money_flow_tr",
                orientation="h",
                title="Para akışı skoru ilk 10",
                labels={"money_flow_tr": "Para Akışı"},
            ),
            use_container_width=True,
        )

    tag_counts = _tag_counts_frame(funds)
    if not tag_counts.empty:
        right.plotly_chart(
            px.bar(tag_counts, x="label", y="count", title="Analitik etiket sayıları"),
            use_container_width=True,
        )


# ---------------------------------------------------------------------------
# Sekme içerikleri
# ---------------------------------------------------------------------------

def tab_comparison(funds: pd.DataFrame) -> None:
    filter_values = render_filter_panel(funds)
    filtered = apply_filters(funds, filter_values)
    st.markdown(f"**{len(filtered)} fon listeleniyor**")
    display = render_main_table(filtered)
    render_export_buttons(display)
    with st.expander("Grafikler (filtrelenmiş veri)", expanded=False):
        render_secondary_charts(filtered)


def tab_top_funds(funds: pd.DataFrame) -> None:
    st.markdown("### Skora göre ilk 10 fon")
    top10 = funds.sort_values("final_score", ascending=False, na_position="last").head(10)
    st.dataframe(build_display_table(top10), use_container_width=True, hide_index=True)

    st.markdown("### Kategori bazında en yüksek skorlu fonlar")
    if "category" in funds.columns and not funds["category"].dropna().empty:
        per_cat = (
            funds.dropna(subset=["final_score"])
            .sort_values("final_score", ascending=False)
            .groupby("category", group_keys=False)
            .head(3)
            .sort_values(["category", "final_score"], ascending=[True, False])
        )
        st.dataframe(build_display_table(per_cat), use_container_width=True, hide_index=True)
    else:
        st.info("Kategori bilgisi yok.")

    st.markdown("### Güçlü İzleme")
    sw = funds[funds["signal"] == "Strong Watch"].sort_values("final_score", ascending=False)
    if sw.empty:
        st.info("Güçlü İzleme sınıfında fon bulunmuyor.")
    else:
        st.dataframe(build_display_table(sw), use_container_width=True, hide_index=True)

    st.markdown("### İzleme")
    w = funds[funds["signal"] == "Watch"].sort_values("final_score", ascending=False)
    if w.empty:
        st.info("İzleme sınıfında fon bulunmuyor.")
    else:
        st.dataframe(build_display_table(w), use_container_width=True, hide_index=True)


def tab_money_flow(funds: pd.DataFrame) -> None:
    st.markdown("### Güçlü Para Girişi")
    inflow = funds[funds["money_flow_label"] == "STRONG_INFLOW"].sort_values(
        "money_flow_score", ascending=False
    )
    if inflow.empty:
        st.info("Güçlü Para Girişi etiketli fon bulunmuyor.")
    else:
        st.dataframe(build_display_table(inflow), use_container_width=True, hide_index=True)

    st.markdown("### Güçlü Para Çıkışı")
    outflow = funds[funds["money_flow_label"] == "STRONG_OUTFLOW"].sort_values(
        "money_flow_score", ascending=True
    )
    if outflow.empty:
        st.info("Güçlü Para Çıkışı etiketli fon bulunmuyor.")
    else:
        st.dataframe(build_display_table(outflow), use_container_width=True, hide_index=True)

    st.markdown("### Para akışı skoru ilk 10")
    if funds["money_flow_score"].notna().any():
        flow = funds.sort_values("money_flow_score", ascending=False).head(10).copy()
        flow["money_flow_tr"] = flow["money_flow_label"].map(lambda v: MONEY_FLOW_TR.get(v, v))
        st.plotly_chart(
            px.bar(
                flow,
                x="money_flow_score",
                y="fund_code",
                color="money_flow_tr",
                orientation="h",
                title="Para akışı skoru ilk 10",
                labels={"money_flow_tr": "Para Akışı"},
            ),
            use_container_width=True,
        )
    else:
        st.info("Para akışı skoru verisi yok.")


def tab_risk_tags(funds: pd.DataFrame) -> None:
    sections = [
        ("Riskli Fonlar", funds[funds["signal"] == "Risky"], "risk_score", False),
        (
            "Aşırı Isınmış Fonlar",
            funds[funds["analytical_tag_list"].apply(lambda v: "OVERHEATED" in v)],
            "final_score",
            False,
        ),
        (
            "Momentum Kaybı Olan Fonlar",
            funds[funds["analytical_tag_list"].apply(lambda v: "COOLING_MOMENTUM" in v)],
            "final_score",
            False,
        ),
        (
            "Yüksek Düşüş (HIGH_DRAWDOWN)",
            funds[funds["analytical_tag_list"].apply(lambda v: "HIGH_DRAWDOWN" in v)],
            "max_drawdown_90",
            True,  # düşüşler negatif olduğu için artan sıra en kötüleri üste alır
        ),
        (
            "Düşük Likidite (LOW_LIQUIDITY)",
            funds[funds["analytical_tag_list"].apply(lambda v: "LOW_LIQUIDITY" in v)],
            "fund_size_latest",
            True,
        ),
    ]
    for title, subset, sort_col, ascending in sections:
        st.markdown(f"### {title}")
        if subset.empty:
            st.info("Bu kriterde fon bulunmuyor.")
            continue
        if sort_col in subset.columns:
            subset = subset.sort_values(sort_col, ascending=ascending, na_position="last")
        st.dataframe(build_display_table(subset), use_container_width=True, hide_index=True)


def tab_fund_detail(
    funds: pd.DataFrame,
    prices: pd.DataFrame,
    latest_date: str | None,
) -> None:
    st.markdown("### Fon Detayı")
    if funds.empty:
        st.info("Detay görmek için en az bir fon seçin.")
        return

    options = funds.sort_values("fund_code")["fund_code"].tolist()
    label_lookup = {
        row.fund_code: f"{row.fund_code} - {row.fund_title}" if row.fund_title else row.fund_code
        for row in funds.itertuples()
    }
    selected = st.selectbox(
        "Fon seçin",
        options,
        format_func=lambda code: label_lookup.get(code, code),
    )
    selected_row = funds[funds["fund_code"] == selected].iloc[0]
    st.caption(f"Son analiz tarihi: {latest_date or '-'}")

    st.markdown("#### Fiyat Geçmişi")
    history = prices[prices["fund_code"] == selected].sort_values("date") if not prices.empty else pd.DataFrame()
    if not history.empty and history["price"].notna().any():
        st.plotly_chart(
            px.line(history, x="date", y="price", title=f"{selected} fiyat geçmişi"),
            use_container_width=True,
        )
    else:
        st.info("Seçili fon için fiyat geçmişi yok.")

    st.markdown("#### Son Metrikler")
    metric_pairs = [
        ("Fon Kodu", selected_row.get("fund_code", "")),
        ("Fon Adı", selected_row.get("fund_title", "")),
        ("Kategori", display_category(selected_row.get("category"))),
        ("Sinyal", display_signal(selected_row.get("signal"))),
        ("Skor", format_score(selected_row.get("final_score"))),
        ("Momentum", format_score(selected_row.get("momentum_score"))),
        ("Risk", format_score(selected_row.get("risk_score"))),
        ("Günlük Getiri", format_percent(selected_row.get("daily_return"))),
        ("Haftalık Getiri", format_percent(selected_row.get("weekly_return"))),
        ("1A Getiri", format_percent(selected_row.get("monthly_return"))),
        ("3A Getiri", format_percent(selected_row.get("three_month_return"))),
        ("30G Volatilite", format_percent(selected_row.get("volatility_30"))),
        ("90G Maksimum Düşüş", format_percent(selected_row.get("max_drawdown_90"))),
    ]
    metrics_df = pd.DataFrame(metric_pairs, columns=["Metrik", "Değer"])
    st.dataframe(metrics_df, use_container_width=True, hide_index=True)

    st.markdown("#### Para Akışı Detayları")
    flow_pairs = [
        ("Para Akışı", display_money_flow(selected_row.get("money_flow_label"))),
        ("Para Akışı Skoru", format_score(selected_row.get("money_flow_score"))),
        ("Fon Büyüklüğü (son)", format_score(selected_row.get("fund_size_latest"))),
        ("Yatırımcı Sayısı (son)", format_score(selected_row.get("investor_count_latest"))),
        ("Tahmini Net Akış (1G)", format_score(selected_row.get("estimated_net_flow_1d"))),
        ("Tahmini Net Akış (1H)", format_score(selected_row.get("estimated_net_flow_1w"))),
        ("Tahmini Net Akış (1A)", format_score(selected_row.get("estimated_net_flow_1m"))),
        ("Yatırımcı Değişimi (1H)", format_percent(selected_row.get("investor_count_change_1w"))),
        ("Yatırımcı Değişimi (1A)", format_percent(selected_row.get("investor_count_change_1m"))),
    ]
    flow_df = pd.DataFrame(flow_pairs, columns=["Metrik", "Değer"])
    st.dataframe(flow_df, use_container_width=True, hide_index=True)

    st.markdown("#### Analitik Etiketler")
    tags = selected_row.get("analytical_tag_list", []) or []
    if tags:
        st.write(", ".join(TAG_TR.get(tag, tag) for tag in tags))
    else:
        st.info("Bu fon için analitik etiket bulunmuyor.")


# ---------------------------------------------------------------------------
# Ana akış
# ---------------------------------------------------------------------------

def main() -> None:
    st.set_page_config(page_title="TEFAS Fon Analiz Paneli", layout="wide")
    st.title("TEFAS Fon Analiz Paneli")
    st.caption("Günlük fon performansı, risk, para akışı ve analitik etiketler")
    st.warning(RESEARCH_WARNING_TR)

    if st.sidebar.button("Verileri yenile"):
        st.cache_data.clear()

    db_path = _resolve_db_path()
    st.sidebar.caption(f"Veritabanı: `{db_path}`")

    if not db_path.exists():
        st.info(PIPELINE_HINT_TR)
        st.stop()

    data = load_dashboard_data(str(db_path))
    for warning in data["warnings"]:
        st.warning(warning)

    funds = data["funds"]
    prices = data["prices"]
    latest_date = data["latest_date"]
    if funds.empty:
        st.info(PIPELINE_HINT_TR)
        st.stop()

    # KPI kartları (üstte)
    render_kpis(funds)

    # Sekmeler
    tab1, tab2, tab3, tab4, tab5 = st.tabs(
        [
            "Fon Karşılaştırma",
            "En İyi Fonlar",
            "Para Akışı",
            "Risk & Etiketler",
            "Fon Detayı",
        ]
    )
    with tab1:
        tab_comparison(funds)
    with tab2:
        tab_top_funds(funds)
    with tab3:
        tab_money_flow(funds)
    with tab4:
        tab_risk_tags(funds)
    with tab5:
        tab_fund_detail(funds, prices, latest_date)


if __name__ == "__main__":
    main()
