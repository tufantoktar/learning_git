from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from tefas_analysis.analysis.category_engine import FundCategory
from tefas_analysis.config import RecommendationConfig
from tefas_analysis.schemas import (
    FundRecommendation,
    PerformanceMetrics,
    RiskMetrics,
    SignalClass,
)
from tefas_analysis.utils import clamp, pct


@dataclass(frozen=True)
class CategoryScoringProfile:
    momentum_weight: float
    return_weight: float
    stability_weight: float
    risk_multiplier: float
    return_weights: tuple[float, float, float]


GENERIC_PROFILE = CategoryScoringProfile(
    momentum_weight=0.45,
    return_weight=0.25,
    stability_weight=0.30,
    risk_multiplier=1.00,
    return_weights=(0.20, 0.35, 0.45),
)

CATEGORY_PROFILES: dict[FundCategory, CategoryScoringProfile] = {
    FundCategory.MONEY_MARKET: CategoryScoringProfile(
        momentum_weight=0.20,
        return_weight=0.20,
        stability_weight=0.60,
        risk_multiplier=1.40,
        return_weights=(0.20, 0.45, 0.35),
    ),
    FundCategory.EQUITY: CategoryScoringProfile(
        momentum_weight=0.50,
        return_weight=0.30,
        stability_weight=0.20,
        risk_multiplier=0.75,
        return_weights=(0.10, 0.35, 0.55),
    ),
    FundCategory.FOREIGN_EQUITY: CategoryScoringProfile(
        momentum_weight=0.52,
        return_weight=0.30,
        stability_weight=0.18,
        risk_multiplier=0.70,
        return_weights=(0.10, 0.35, 0.55),
    ),
    FundCategory.VARIABLE: CategoryScoringProfile(
        momentum_weight=0.40,
        return_weight=0.25,
        stability_weight=0.35,
        risk_multiplier=0.95,
        return_weights=(0.15, 0.40, 0.45),
    ),
    FundCategory.DEBT: CategoryScoringProfile(
        momentum_weight=0.25,
        return_weight=0.25,
        stability_weight=0.50,
        risk_multiplier=1.15,
        return_weights=(0.15, 0.45, 0.40),
    ),
    FundCategory.PRECIOUS_METALS: CategoryScoringProfile(
        momentum_weight=0.48,
        return_weight=0.25,
        stability_weight=0.27,
        risk_multiplier=0.75,
        return_weights=(0.10, 0.35, 0.55),
    ),
    FundCategory.PARTICIPATION: CategoryScoringProfile(
        momentum_weight=0.40,
        return_weight=0.25,
        stability_weight=0.35,
        risk_multiplier=1.00,
        return_weights=(0.15, 0.40, 0.45),
    ),
    FundCategory.FUND_BASKET: CategoryScoringProfile(
        momentum_weight=0.35,
        return_weight=0.25,
        stability_weight=0.40,
        risk_multiplier=1.05,
        return_weights=(0.15, 0.40, 0.45),
    ),
    FundCategory.UNKNOWN: GENERIC_PROFILE,
}


