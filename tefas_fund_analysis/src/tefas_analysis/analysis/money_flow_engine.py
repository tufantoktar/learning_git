from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Iterable, Optional, Union

import pandas as pd

from tefas_analysis.schemas import FundPriceRecord, MoneyFlowLabel, MoneyFlowMetrics
from tefas_analysis.utils import clamp


MoneyFlowInput = Union[pd.DataFrame, Iterable[FundPriceRecord]]


@dataclass(frozen=True)
class _PeriodFlow:
    fund_size_change: Optional[float]
    estimated_net_flow: Optional[float]
    flow_ratio: Optional[float]


@dataclass(frozen=True)
class _InvestorTrend:
    change_1w: Optional[float]
    change_1m: Optional[float]
    trend_ratio: Optional[float]


class MoneyFlowEngine:
    """Deterministic approximation of TEFAS fund inflow/outflow from local fields."""

    FLOW_WINDOWS = {
        "1d": 1,
        "1w": 5,
        "1m": 21,
    }
    FLOW_WEIGHTS = {
        "1d": 0.15,
        "1w": 0.30,
        "1m": 0.40,
    }
    INVESTOR_TREND_WEIGHT = 0.15
    FLOW_RATIO_CAP = 0.10
    INVESTOR_RATIO_CAP = 0.10
    SCORE_SPAN = 50.0

    def calculate(
        self,
        fund_code: str,
        prices: MoneyFlowInput,
        as_of: Optional[date] = None,
    ) -> MoneyFlowMetrics:
        frame = self._coerce_prices(prices, as_of)
        if frame.empty:
            raise ValueError(f"no prices available for {fund_code}")

        latest = frame.iloc[-1]
        fund_size_latest = self._optional_float(latest.get("fund_size"))
        investor_count_latest = self._optional_float(latest.get("investor_count"))

        if fund_size_latest is None:
            return MoneyFlowMetrics(
                fund_code=fund_code.upper(),
                as_of=latest["date"],
                fund_size_latest=None,
                investor_count_latest=investor_count_latest,
                fund_size_change_1d=None,
                fund_size_change_1w=None,
                fund_size_change_1m=None,
                investor_count_change_1w=None,
                investor_count_change_1m=None,
                estimated_net_flow_1d=None,
                estimated_net_flow_1w=None,
                estimated_net_flow_1m=None,
                money_flow_score=50.0,
                money_flow_label=MoneyFlowLabel.UNKNOWN_FLOW,
            )

        flow_1d = self._period_flow(frame, self.FLOW_WINDOWS["1d"])
        flow_1w = self._period_flow(frame, self.FLOW_WINDOWS["1w"])
        flow_1m = self._period_flow(frame, self.FLOW_WINDOWS["1m"])
        investor_trend = self._investor_trend(frame)
        money_flow_score = self._money_flow_score(
            flow_1d=flow_1d.flow_ratio,
            flow_1w=flow_1w.flow_ratio,
            flow_1m=flow_1m.flow_ratio,
            investor_trend=investor_trend.trend_ratio,
        )

        return MoneyFlowMetrics(
            fund_code=fund_code.upper(),
            as_of=latest["date"],
            fund_size_latest=round(fund_size_latest, 4),
            investor_count_latest=self._round_optional(investor_count_latest),
            fund_size_change_1d=self._round_optional(flow_1d.fund_size_change),
            fund_size_change_1w=self._round_optional(flow_1w.fund_size_change),
            fund_size_change_1m=self._round_optional(flow_1m.fund_size_change),
            investor_count_change_1w=self._round_optional(investor_trend.change_1w),
            investor_count_change_1m=self._round_optional(investor_trend.change_1m),
            estimated_net_flow_1d=self._round_optional(flow_1d.estimated_net_flow),
            estimated_net_flow_1w=self._round_optional(flow_1w.estimated_net_flow),
            estimated_net_flow_1m=self._round_optional(flow_1m.estimated_net_flow),
            money_flow_score=round(money_flow_score, 4),
            money_flow_label=self._label(money_flow_score),
        )

    @classmethod
    def _coerce_prices(
        cls,
        prices: MoneyFlowInput,
        as_of: Optional[date],
    ) -> pd.DataFrame:
        if isinstance(prices, pd.DataFrame):
            frame = prices.copy()
        else:
            frame = pd.DataFrame(
                [
                    {
                        "date": item.date,
                        "price": item.price,
                        "shares": item.shares,
                        "fund_size": item.fund_size,
                        "investor_count": item.investor_count,
                    }
                    for item in prices
                ]
            )
        if "date" not in frame.columns or "price" not in frame.columns:
            raise ValueError("prices must include date and price columns")
        for column in ["shares", "fund_size", "investor_count"]:
            if column not in frame.columns:
                frame[column] = None
        frame = frame[["date", "price", "shares", "fund_size", "investor_count"]].copy()
        frame["date"] = pd.to_datetime(frame["date"]).dt.date
        frame["price"] = pd.to_numeric(frame["price"], errors="coerce")
        frame["shares"] = pd.to_numeric(frame["shares"], errors="coerce")
        frame["fund_size"] = pd.to_numeric(frame["fund_size"], errors="coerce")
        frame["investor_count"] = pd.to_numeric(frame["investor_count"], errors="coerce")
        frame = frame.dropna(subset=["date", "price"])
        frame = frame[frame["price"] > 0]
        if as_of is not None:
            frame = frame[frame["date"] <= as_of]
        return frame.sort_values("date").drop_duplicates("date", keep="last")

    @classmethod
    def _period_flow(cls, frame: pd.DataFrame, window: int) -> _PeriodFlow:
        if len(frame) <= window:
            return _PeriodFlow(None, None, None)
        latest = frame.iloc[-1]
        previous = frame.iloc[-window - 1]
        latest_fund_size = cls._optional_float(latest.get("fund_size"))
        previous_fund_size = cls._optional_float(previous.get("fund_size"))
        latest_price = cls._optional_float(latest.get("price"))
        previous_price = cls._optional_float(previous.get("price"))

        fund_size_change = None
        if latest_fund_size is not None and previous_fund_size is not None:
            fund_size_change = latest_fund_size - previous_fund_size

        if (
            latest_fund_size is None
            or previous_fund_size is None
            or latest_price is None
            or previous_price is None
            or previous_price <= 0
            or previous_fund_size <= 0
        ):
            return _PeriodFlow(fund_size_change, None, None)

        fund_return = (latest_price / previous_price) - 1.0
        expected_size_change_due_to_price = previous_fund_size * fund_return
        estimated_net_flow = latest_fund_size - previous_fund_size - expected_size_change_due_to_price
        flow_ratio = estimated_net_flow / previous_fund_size
        return _PeriodFlow(fund_size_change, estimated_net_flow, flow_ratio)

    @classmethod
    def _investor_trend(cls, frame: pd.DataFrame) -> _InvestorTrend:
        change_1w, ratio_1w = cls._investor_change(frame, cls.FLOW_WINDOWS["1w"])
        change_1m, ratio_1m = cls._investor_change(frame, cls.FLOW_WINDOWS["1m"])
        trend_ratio = ratio_1m if ratio_1m is not None else ratio_1w
        return _InvestorTrend(change_1w, change_1m, trend_ratio)

    @classmethod
    def _investor_change(
        cls,
        frame: pd.DataFrame,
        window: int,
    ) -> tuple[Optional[float], Optional[float]]:
        if len(frame) <= window:
            return None, None
        latest = cls._optional_float(frame.iloc[-1].get("investor_count"))
        previous = cls._optional_float(frame.iloc[-window - 1].get("investor_count"))
        if latest is None or previous is None:
            return None, None
        change = latest - previous
        ratio = change / previous if previous > 0 else None
        return change, ratio

    @classmethod
    def _money_flow_score(
        cls,
        flow_1d: Optional[float],
        flow_1w: Optional[float],
        flow_1m: Optional[float],
        investor_trend: Optional[float],
    ) -> float:
        score_value = 50.0
        for key, ratio in [("1d", flow_1d), ("1w", flow_1w), ("1m", flow_1m)]:
            if ratio is None:
                continue
            normalized = clamp(ratio / cls.FLOW_RATIO_CAP, -1.0, 1.0)
            score_value += normalized * cls.SCORE_SPAN * cls.FLOW_WEIGHTS[key]
        if investor_trend is not None:
            normalized = clamp(investor_trend / cls.INVESTOR_RATIO_CAP, -1.0, 1.0)
            score_value += normalized * cls.SCORE_SPAN * cls.INVESTOR_TREND_WEIGHT
        return clamp(score_value)

    @staticmethod
    def _label(score_value: float) -> MoneyFlowLabel:
        if score_value >= 75.0:
            return MoneyFlowLabel.STRONG_INFLOW
        if score_value >= 60.0:
            return MoneyFlowLabel.INFLOW
        if 40.0 < score_value < 60.0:
            return MoneyFlowLabel.NEUTRAL_FLOW
        if score_value <= 25.0:
            return MoneyFlowLabel.STRONG_OUTFLOW
        return MoneyFlowLabel.OUTFLOW

    @staticmethod
    def _optional_float(value: object) -> Optional[float]:
        if value is None or pd.isna(value):
            return None
        return float(value)

    @staticmethod
    def _round_optional(value: Optional[float]) -> Optional[float]:
        if value is None:
            return None
        return round(value, 4)
