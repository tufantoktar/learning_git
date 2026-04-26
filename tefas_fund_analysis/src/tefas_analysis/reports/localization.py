from __future__ import annotations

from typing import Any


SUPPORTED_LANGUAGES = {"tr", "en"}
DEFAULT_LANGUAGE = "tr"


_TRANSLATIONS: dict[str, dict[str, str]] = {
    "en": {
        "report_title": "TEFAS Daily Fund Analysis",
        "disclaimer": "This report is for analytical research only and is not financial advice.",
        "summary": "Summary",
        "category_summary": "Category Summary",
        "money_flow_summary": "Money Flow Summary",
        "analytical_tag_summary": "Analytical Tag Summary",
        "top_funds_by_score": "Top Funds By Score",
        "top_funds_by_category": "Top Funds By Category",
        "strong_inflow_funds": "Strong Inflow Funds",
        "strong_outflow_funds": "Strong Outflow Funds",
        "overheated_funds": "Overheated Funds",
        "cooling_momentum_funds": "Cooling Momentum Funds",
        "consistent_uptrend_funds": "Consistent Uptrend Funds",
        "high_drawdown_funds": "High Drawdown Funds",
        "low_liquidity_funds": "Low Liquidity Funds",
        "recovery_watch_funds": "Recovery Watch Funds",
        "risky_funds": "Risky Funds",
        "full_score_table": "Full Score Table",
        "fund_notes": "Fund Notes",
        "funds_analyzed": "Funds analyzed",
        "rank": "Rank",
        "fund_code": "Fund Code",
        "fund_title": "Fund Title",
        "category": "Category",
        "signal": "Signal",
        "score": "Score",
        "final_score": "Final Score",
        "momentum": "Momentum",
        "risk": "Risk",
        "risk_score": "Risk Score",
        "daily": "Daily",
        "weekly": "Weekly",
        "monthly": "Monthly",
        "one_month_return": "1M Return",
        "three_month_return": "3M Return",
        "volatility_30": "30D Volatility",
        "max_drawdown_90": "90D Max Drawdown",
        "money_flow_label": "Money Flow Label",
        "money_flow_score": "Money Flow Score",
        "estimated_net_flow_1w": "Estimated Net Flow 1W",
        "estimated_net_flow_1m": "Estimated Net Flow 1M",
        "investor_count_change_1m": "Investor Count Change 1M",
        "tags": "Tags",
        "analytical_tags": "Analytical Tags",
    },
    "tr": {
        "report_title": "TEFAS Günlük Fon Analiz Raporu",
        "disclaimer": "Bu rapor yalnızca analitik araştırma amaçlıdır; yatırım tavsiyesi değildir.",
        "summary": "Özet",
        "category_summary": "Kategori Özeti",
        "money_flow_summary": "Para Giriş / Çıkış Özeti",
        "analytical_tag_summary": "Analitik Etiket Özeti",
        "top_funds_by_score": "Skora Göre En İyi Fonlar",
        "top_funds_by_category": "Kategori Bazında En İyi Fonlar",
        "strong_inflow_funds": "Güçlü Para Girişi Olan Fonlar",
        "strong_outflow_funds": "Güçlü Para Çıkışı Olan Fonlar",
        "overheated_funds": "Aşırı Isınmış Fonlar",
        "cooling_momentum_funds": "Momentum Kaybı Gösteren Fonlar",
        "consistent_uptrend_funds": "İstikrarlı Yükseliş Gösteren Fonlar",
        "high_drawdown_funds": "Yüksek Düşüş Riski Olan Fonlar",
        "low_liquidity_funds": "Düşük Likiditeli Fonlar",
        "recovery_watch_funds": "Toparlanma İzleme Fonları",
        "risky_funds": "Riskli Fonlar",
        "full_score_table": "Detaylı Skor Tablosu",
        "fund_notes": "Fon Notları",
        "funds_analyzed": "Analiz Edilen Fon Sayısı",
        "rank": "Sıra",
        "fund_code": "Fon Kodu",
        "fund_title": "Fon Adı",
        "category": "Kategori",
        "signal": "Sinyal",
        "score": "Skor",
        "final_score": "Final Skor",
        "momentum": "Momentum",
        "risk": "Risk",
        "risk_score": "Risk Skoru",
        "daily": "Günlük",
        "weekly": "Haftalık",
        "monthly": "Aylık",
        "one_month_return": "1A Getiri",
        "three_month_return": "3A Getiri",
        "volatility_30": "30G Volatilite",
        "max_drawdown_90": "90G Maksimum Düşüş",
        "money_flow_label": "Para Akışı Etiketi",
        "money_flow_score": "Para Akışı Skoru",
        "estimated_net_flow_1w": "Tahmini Net Akış 1H",
        "estimated_net_flow_1m": "Tahmini Net Akış 1A",
        "investor_count_change_1m": "Yatırımcı Sayısı Değişimi 1A",
        "tags": "Etiketler",
        "analytical_tags": "Analitik Etiketler",
    },
}


