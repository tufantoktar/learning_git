from __future__ import annotations

from datetime import date
from typing import Iterable, Optional, Sequence, Union

import pandas as pd

from tefas_analysis.config import AnalysisConfig
from tefas_analysis.schemas import FundPriceRecord, PerformanceMetrics
from tefas_analysis.utils import clamp


PriceInput = Union[pd.DataFrame, Iterable[FundPriceRecord]]


class PerformanceEngine:
    """Deterministic return, moving-average, and momentum calculations."""

    def __init__(self, config: Optional[AnalysisConfig] = None) -> None:
        self.config = config or AnalysisConfig()

    def calculate(
        self,
        fund_code: str,
        prices: PriceInput,
        as_of: Optional[date] = None,
    ) -> PerformanceMetrics:
        frame = self._coerce_prices(prices, as_of)
        if frame.empty:
            raise ValueError(f"no prices available for {fund_code}")

        latest = frame.iloc[-1]
        series = frame["price"].astype(float)
        daily_return = self._window_return(series, 1)
        weekly_return = self._window_return(series, self.config.weekly_window)
        monthly_return = self._window_return(series, self.config.monthly_window)
        three_month_return = self._window_return(series, self.config.three_month_window)

        ma7 = self._moving_average(series, 7)
        ma30 = self._moving_average(series, 30)
        ma90 = self._moving_average(series, 90)
        momentum_score = self._momentum_score(
            latest_price=float(latest["price"]),
            returns=[
                daily_return,
                weekly_return,
                monthly_return,
                three_month_return,
            ],
            moving_averages=[ma7, ma30, ma90],
        )

        return PerformanceMetrics(
            fund_code=fund_code.upper(),
            as_of=latest["date"],
            latest_price=float(latest["price"]),
            daily_return=daily_return,
            weekly_return=weekly_return,
            monthly_return=monthly_return,
            three_month_return=three_month_return,
            moving_average_7=ma7,
            moving_average_30=ma30,
            moving_average_90=ma90,
            momentum_score=round(momentum_score, 4),
        )

    @staticmethod
    def _coerce_prices(prices: PriceInput, as_of: Optional[date]) -> pd.DataFrame:
        if isinstance(prices, pd.DataFrame):
            frame = prices.copy()
        else:
            frame = pd.DataFrame(
                [
                    {"date": item.date, "price": item.price}
                    for item in prices
                ]
            )
        if "date" not in frame.columns or "price" not in frame.columns:
            raise ValueError("prices must include date and price columns")
        frame = frame[["date", "price"]].dropna()
        frame["date"] = pd.to_datetime(frame["date"]).dt.date
        frame["price"] = frame["price"].astype(float)
        frame = frame[frame["price"] > 0]
        if as_of is not None:
            frame = frame[frame["date"] <= as_of]
        return frame.sort_values("date").drop_duplicates("date", keep="last")

    @staticmethod
    def _window_return(series: pd.Series, window: int) -> Optional[float]:
        if len(series) <= window:
            return None
        previous = float(series.iloc[-window - 1])
        latest = float(series.iloc[-1])
        if previous <= 0:
            return None
        return (latest / previous) - 1.0

    @staticmethod
    def _moving_average(series: pd.Series, window: int) -> Optional[float]:
        if series.empty:
            return None
        effective_window = min(window, len(series))
        return float(series.tail(effective_window).mean())

    @staticmethod
    def _momentum_score(
        latest_price: float,
        returns: Sequence[Optional[float]],
        moving_averages: Sequence[Optional[float]],
    ) -> float:
        weights = [0.10, 0.20, 0.30, 0.40]
        weighted = [
            (return_value * 100.0, weight)
            for return_value, weight in zip(returns, weights)
            if return_value is not None
        ]
        if weighted:
            total_weight = sum(weight for _, weight in weighted)
            weighted_return_pct = sum(value * weight for value, weight in weighted) / total_weight
            return_component = 50.0 + (weighted_return_pct * 2.0)
        else:
            return_component = 50.0

        trend_adjustments = []
        for moving_average in moving_averages:
            if moving_average is None:
                continue
            trend_adjustments.append(5.0 if latest_price >= moving_average else -5.0)
        trend_component = sum(trend_adjustments) / len(trend_adjustments) if trend_adjustments else 0.0
        return clamp(return_component + trend_component)