class RecommendationEngine:
    """Combines performance, momentum, and risk into analytical watch signals."""

    def __init__(self, config: Optional[RecommendationConfig] = None) -> None:
        self.config = config or RecommendationConfig()

    def score(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
        category: FundCategory | str | None = None,
        enable_category_scoring: bool = True,
    ) -> FundRecommendation:
        if performance.fund_code != risk.fund_code or performance.as_of != risk.as_of:
            raise ValueError("performance and risk metrics must refer to the same fund/date")

        fund_category = self._coerce_category(category)
        profile = self._profile(fund_category, enable_category_scoring)
        effective_risk_score = self._effective_risk_score(risk, profile)
        return_score = self._return_score(
            [
                (performance.weekly_return, profile.return_weights[0]),
                (performance.monthly_return, profile.return_weights[1]),
                (performance.three_month_return, profile.return_weights[2]),
            ]
        )
        stability_score = 100.0 - effective_risk_score
        final_score = clamp(
            (performance.momentum_score * profile.momentum_weight)
            + (return_score * profile.return_weight)
            + (stability_score * profile.stability_weight)
        )
        signal = self._classify(performance, risk, final_score, effective_risk_score)
        explanation = self._explain(signal, performance, risk)

        return FundRecommendation(
            fund_code=performance.fund_code,
            as_of=performance.as_of,
            final_score=round(final_score, 4),
            signal=signal,
            explanation=explanation,
            components={
                "momentum_score": round(performance.momentum_score, 4),
                "return_score": round(return_score, 4),
                "stability_score": round(stability_score, 4),
                "risk_score": round(risk.risk_score, 4),
                "effective_risk_score": round(effective_risk_score, 4),
                "category_scoring_enabled": 1.0 if enable_category_scoring else 0.0,
            },
        )

    @staticmethod
    def _return_score(weighted_returns: Sequence[Tuple[Optional[float], float]]) -> float:
        available = [
            (return_value * 100.0, weight)
            for return_value, weight in weighted_returns
            if return_value is not None
        ]
        if not available:
            return 50.0
        total_weight = sum(weight for _, weight in available)
        weighted_return_pct = sum(value * weight for value, weight in available) / total_weight
        return clamp(50.0 + (weighted_return_pct * 2.0))

    def _classify(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
        final_score: float,
        effective_risk_score: Optional[float] = None,
    ) -> SignalClass:
        risk_score = risk.risk_score if effective_risk_score is None else effective_risk_score
        severe_risk = (
            risk_score >= self.config.risky_threshold
            or risk.max_drawdown_90 <= self.config.risky_drawdown_threshold
        )
        overextended = (
            (performance.monthly_return is not None
             and performance.monthly_return >= self.config.profit_taking_monthly_return)
            or (performance.three_month_return is not None
                and performance.three_month_return >= self.config.profit_taking_three_month_return)
        )

        if severe_risk and performance.momentum_score < self.config.watch_threshold:
            return SignalClass.RISKY
        if overextended and risk_score >= self.config.profit_taking_min_risk:
            return SignalClass.PROFIT_TAKING_WATCH
        if (
            final_score >= self.config.strong_watch_threshold
            and risk_score <= self.config.strong_watch_max_risk
            and performance.momentum_score >= self.config.watch_threshold
        ):
            return SignalClass.STRONG_WATCH
        if final_score >= self.config.watch_threshold and risk_score <= self.config.watch_max_risk:
            return SignalClass.WATCH
        if severe_risk:
            return SignalClass.RISKY
        return SignalClass.NEUTRAL

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
    def _profile(
        category: FundCategory,
        enable_category_scoring: bool,
    ) -> CategoryScoringProfile:
        if not enable_category_scoring:
            return GENERIC_PROFILE
        return CATEGORY_PROFILES.get(category, GENERIC_PROFILE)

    @staticmethod
    def _effective_risk_score(
        risk: RiskMetrics,
        profile: CategoryScoringProfile,
    ) -> float:
        return clamp(risk.risk_score * profile.risk_multiplier)

    @staticmethod
    def _explain(
        signal: SignalClass,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
    ) -> str:
        fragments: List[str] = [
            f"{signal.value} signal",
            f"momentum {performance.momentum_score:.2f}",
            f"risk {risk.risk_score:.2f}",
            f"1M return {pct(performance.monthly_return)}",
            f"3M return {pct(performance.three_month_return)}",
            f"max drawdown {pct(risk.max_drawdown_90)}",
        ]
        if signal == SignalClass.RISKY:
            fragments.append("volatility or drawdown is elevated")
        elif signal == SignalClass.PROFIT_TAKING_WATCH:
            fragments.append("recent gains are strong enough to monitor for cooling momentum")
        elif signal in {SignalClass.STRONG_WATCH, SignalClass.WATCH}:
            fragments.append("historical trend and risk balance are constructive")
        else:
            fragments.append("signal mix is balanced or data is not decisive")
        return ". ".join(fragments) + "."