_SIGNAL_LABELS: dict[str, dict[str, str]] = {
    "Strong Watch": {"en": "Strong Watch", "tr": "Güçlü İzleme"},
    "Watch": {"en": "Watch", "tr": "İzleme"},
    "Neutral": {"en": "Neutral", "tr": "Nötr"},
    "Risky": {"en": "Risky", "tr": "Riskli"},
    "Profit Taking Watch": {
        "en": "Profit Taking Watch",
        "tr": "Kâr Realizasyonu İzleme",
    },
}


_CATEGORY_LABELS: dict[str, dict[str, str]] = {
    "MONEY_MARKET": {"en": "Money Market", "tr": "Para Piyasası"},
    "EQUITY": {"en": "Equity", "tr": "Hisse Senedi"},
    "VARIABLE": {"en": "Variable", "tr": "Değişken"},
    "DEBT": {"en": "Debt", "tr": "Borçlanma Araçları"},
    "PRECIOUS_METALS": {"en": "Precious Metals", "tr": "Kıymetli Madenler"},
    "FOREIGN_EQUITY": {"en": "Foreign Equity", "tr": "Yabancı Hisse"},
    "PARTICIPATION": {"en": "Participation", "tr": "Katılım"},
    "FUND_BASKET": {"en": "Fund Basket", "tr": "Fon Sepeti"},
    "UNKNOWN": {"en": "Unknown", "tr": "Bilinmiyor"},
}


_MONEY_FLOW_LABELS: dict[str, dict[str, str]] = {
    "STRONG_INFLOW": {"en": "Strong Inflow", "tr": "Güçlü Para Girişi"},
    "INFLOW": {"en": "Inflow", "tr": "Para Girişi"},
    "NEUTRAL_FLOW": {"en": "Neutral Flow", "tr": "Nötr Para Akışı"},
    "OUTFLOW": {"en": "Outflow", "tr": "Para Çıkışı"},
    "STRONG_OUTFLOW": {"en": "Strong Outflow", "tr": "Güçlü Para Çıkışı"},
    "UNKNOWN_FLOW": {"en": "Unknown Flow", "tr": "Bilinmeyen Para Akışı"},
}


_ANALYTICAL_TAG_LABELS: dict[str, dict[str, str]] = {
    "OVERHEATED": {"en": "Overheated", "tr": "Aşırı Isınmış"},
    "COOLING_MOMENTUM": {"en": "Cooling Momentum", "tr": "Momentum Kaybı"},
    "CONSISTENT_UPTREND": {
        "en": "Consistent Uptrend",
        "tr": "İstikrarlı Yükseliş",
    },
    "HIGH_DRAWDOWN": {"en": "High Drawdown", "tr": "Yüksek Düşüş"},
    "LOW_LIQUIDITY": {"en": "Low Liquidity", "tr": "Düşük Likidite"},
    "RECOVERY_WATCH": {"en": "Recovery Watch", "tr": "Toparlanma İzleme"},
}


def normalize_language(language: str | None) -> str:
    normalized = (language or DEFAULT_LANGUAGE).strip().lower()
    if normalized not in SUPPORTED_LANGUAGES:
        raise ValueError(f"unsupported report language: {language}")
    return normalized


def t(key: str, language: str | None = None) -> str:
    lang = normalize_language(language)
    return _TRANSLATIONS[lang].get(key, _TRANSLATIONS["en"].get(key, key))


def display_category(category: Any, language: str | None = None) -> str:
    value = _enum_or_string(category) or "UNKNOWN"
    return _display(_CATEGORY_LABELS, value, language)


def display_signal(signal: Any, language: str | None = None) -> str:
    value = _enum_or_string(signal)
    return _display(_SIGNAL_LABELS, value, language)


def display_money_flow_label(label: Any, language: str | None = None) -> str:
    value = _enum_or_string(label) or "UNKNOWN_FLOW"
    return _display(_MONEY_FLOW_LABELS, value, language)


def display_analytical_tag(tag: Any, language: str | None = None) -> str:
    value = _enum_or_string(tag)
    return _display(_ANALYTICAL_TAG_LABELS, value, language)


def _display(labels: dict[str, dict[str, str]], value: str | None, language: str | None) -> str:
    if value is None:
        return ""
    lang = normalize_language(language)
    return labels.get(value, {}).get(lang, value)


def _enum_or_string(value: Any) -> str | None:
    if value is None:
        return None
    enum_value = getattr(value, "value", value)
    return str(enum_value)
