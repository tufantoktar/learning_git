from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Optional

import pandas as pd


TEFAS_DATE_PATTERN = re.compile(r"/Date\((?P<millis>-?\d+)\)/")


def clamp(value: float, lower: float = 0.0, upper: float = 100.0) -> float:
    if math.isnan(value):
        return lower
    return max(lower, min(upper, value))


def parse_tefas_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        return pd.to_datetime(value, unit="ms").date()
    if isinstance(value, str):
        match = TEFAS_DATE_PATTERN.search(value)
        if match:
            return pd.to_datetime(int(match.group("millis")), unit="ms").date()
        return pd.to_datetime(value, dayfirst=True).date()
    raise ValueError(f"unsupported TEFAS date value: {value!r}")


def parse_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if pd.isna(value):
            return None
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned == "":
            return None
        cleaned = cleaned.replace(" ", "")
        if "," in cleaned and "." in cleaned:
            cleaned = cleaned.replace(".", "").replace(",", ".")
        elif "," in cleaned:
            cleaned = cleaned.replace(",", ".")
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def pct(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.2f}%"


def score(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}"
