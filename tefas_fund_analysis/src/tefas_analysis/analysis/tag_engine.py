from __future__ import annotations

from typing import Optional

from tefas_analysis.analysis.category_engine import FundCategory
from tefas_analysis.config import AnalyticalTagConfig
from tefas_analysis.schemas import (
    AnalyticalTag,
    MoneyFlowMetrics,
    PerformanceMetrics,
    RiskMetrics,
)


class TagEngine:
    """Deterministic analytical tag classifier for derived TEFAS metrics."""

    CONSISTENT_RISK_THRESHOLDS: dict[FundCategory, float] = {
        FundCategory.MONEY_MARKET: 30.0,
        FundCategory.DEBT: 40.0,
        FundCategory.VARIABLE: 55.0,
        FundCategory.EQUITY: 70.0,
        FundCategory.FOREIGN_EQUITY: 75.0,
        FundCategory.PRECIOUS_METALS: 75.0,
        FundCategory.PARTICIPATION: 55.0,
        FundCategory.FUND_BASKET: 55.0,
        FundCategory.UNKNOWN: 60.0,
    }
    HIGH_DRAWDOWN_THRESHOLDS: dict[FundCategory, float] = {
        FundCategory.MONEY_MARKET: -0.02,
        FundCategory.DEBT: -0.06,
        FundCategory.VARIABLE: -0.12,
        FundCategory.EQUITY: -0.20,
        FundCategory.FOREIGN_EQUITY: -0.22,
        FundCategory.PRECIOUS_METALS: -0.22,
        FundCategory.PARTICIPATION: -0.12,
        FundCategory.FUND_BASKET: -0.12,
        FundCategory.UNKNOWN: -0.15,
    }
    RECOVERY_DRAWDOWN_THRESHOLDS: dict[FundCategory, float] = {
        FundCategory.MONEY_MARKET: -0.01,
        FundCategory.DEBT: -0.04,
        FundCategory.VARIABLE: -0.10,
        FundCategory.EQUITY: -0.15,
        FundCategory.FOREIGN_EQUITY: -0.18,
        FundCategory.PRECIOUS_METALS: -0.18,
        FundCategory.PARTICIPATION: -0.10,
        FundCategory.FUND_BASKET: -0.10,
        FundCategory.UNKNOWN: -0.12,
    }

    def __init__(self, config: Optional[AnalyticalTagConfig] = None) -> None:
        self.config = config or AnalyticalTagConfig()

    def calculate(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
        money_flow: Optional[MoneyFlowMetrics] = None,
        category: FundCategory | str | None = None,
        latest_fund_size: Optional[float] = None,
        latest_investor_count: Optional[float] = None,
    ) -> list[AnalyticalTag]:
        fund_category = self._coerce_category(category)
        fund_size = latest_fund_size
        investor_count = latest_investor_count
        if money_flow is not None:
            fund_size = money_flow.fund_size_latest if fund_size is None else fund_size
            investor_count = (
                money_flow.investor_count_latest
                if investor_count is None
                else investor_count
            )

        tags: list[AnalyticalTag] = []
        if self._is_overheated(performance, risk):
            tags.append(AnalyticalTag.OVERHEATED)
        if self._is_cooling_momentum(performance):
            tags.append(AnalyticalTag.COOLING_MOMENTUM)
        if self._is_consistent_uptrend(performance, risk, fund_category):
            tags.append(AnalyticalTag.CONSISTENT_UPTREND)
        if self._is_high_drawdown(risk, fund_category):
            tags.append(AnalyticalTag.HIGH_DRAWDOWN)
        if self._is_low_liquidity(fund_size, investor_count):
            tags.append(AnalyticalTag.LOW_LIQUIDITY)
        if self._is_recovery_watch(performance, risk, fund_category):
            tags.append(AnalyticalTag.RECOVERY_WATCH)
        return tags

    def _is_overheated(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
    ) -> bool:
        strong_return = (
            self._gte(performance.monthly_return, self.config.overheated_monthly_return)
            or self._gte(
                performance.three_month_return,
                self.config.overheated_three_month_return,
            )
        )
        elevated_risk = (
            risk.risk_score >= self.config.overheated_risk_score
            or self._gte(risk.volatility_30, self.config.overheated_volatility_30)
        )
        return (
            strong_return
            and performance.momentum_score >= self.config.overheated_momentum_score
            and elevated_risk
        )

    @staticmethod
    def _is_cooling_momentum(performance: PerformanceMetrics) -> bool:
        long_trend_positive = performance.three_month_return is not None and performance.three_month_return > 0
        monthly_still_positive = performance.monthly_return is not None and performance.monthly_return >= 0
        short_term_weak = (
            (performance.weekly_return is not None and performance.weekly_return < 0)
            or (performance.daily_return is not None and performance.daily_return < 0)
        )
        if not (long_trend_positive and monthly_still_positive and short_term_weak):
            return False
        if performance.moving_average_7 is None:
            return True
        return performance.latest_price < performance.moving_average_7

    def _is_consistent_uptrend(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
        category: FundCategory,
    ) -> bool:
        threshold = self.CONSISTENT_RISK_THRESHOLDS.get(category, self.CONSISTENT_RISK_THRESHOLDS[FundCategory.UNKNOWN])
        drawdown_threshold = self.HIGH_DRAWDOWN_THRESHOLDS.get(category, self.HIGH_DRAWDOWN_THRESHOLDS[FundCategory.UNKNOWN])
        return (
            self._gt(performance.weekly_return, 0.0)
            and self._gt(performance.monthly_return, 0.0)
            and self._gt(performance.three_month_return, 0.0)
            and performance.momentum_score >= 65.0
            and risk.risk_score <= threshold
            and risk.max_drawdown_90 > drawdown_threshold
        )

    def _is_high_drawdown(
        self,
        risk: RiskMetrics,
        category: FundCategory,
    ) -> bool:
        threshold = self.HIGH_DRAWDOWN_THRESHOLDS.get(category, self.HIGH_DRAWDOWN_THRESHOLDS[FundCategory.UNKNOWN])
        return risk.max_drawdown_90 <= threshold

    def _is_low_liquidity(
        self,
        latest_fund_size: Optional[float],
        latest_investor_count: Optional[float],
    ) -> bool:
        if latest_fund_size is None and latest_investor_count is None:
            return False
        return (
            (
                latest_fund_size is not None
                and latest_fund_size < self.config.min_fund_size_for_liquidity
            )
            or (
                latest_investor_count is not None
                and latest_investor_count < self.config.min_investor_count_for_liquidity
            )
        )

    def _is_recovery_watch(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
        category: FundCategory,
    ) -> bool:
        threshold = self.RECOVERY_DRAWDOWN_THRESHOLDS.get(category, self.RECOVERY_DRAWDOWN_THRESHOLDS[FundCategory.UNKNOWN])
        return (
            risk.max_drawdown_90 <= threshold
            and self._gt(performance.weekly_return, 0.0)
            and self._gt(performance.monthly_return, 0.0)
            and performance.momentum_score >= 55.0
            and risk.risk_score <= 80.0
        )

    @staticmethod
    def _coerce_category(category: FundCategory | str | None) -> FundCategory:
        if isinstance(category, FundCategory):
            return category
        if isinstance(category, str) and category:
            try:
                return FundCategory(category)
            except ValueError:
                return FundCategory.UNKNOWN
        return FundCategory.UNKNOWN

    @staticmethod
    def _gte(value: Optional[float], threshold: float) -> bool:
        return value is not None and value >= threshold

    @staticmethod
    def _gt(value: Optional[float], threshold: float) -> bool:
        return value is not None and value > threshold
