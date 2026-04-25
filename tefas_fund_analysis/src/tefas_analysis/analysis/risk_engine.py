from __future__ import annotations

import math
from datetime import date
from typing import Iterable, Optional, Union

import pandas as pd

from tefas_analysis.config import AnalysisConfig
from tefas_analysis.schemas import FundPriceRecord, RiskMetrics
from tefas_analysis.utils import clamp


PriceInput = Union[pd.DataFrame, Iterable[FundPriceRecord]]


class RiskEngine:
    """Deterministic volatility, drawdown, and risk scoring."""

    def __init__(self, config: Optional[AnalysisConfig] = None) -> None:
        self.config = config or AnalysisConfig()

    def calculate(
        self,
        fund_code: str,
        prices: PriceInput,
        as_of: Optional[date] = None,
    ) -> RiskMetrics:
        frame = self._coerce_prices(prices, as_of)
        if frame.empty:
            raise ValueError(f"no prices available for {fund_code}")

        returns = frame["price"].astype(float).pct_change().dropna()
        volatility_30 = self._annualized_volatility(returns, 30)
        volatility_90 = self._annualized_volatility(returns, 90)
        max_drawdown_90 = self._max_drawdown(frame["price"].tail(90))
        risk_score = self._risk_score(volatility_30, volatility_90, max_drawdown_90)

        return RiskMetrics(
            fund_code=fund_code.upper(),
            as_of=frame.iloc[-1]["date"],
            volatility_30=volatility_30,
            volatility_90=volatility_90,
            max_drawdown_90=round(max_drawdown_90, 6),
            risk_score=round(risk_score, 4),
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

    def _annualized_volatility(
        self,
        returns: pd.Series,
        window: int,
    ) -> Optional[float]:
        sample = returns.tail(window)
        if len(sample) < 2:
            return None
        volatility = float(sample.std(ddof=0) * math.sqrt(self.config.trading_days_per_year))
        return round(volatility, 6)

    @staticmethod
    def _max_drawdown(prices: pd.Series) -> float:
        if prices.empty:
            return 0.0
        running_max = prices.astype(float).cummax()
        drawdowns = (prices.astype(float) / running_max) - 1.0
        return float(drawdowns.min())

    def _risk_score(
        self,
        volatility_30: Optional[float],
        volatility_90: Optional[float],
        max_drawdown: float,
    ) -> float:
        volatility = volatility_30 if volatility_30 is not None else volatility_90
        volatility_component = 0.0
        if volatility is not None:
            volatility_component = clamp(
                volatility / self.config.risk_volatility_cap,
                0.0,
                1.0,
            )

        drawdown_component = clamp(
            abs(max_drawdown) / self.config.risk_drawdown_cap,
            0.0,
            1.0,
        )
        return clamp((volatility_component * 60.0) + (drawdown_component * 40.0))
