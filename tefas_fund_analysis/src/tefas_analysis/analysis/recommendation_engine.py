from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from tefas_analysis.config import RecommendationConfig
from tefas_analysis.schemas import (
    FundRecommendation,
    PerformanceMetrics,
    RiskMetrics,
    SignalClass,
)
from tefas_analysis.utils import clamp, pct


class RecommendationEngine:
    """Combines performance, momentum, and risk into analytical watch signals."""

    def __init__(self, config: Optional[RecommendationConfig] = None) -> None:
        self.config = config or RecommendationConfig()

    def score(
        self,
        performance: PerformanceMetrics,
        risk: RiskMetrics,
    ) -> FundRecommendation:
        if performance.fund_code != risk.fund_code or performance.as_of != risk.as_of:
            raise ValueError("performance and risk metrics must refer to the same fund/date")

        return_score = self._return_score(
            [
                (performance.weekly_return, 0.20),
                (performance.monthly_return, 0.35),
                (performance.three_month_return, 0.45),
            ]
        )
        stability_score = 100.0 - risk.risk_score
        final_score = clamp(
            (performance.momentum_score * 0.45)
            + (return_score * 0.25)
            + (stability_score * 0.30)
        )
        signal = self._classify(performance, risk, final_score)
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
    ) -> SignalClass:
        severe_risk = (
            risk.risk_score >= self.config.risky_threshold
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
        if overextended and risk.risk_score >= self.config.profit_taking_min_risk:
            return SignalClass.PROFIT_TAKING_WATCH
        if (
            final_score >= self.config.strong_watch_threshold
            and risk.risk_score <= self.config.strong_watch_max_risk
            and performance.momentum_score >= self.config.watch_threshold
        ):
            return SignalClass.STRONG_WATCH
        if final_score >= self.config.watch_threshold and risk.risk_score <= self.config.watch_max_risk:
            return SignalClass.WATCH
        if severe_risk:
            return SignalClass.RISKY
        return SignalClass.NEUTRAL

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
